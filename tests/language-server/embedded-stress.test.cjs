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
const DEFAULT_RESTART_GROWTH_LIMIT_MIB = 96;
const PLAIN_LIQUID_ITERATIONS = 150;
const PLAIN_LIQUID_RSS_GROWTH_LIMIT_MIB = 32;
const LARGE_DOCUMENT_COUNT = 12;
const LARGE_DOCUMENT_SIZE = 256 * 1024;

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

test('plain Liquid updates keep embedded services unloaded', async (t) => {
  const body = 'x'.repeat(64 * 1024);
  const initialSource = `<div>${body} 0</div>\n`;
  const theme = await createTheme({ 'sections/plain.liquid': initialSource });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({ textDocument: { completion: {} } });
    const initialRss = residentSetMiB(client.process.pid);
    const uri = client.open(theme.file('sections/plain.liquid'), initialSource);
    const startedAt = performance.now();
    for (let version = 1; version <= PLAIN_LIQUID_ITERATIONS; version += 1) {
      const source = `<div>${body} ${version}</div>\n`;
      client.change(uri, source, version + 1);
      assert.equal(
        await client.request('textDocument/completion', {
          textDocument: { uri },
          position: positionAt(source, source.length - 1),
          context: { triggerKind: 1 },
        }),
        null,
      );
    }
    const elapsedMilliseconds = performance.now() - startedAt;
    await delay(50);
    const finalRss = residentSetMiB(client.process.pid);
    if (initialRss !== null && finalRss !== null) {
      assert(
        finalRss - initialRss <= PLAIN_LIQUID_RSS_GROWTH_LIMIT_MIB,
        `plain Liquid updates grew RSS by ${(finalRss - initialRss).toFixed(1)} MiB`,
      );
      t.diagnostic(
        `plain Liquid RSS initial=${initialRss.toFixed(1)} MiB final=${finalRss.toFixed(1)} MiB`,
      );
    }
    t.diagnostic(
      `${PLAIN_LIQUID_ITERATIONS} 64 KiB updates averaged ${(
        elapsedMilliseconds / PLAIN_LIQUID_ITERATIONS
      ).toFixed(2)} ms`,
    );

    client.close(uri);
    await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('multiple large embedded documents remain within the process budget', { timeout: 60_000 }, async (t) => {
  const files = {};
  const sources = [];
  for (let index = 0; index < LARGE_DOCUMENT_COUNT; index += 1) {
    const padding = 'x'.repeat(LARGE_DOCUMENT_SIZE);
    const source = `<div>${padding}</div>\n{% javascript %}\nconst value${index}=${index};\ndocument.querySelector('main');\nvalue${index};\n{% endjavascript %}\n`;
    files[`sections/large-${index}.liquid`] = source;
    sources.push(source);
  }
  const theme = await createTheme(files);
  const client = embeddedClient(theme.root);
  const uris = [];

  try {
    await client.initialize({
      textDocument: { completion: {}, definition: {}, publishDiagnostics: {} },
    });
    for (let index = 0; index < LARGE_DOCUMENT_COUNT; index += 1) {
      uris.push(client.open(theme.file(`sections/large-${index}.liquid`), sources[index]));
    }

    for (let index = 0; index < LARGE_DOCUMENT_COUNT; index += 1) {
      const source = sources[index];
      const completionOffset = source.indexOf('document.') + 'document.'.length;
      const completion = await client.request('textDocument/completion', {
        textDocument: { uri: uris[index] },
        position: positionAt(source, completionOffset),
        context: { triggerKind: 2, triggerCharacter: '.' },
      });
      assert(completionItems(completion).some((item) => item.label === 'querySelector'));
    }

    await delay(100);
    const rss = residentSetMiB(client.process.pid);
    if (rss !== null) {
      const rssLimit = Number(process.env.LIQUID_STRESS_RSS_LIMIT_MIB || DEFAULT_RSS_LIMIT_MIB);
      assert(rss <= rssLimit, `multi-document RSS reached ${rss.toFixed(1)} MiB`);
      t.diagnostic(
        `${LARGE_DOCUMENT_COUNT} × ${LARGE_DOCUMENT_SIZE / 1024} KiB documents used ${rss.toFixed(1)} MiB RSS`,
      );
    }

    for (const uri of uris) client.close(uri);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

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

test('TypeScript analysis is released when JavaScript becomes idle', async (t) => {
  const source = stressSource(1);
  const theme = await createTheme({ 'sections/lifecycle.liquid': source });
  const client = embeddedClient(theme.root, {
    env: {
      LIQUID_PERFORMANCE_LOGGING: '1',
      LIQUID_TYPESCRIPT_IDLE_MS: '25',
    },
  });

  try {
    await client.initialize({
      textDocument: {
        completion: { completionItem: { snippetSupport: true } },
        publishDiagnostics: {},
      },
    });
    const uri = client.open(theme.file('sections/lifecycle.liquid'), source);
    const completionOffset = source.indexOf('document.') + 'document.'.length;
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, completionOffset),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(completion).some((item) => item.label === 'querySelector'));
    await delay(50);
    const firstWarmRss = residentSetMiB(client.process.pid);

    client.close(uri);
    await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri && params.diagnostics.length === 0,
    );
    await client.waitForNotification(
      'window/logMessage',
      (params) => params.message === 'TypeScript language service disposed',
    );

    const reopenedUri = client.open(theme.file('sections/lifecycle.liquid'), source);
    const reopenedCompletion = await client.request('textDocument/completion', {
      textDocument: { uri: reopenedUri },
      position: positionAt(source, completionOffset),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(reopenedCompletion).some((item) => item.label === 'querySelector'));
    await delay(50);
    const restartRss = residentSetMiB(client.process.pid);

    if (firstWarmRss !== null && restartRss !== null) {
      const rssLimit = Number(process.env.LIQUID_STRESS_RSS_LIMIT_MIB || DEFAULT_RSS_LIMIT_MIB);
      const growthLimit = Number(
        process.env.LIQUID_STRESS_RESTART_GROWTH_LIMIT_MIB ||
          DEFAULT_RESTART_GROWTH_LIMIT_MIB,
      );
      assert(restartRss <= rssLimit, `restarted service RSS reached ${restartRss.toFixed(1)} MiB`);
      assert(
        restartRss - firstWarmRss <= growthLimit,
        `restarting TypeScript added ${(restartRss - firstWarmRss).toFixed(1)} MiB`,
      );
      t.diagnostic(
        `RSS first warm=${firstWarmRss.toFixed(1)} MiB restart=${restartRss.toFixed(1)} MiB`,
      );
    }

    client.close(reopenedUri);
    await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === reopenedUri && params.diagnostics.length === 0,
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
