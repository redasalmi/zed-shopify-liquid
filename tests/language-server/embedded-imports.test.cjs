'use strict';

const assert = require('node:assert/strict');
const { writeFile, unlink } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const {
  completionItems,
  createTheme,
  embeddedClient,
  positionAt,
} = require('./protocol-harness.cjs');

test('unrelated file churn skips diagnostics while transitive dependencies revalidate their consumers', async () => {
  const source = `{% javascript %}\nimport('./facade').then(({ model }) => model.oldValue);\n{% endjavascript %}`;
  const independent = '{% javascript %}const value = 1; console.log(value);{% endjavascript %}';
  const theme = await createTheme({
    'sections/consumer.liquid': source,
    'sections/independent.liquid': independent,
    'sections/facade.ts': "export { model } from './module';",
    'sections/module.ts': 'export const model = { oldValue: 1 };',
    'assets/unrelated.js': 'console.log(1);',
  });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
    const uri = client.open(theme.file('sections/consumer.liquid'), source);
    const otherUri = client.open(theme.file('sections/independent.liquid'), independent);
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri);
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === otherUri);
    const diagnostics = () => client.notifications.filter((message) => message.method === 'textDocument/publishDiagnostics');
    client.notify('workspace/didChangeWatchedFiles', { changes: [
      { uri: pathToFileURL(theme.file('assets/unrelated.js')).href, type: 2 },
      { uri: pathToFileURL(theme.file('assets/new-unrelated.js')).href, type: 1 },
    ] });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(diagnostics().length, 0, 'unrelated changes must not schedule diagnostics');
    await writeFile(theme.file('sections/module.ts'), 'export const model = { newValue: 1 };');
    client.notify('workspace/didChangeWatchedFiles', { changes: [{
      uri: pathToFileURL(theme.file('sections/module.ts')).href, type: 2,
    }] });
    await client.waitForNotification('textDocument/publishDiagnostics', (p) =>
      p.uri === uri && p.diagnostics.some((diagnostic) => /oldValue.*does not exist/.test(diagnostic.message)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(!diagnostics().some((message) => message.params.uri === otherUri));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('changes to triple-slash declarations refresh diagnostics and completion', async () => {
  const source = `{% javascript %}\nimport('./model').then(({ model }) => model.oldValue);\n{% endjavascript %}`;
  const theme = await createTheme({
    'sections/referenced-types.liquid': source,
    'sections/model.ts': '/// <reference path="./types.d.ts" />\nexport const model = {} as Model;',
    'sections/types.d.ts': 'interface Model { oldValue: number; }',
  });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
    const uri = client.open(theme.file('sections/referenced-types.liquid'), source);
    const initial = await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri);
    assert.equal(initial.diagnostics.length, 0);
    const complete = async () => completionItems(await client.request('textDocument/completion', {
      textDocument: { uri }, position: positionAt(source, source.indexOf('model.oldValue') + 6),
    })).map((item) => item.label);
    assert.deepEqual(await complete(), ['oldValue']);
    const declarationPath = theme.file('sections/types.d.ts');
    await writeFile(declarationPath, 'interface Model { newValue: number; }');
    client.notify('workspace/didChangeWatchedFiles', { changes: [{
      uri: pathToFileURL(declarationPath).href, type: 2,
    }] });
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri &&
      p.diagnostics.some((diagnostic) => /oldValue.*does not exist/.test(diagnostic.message)), 5_000);
    assert.deepEqual(await complete(), ['newValue']);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('created and deleted modules refresh previously unresolved imports', async () => {
  const source = `{% javascript %}\nimport('./created').then(({ model }) => model.value);\n{% endjavascript %}`;
  const theme = await createTheme({ 'sections/creation.liquid': source });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
    const uri = client.open(theme.file('sections/creation.liquid'), source);
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri &&
      p.diagnostics.some((diagnostic) => /Cannot find module/.test(diagnostic.message)));
    const modulePath = theme.file('sections/created.ts');
    await writeFile(modulePath, 'export const model = { value: 1 };');
    client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(modulePath).href, type: 1 }] });
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri && p.diagnostics.length === 0);
    await unlink(modulePath);
    client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(modulePath).href, type: 3 }] });
    await client.waitForNotification('textDocument/publishDiagnostics', (p) => p.uri === uri &&
      p.diagnostics.some((diagnostic) => /Cannot find module/.test(diagnostic.message)));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

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
