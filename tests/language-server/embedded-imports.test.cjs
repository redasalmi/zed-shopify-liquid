'use strict';

const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const {
  completionItems,
  createTheme,
  embeddedClient,
  positionAt,
} = require('./protocol-harness.cjs');

test('workspace JavaScript snapshots refresh after watched-file changes', { timeout: 20_000 }, async () => {
  const source = `{% javascript %}
const { model } = require('./module.js');
model.
{% endjavascript %}`;
  const theme = await createTheme({
    'sections/imports.liquid': source,
    'sections/module.js': 'exports.model = { oldValue: 1 };',
  });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { completion: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/imports.liquid'), source);
    const position = positionAt(source, source.lastIndexOf('model.') + 'model.'.length);

    const initial = await client.request('textDocument/completion', {
      textDocument: { uri },
      position,
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(initial).some((item) => item.label === 'oldValue'));

    await writeFile(theme.file('sections/module.js'), 'exports.model = { newValue: 1 };');
    client.notify('workspace/didChangeWatchedFiles', {
      changes: [
        {
          uri: pathToFileURL(theme.file('sections/module.js')).href,
          type: 2,
        },
      ],
    });

    const updated = await client.request('textDocument/completion', {
      textDocument: { uri },
      position,
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(completionItems(updated).some((item) => item.label === 'newValue'));
    assert(!completionItems(updated).some((item) => item.label === 'oldValue'));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('workspace module changes revalidate open embedded documents', { timeout: 20_000 }, async () => {
  const source = `{% javascript %}
import('./module').then(({ model }) => model.oldValue);
{% endjavascript %}`;
  const theme = await createTheme({
    'sections/import-diagnostics.liquid': source,
    'sections/module.ts': 'export const model = { oldValue: 1 };',
  });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      textDocument: { publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/import-diagnostics.liquid'), source);
    const initial = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri,
    );
    assert.equal(initial.diagnostics.length, 0);

    await writeFile(theme.file('sections/module.ts'), 'export const model = { newValue: 1 };');
    client.notify('workspace/didChangeWatchedFiles', {
      changes: [
        {
          uri: pathToFileURL(theme.file('sections/module.ts')).href,
          type: 2,
        },
      ],
    });

    const updated = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === uri &&
        params.diagnostics.some((diagnostic) => /oldValue/.test(diagnostic.message)),
    );
    assert(updated.diagnostics.some((diagnostic) => /does not exist/.test(diagnostic.message)));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
