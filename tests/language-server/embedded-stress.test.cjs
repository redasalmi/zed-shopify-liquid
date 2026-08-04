'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  completionItems,
  createTheme,
  embeddedClient,
  positionAt,
} = require('./protocol-harness.cjs');

const STRESS_ITERATIONS = 300;
const DEFAULT_RSS_LIMIT_MIB = 384;
const DEFAULT_RSS_GROWTH_LIMIT_MIB = 128;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function residentSetMiB(pid) {
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const kibibytes = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
      return Number.isFinite(kibibytes) ? kibibytes / 1024 : null;
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
      const kibibytes = Number(result.stdout.trim());
      return result.status === 0 && Number.isFinite(kibibytes) ? kibibytes / 1024 : null;
    }
  } catch (_error) {
    // Request and stale-state checks still run on hosts without RSS reporting.
  }
  return null;
}

function stressSource(index, missingName = '') {
  return `{% javascript %}
const value${index}=${index};
document.querySelector('main');
value${index};
${missingName}
{% endjavascript %}
`;
}

function diagnosticMessages(params) {
  return params.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
}

test('embedded server remains bounded and discards stale document state', { timeout: 120_000 }, async (t) => {
  const initialSource = `{% javascript %}
const removedSymbol=1;
removedSymbol;
missingBefore;
{% endjavascript %}
`;
  const changedSource = `{% javascript %}
const currentSymbol=2;
currentSymbol;
removedSymbol;
missingAfter;
{% endjavascript %}
`;
  const plainSource = '<div>JavaScript removed</div>\n';
  const theme = await createTheme({ 'sections/stress.liquid': initialSource });
  const client = embeddedClient(theme.root);
  let version = 1;

  try {
    await client.initialize({
      textDocument: {
        completion: { completionItem: { snippetSupport: true } },
        definition: {},
        hover: { contentFormat: ['markdown'] },
        publishDiagnostics: {},
      },
    });
    const idleRss = residentSetMiB(client.process.pid);
    const uri = client.open(theme.file('sections/stress.liquid'), initialSource, version);

    const initialDiagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && /missingBefore/.test(diagnosticMessages(params)),
    );
    assert.match(diagnosticMessages(initialDiagnostics), /missingBefore/);

    version += 1;
    client.change(uri, changedSource, version);
    const changedDiagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => {
        const messages = diagnosticMessages(params);
        return params.uri === uri && /missingAfter/.test(messages) && /removedSymbol/.test(messages);
      },
    );
    const changedMessages = diagnosticMessages(changedDiagnostics);
    assert.doesNotMatch(changedMessages, /missingBefore/);

    const currentUse = changedSource.indexOf(
      'currentSymbol',
      changedSource.indexOf('currentSymbol') + 1,
    );
    const currentDefinition = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: positionAt(changedSource, currentUse + 2),
    });
    assert.deepEqual(
      currentDefinition[0].range.start,
      positionAt(changedSource, changedSource.indexOf('currentSymbol')),
    );

    const removedUse = changedSource.indexOf('removedSymbol');
    assert.equal(
      await client.request('textDocument/definition', {
        textDocument: { uri },
        position: positionAt(changedSource, removedUse + 2),
      }),
      null,
      'a removed declaration must not survive in the incremental program',
    );

    version += 1;
    client.change(uri, plainSource, version);
    await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
    assert.equal(
      await client.request('textDocument/completion', {
        textDocument: { uri },
        position: positionAt(plainSource, plainSource.indexOf('JavaScript')),
        context: { triggerKind: 1 },
      }),
      null,
    );
    assert.equal(
      await client.request('textDocument/hover', {
        textDocument: { uri },
        position: positionAt(plainSource, plainSource.indexOf('JavaScript')),
      }),
      null,
    );

    const warmSource = stressSource(-1);
    version += 1;
    client.change(uri, warmSource, version);
    const warmCompletionOffset = warmSource.indexOf('document.') + 'document.'.length;
    const warmCompletion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(warmSource, warmCompletionOffset),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(warmCompletion).some((item) => item.label === 'querySelector'));
    await delay(50);
    const warmRss = residentSetMiB(client.process.pid);

    let maximumRss = warmRss;
    const startedAt = performance.now();
    for (let index = 0; index < STRESS_ITERATIONS; index += 1) {
      const source = stressSource(index);
      version += 1;
      client.change(uri, source, version);
      const completionOffset = source.indexOf('document.') + 'document.'.length;
      const completion = await client.request('textDocument/completion', {
        textDocument: { uri },
        position: positionAt(source, completionOffset),
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      assert(completionItems(completion).some((item) => item.label === 'querySelector'));

      if (index % 50 === 0) {
        const valueUse = source.indexOf(`value${index}`, source.indexOf(`value${index}`) + 1);
        const definition = await client.request('textDocument/definition', {
          textDocument: { uri },
          position: positionAt(source, valueUse + 2),
        });
        assert.deepEqual(
          definition[0].range.start,
          positionAt(source, source.indexOf(`value${index}`)),
        );
        const sample = residentSetMiB(client.process.pid);
        if (sample !== null) maximumRss = Math.max(maximumRss ?? sample, sample);
      }
    }
    const elapsedMilliseconds = performance.now() - startedAt;

    const finalSource = stressSource(STRESS_ITERATIONS, 'finalMissingName;');
    version += 1;
    client.change(uri, finalSource, version);
    const finalDiagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && /finalMissingName/.test(diagnosticMessages(params)),
    );
    const finalMessages = diagnosticMessages(finalDiagnostics);
    assert.doesNotMatch(finalMessages, /missingBefore|missingAfter|removedSymbol/);

    await delay(50);
    const finalRss = residentSetMiB(client.process.pid);
    if (finalRss !== null) maximumRss = Math.max(maximumRss ?? finalRss, finalRss);
    if (warmRss !== null && finalRss !== null && maximumRss !== null) {
      const rssLimit = Number(process.env.LIQUID_STRESS_RSS_LIMIT_MIB || DEFAULT_RSS_LIMIT_MIB);
      const growthLimit = Number(
        process.env.LIQUID_STRESS_RSS_GROWTH_LIMIT_MIB || DEFAULT_RSS_GROWTH_LIMIT_MIB,
      );
      assert(maximumRss <= rssLimit, `embedded server RSS reached ${maximumRss.toFixed(1)} MiB`);
      assert(
        finalRss - warmRss <= growthLimit,
        `embedded server RSS grew ${(finalRss - warmRss).toFixed(1)} MiB after warm-up`,
      );
      t.diagnostic(
        `RSS idle=${idleRss?.toFixed(1) ?? 'n/a'} MiB warm=${warmRss.toFixed(1)} MiB ` +
          `max=${maximumRss.toFixed(1)} MiB final=${finalRss.toFixed(1)} MiB`,
      );
    } else {
      t.diagnostic('RSS assertions skipped: this platform does not expose child-process RSS');
    }
    t.diagnostic(
      `${STRESS_ITERATIONS} incremental completion cycles averaged ${(
        elapsedMilliseconds / STRESS_ITERATIONS
      ).toFixed(2)} ms`,
    );

    client.close(uri);
    await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
    assert.equal(
      await client.request('textDocument/hover', {
        textDocument: { uri },
        position: { line: 1, character: 2 },
      }),
      null,
      'closed documents must be removed from server state',
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
