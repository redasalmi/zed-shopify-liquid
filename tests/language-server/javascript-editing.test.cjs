'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { createTheme, embeddedClient, positionAt } = require('./protocol-harness.cjs');

test('private-field rename preserves privacy and distinguishes quoted property names', async () => {
  const source = `{% javascript %}
class Counter { #value = 0; getValue() { return this.#value; } }
const object = { '#value': 1 };
console.log(new Counter().getValue(), object['#value']);
{% endjavascript %}`;
  const theme = await createTheme({ 'sections/private-rename.liquid': source });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ textDocument: { rename: { prepareSupport: true } } });
    const uri = client.open(theme.file('sections/private-rename.liquid'), source);
    const document = TextDocument.create(uri, 'liquid', 1, source);
    for (const offset of [source.indexOf('#value'), source.indexOf('this.#value') + 5]) {
      const params = { textDocument: { uri }, position: positionAt(source, offset + 2) };
      const prepared = await client.request('textDocument/prepareRename', params);
      assert.equal(prepared.placeholder, '#value');
      for (const newName of ['#amount', 'amount', '#class']) {
        const result = await client.request('textDocument/rename', { ...params, newName });
        assert(result, `expected private rename to ${newName}`);
        const name = newName.startsWith('#') ? newName : `#${newName}`;
        assert.equal(TextDocument.applyEdits(document, result.changes[uri]),
          source.replace('#value =', `${name} =`).replace('this.#value', `this.${name}`));
      }
      for (const newName of ['#', '##amount', '#bad name', '#constructor', 'constructor']) {
        assert.equal(await client.request('textDocument/rename', { ...params, newName }), null);
      }
    }
    const quoted = await client.request('textDocument/rename', {
      textDocument: { uri }, position: positionAt(source, source.indexOf("'#value'") + 3),
      newName: 'amount',
    });
    assert(quoted);
    assert.equal(TextDocument.applyEdits(document, quoted.changes[uri]),
      source.replaceAll("'#value'", "'amount'"));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('embedded JavaScript signature help, local references, and safe rename', async () => {
  const source = `<p>Crème 🛍️ value</p>\r\n{% javascript %}\r\n/** Add two values.\n * @param {number} first First value.\n * @param {number} second Second value.\n */\nfunction sum(first, second) { return first + second; }\nconst value = 1;\nconst object = { value };\nsum(value, 2);\nconsole.log(value, 'value');\n{% endjavascript %}\n`;
  const imported = `{% javascript %}\nconst { model } = require('./module.js');\nmodel.value;\n{% endjavascript %}`;
  const theme = await createTheme({
    'sections/editing.liquid': source,
    'sections/independent.liquid': source,
    'sections/imported.liquid': imported,
    'sections/module.js': 'exports.model = { value: 1 };',
  });
  const client = embeddedClient(theme.root);
  try {
    const initialize = await client.initialize({ textDocument: { signatureHelp: {}, rename: { prepareSupport: true }, references: {} } });
    assert.deepEqual(initialize.capabilities.signatureHelpProvider.triggerCharacters, ['(', ',']);
    assert.deepEqual(initialize.capabilities.renameProvider, { prepareProvider: true });
    assert.equal(initialize.capabilities.referencesProvider, true);
    const uri = client.open(theme.file('sections/editing.liquid'), source);
    client.open(theme.file('sections/independent.liquid'), source);
    const signature = await client.request('textDocument/signatureHelp', {
      textDocument: { uri }, position: positionAt(source, source.indexOf('sum(value, ') + 11),
    });
    assert.match(signature.signatures[0].label, /sum\(first: number, second: number\)/);
    assert.match(signature.signatures[0].documentation, /Add two values/);
    assert.match(signature.signatures[0].parameters[1].documentation, /Second value/);
    assert.equal(signature.activeParameter, 1);

    const atValue = { textDocument: { uri }, position: positionAt(source, source.indexOf('const value') + 8) };
    const prepared = await client.request('textDocument/prepareRename', atValue);
    assert.equal(prepared.placeholder, 'value');
    assert.deepEqual(prepared.range.start, positionAt(source, source.indexOf('const value') + 6));
    const references = await client.request('textDocument/references', { ...atValue, context: { includeDeclaration: true } });
    assert.equal(references.length, 4);
    assert(references.every((entry) => entry.uri === uri));
    const uses = await client.request('textDocument/references', { ...atValue, context: { includeDeclaration: false } });
    assert.equal(uses.length, 3);
    const rename = await client.request('textDocument/rename', { ...atValue, newName: 'amount' });
    assert.deepEqual(Object.keys(rename.changes), [uri]);
    const updated = TextDocument.applyEdits(TextDocument.create(uri, 'liquid', 1, source), rename.changes[uri]);
    assert.match(updated, /const amount = 1;/);
    assert.match(updated, /\{ value: amount \}/);
    assert.match(updated, /sum\(amount, 2\)/);
    assert.match(updated, /console.log\(amount, 'value'\)/);
    assert.match(updated, /<p>Crème 🛍️ value<\/p>/);
    for (const newName of ['class', 'bad name', 'await']) {
      assert.equal(await client.request('textDocument/rename', { ...atValue, newName }), null);
    }

    for (const offset of [source.indexOf('value'), source.indexOf('{% endjavascript %}')]) {
      const params = { textDocument: { uri }, position: positionAt(source, offset), context: { includeDeclaration: true }, newName: 'changed' };
      for (const method of ['textDocument/signatureHelp', 'textDocument/prepareRename', 'textDocument/rename', 'textDocument/references']) {
        assert.equal(await client.request(method, params), null, `${method} at ${offset}`);
      }
    }
    const importedUri = client.open(theme.file('sections/imported.liquid'), imported);
    const external = { textDocument: { uri: importedUri }, position: positionAt(imported, imported.indexOf('model.value') + 8) };
    assert.equal(await client.request('textDocument/prepareRename', external), null);
    assert.equal(await client.request('textDocument/rename', { ...external, newName: 'changed' }), null);
    assert.equal(await client.request('textDocument/prepareRename', {
      textDocument: { uri }, position: positionAt(source, source.indexOf('console.log') + 2),
    }), null);

    client.change(uri, '<p>No JavaScript</p>', 2);
    assert.equal(await client.request('textDocument/references', { ...atValue, context: { includeDeclaration: true } }), null);
    client.close(uri);
    assert.equal(await client.request('textDocument/prepareRename', atValue), null);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
