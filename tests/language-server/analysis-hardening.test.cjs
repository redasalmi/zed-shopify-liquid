'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { analyzeLiquidDocument, reusableAnalysis } = require('../../language-server/liquid-document-analysis.cjs');
const { embeddedJavaScript, embeddedStylesheet, embeddedSource, updateEmbeddedSource } = require('../../language-server/embedded-language.cjs');
const { createTheme, embeddedClient, positionAt, completionItems } = require('./protocol-harness.cjs');

function changeAt(source, start, end, text) {
  const previousDocument = TextDocument.create('file:///theme/sections/test.liquid', 'liquid', 1, source);
  return {
    previousDocument,
    changes: [{ range: { start: previousDocument.positionAt(start), end: previousDocument.positionAt(end) }, text }],
  };
}

function comparable(analysis) {
  return [analysis.rawTags, analysis.liquidExpressionRanges, analysis.settingReferences];
}

test('unparsed Liquid keyword repairs invalidate empty analysis', () => {
  for (const tag of ['javascript', 'stylesheet', 'schema', 'doc', 'comment', 'raw']) {
    const source = `{% ${tag.slice(0, -1)} %}body{% end${tag} %}`;
    const offset = 3 + tag.length - 1;
    assert.equal(reusableAnalysis(analyzeLiquidDocument(source),
      changeAt(source, offset, offset, tag.at(-1))), null);
  }
});

test('raw-body reuse and virtual splicing agree with clean analysis', () => {
  for (const tagName of ['javascript', 'stylesheet']) {
    const source = `<p>🛍️ Crème</p>\r\n{% ${tagName} %}\r\nconst value = 1;\r\n{% end${tagName} %}\r\n{{ block.settings.heading }}\n{% schema %}{"settings":[]}{% endschema %}`;
    const start = source.indexOf('value');
    for (const text of ['other', '🛍️\r\nname', '{ a: 1 }', '', 'value % 2']) {
      const updated = source.slice(0, start) + text + source.slice(start + 5);
      const before = analyzeLiquidDocument(source);
      const reuse = reusableAnalysis(before, changeAt(source, start, start + 5, text));
      assert(reuse?.rawBodyChange, `expected ${tagName} body reuse for ${JSON.stringify(text)}`);
      const clean = analyzeLiquidDocument(updated);
      assert.deepEqual(comparable(reuse.analysis), comparable(clean));
      const language = tagName === 'javascript' ? embeddedJavaScript : embeddedStylesheet;
      const previousEmbedded = language(source, before.rawTags);
      embeddedSource(previousEmbedded);
      const nextEmbedded = language(updated, reuse.analysis.rawTags);
      updateEmbeddedSource(previousEmbedded, nextEmbedded, reuse.rawBodyChange);
      assert.equal(nextEmbedded.source, embeddedSource(language(updated, clean.rawTags)));
    }
  }
});

test('raw-body reuse rejects assembled and repaired Liquid delimiters', () => {
  for (const [body, needle, text] of [
    ['before { after', ' after', '% endjavascript %}'],
    ['before % after', 'before ', '{'],
    ['{% endjavascripx %}', 'x', 't'],
  ]) {
    const source = `{% javascript %}${body}{% endjavascript %}`;
    const start = source.indexOf(needle, 16);
    const change = changeAt(source, start, start + needle.length, text);
    assert.equal(reusableAnalysis(analyzeLiquidDocument(source), change), null);
  }
});

test('keyword repair activates JavaScript without reopening and open analysis runs once', async () => {
  const source = '{% javascrip %}\nconst value = 1;\ndocument.querySelector("main");\n{% endjavascript %}';
  const theme = await createTheme({ 'sections/repair.liquid': source });
  const client = embeddedClient(theme.root, { env: { LIQUID_PERFORMANCE_LOGGING: '1' } });
  try {
    await client.initialize({ textDocument: { completion: {} } });
    const uri = client.open(theme.file('sections/repair.liquid'), source);
    await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 0 } });
    const analysisLogs = client.notifications.filter((message) =>
      message.method === 'window/logMessage' && message.params.message.startsWith('Liquid analysis'));
    assert.equal(analysisLogs.length, 1);
    const at = source.indexOf('javascrip') + 9;
    const updated = source.slice(0, at) + 't' + source.slice(at);
    client.changeIncrementally(uri, changeAt(source, at, at, 't').changes, 2);
    const result = await client.request('textDocument/completion', {
      textDocument: { uri }, position: positionAt(updated, updated.indexOf('document.') + 9),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(result).some((item) => item.label === 'querySelector'));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('dense oversized documents are limited before every parser-backed provider', { timeout: 15_000 }, async () => {
  const source = '<div class="product">{{ product.title | escape }}</div>\n'.repeat(40000) +
    '{% render "card" %}{% javascript %}document.querySelector("main");{% endjavascript %}';
  const theme = await createTheme({ 'sections/large.liquid': source, 'snippets/card.liquid': 'card' });
  const client = embeddedClient(theme.root, { env: { LIQUID_PERFORMANCE_LOGGING: '1' } });
  try {
    await client.initialize({ textDocument: { publishDiagnostics: {} } });
    const uri = client.open(theme.file('sections/large.liquid'), source);
    const diagnostics = await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri);
    assert(diagnostics.diagnostics.some((item) => item.code === 'embedded-resource-limit'));
    for (const method of ['textDocument/definition', 'textDocument/completion', 'textDocument/hover',
      'textDocument/signatureHelp', 'textDocument/prepareRename', 'textDocument/references']) {
      assert.equal(await client.request(method, {
        textDocument: { uri }, position: positionAt(source, source.indexOf('"card"') + 2),
        context: { includeDeclaration: true },
      }), null, method);
    }
    assert(!client.notifications.some((message) => message.method === 'window/logMessage' &&
      /Liquid analysis parsed/.test(message.params.message)));
    const small = '{% javascript %}\ndocument.querySelector("main");\n{% endjavascript %}';
    client.change(uri, small, 2);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri }, position: positionAt(small, small.indexOf('document.') + 9),
    });
    assert(completionItems(completion).some((item) => item.label === 'querySelector'));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
