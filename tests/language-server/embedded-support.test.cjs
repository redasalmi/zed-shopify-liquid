'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  completionItems,
  createTheme,
  embeddedClient,
  positionAt,
} = require('./protocol-harness.cjs');

function offsetAt(text, position) {
  const lines = text.split(/(?<=\n)/);
  return lines.slice(0, position.line).reduce((total, line) => total + line.length, 0) + position.character;
}

function labels(result) {
  return new Set(completionItems(result).map((item) => item.label));
}

function locationUri(result) {
  return (Array.isArray(result) ? result[0] : result)?.uri;
}

test('raw Liquid content does not activate embedded providers', { timeout: 10_000 }, async () => {
  const source = `{% comment %}
{% javascript %}
const broken = ;
{% endjavascript %}
{% schema %}
{
  "blocks": [{ "type": "fake", "settings": [{ "id": "should_not_complete" }] }]
}
{% endschema %}
{% doc %}
@
{% enddoc %}
{% endcomment %}
{{ block.settings. }}
`;
  const theme = await createTheme({ 'sections/raw-content.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      textDocument: { completion: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/raw-content.liquid'), source);
    const settings = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('block.settings.') + 'block.settings.'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert.equal(settings, null);

    const tags = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('@\n') + 1),
      context: { triggerKind: 2, triggerCharacter: '@' },
    });
    assert.equal(tags, null);

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert(
      !client.notifications.some(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params?.uri === uri &&
          message.params.diagnostics.some((diagnostic) => /Expression expected/.test(diagnostic.message)),
      ),
      'raw Liquid content must not produce embedded diagnostics',
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('schema setting completion is limited to Liquid expressions', { timeout: 10_000 }, async () => {
  const source = `{% comment %}{{ block.settings. }}{% endcomment %}
{% javascript %}const value = 'block.settings.';{% endjavascript %}
{% doc %}
block.settings.
{% enddoc %}
{{ block.settings. }}
{% schema %}
{"blocks":[{"type":"slide","settings":[{"type":"text","id":"heading"}]}]}
{% endschema %}
`;
  const theme = await createTheme({ 'sections/setting-contexts.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({ textDocument: { completion: {} } });
    const uri = client.open(theme.file('sections/setting-contexts.liquid'), source);
    const occurrences = [];
    let occurrence = source.indexOf('block.settings.');
    while (occurrence !== -1) {
      occurrences.push(occurrence);
      occurrence = source.indexOf('block.settings.', occurrence + 1);
    }

    for (const ignored of occurrences.slice(0, 3)) {
      assert.equal(
        await client.request('textDocument/completion', {
          textDocument: { uri },
          position: positionAt(source, ignored + 'block.settings.'.length),
          context: { triggerKind: 2, triggerCharacter: '.' },
        }),
        null,
      );
    }

    const liquidResult = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, occurrences[3] + 'block.settings.'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert.deepEqual([...labels(liquidResult)], ['heading']);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('embedded providers use half-open ranges and contain diagnostics', { timeout: 10_000 }, async () => {
  const source = `{% stylesheet %}\n:root { --brand: red; }\n{% endstylesheet %}\n{% javascript %}\nconst value = ({\n{% endjavascript %}\n`;
  const theme = await createTheme({ 'sections/boundaries.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      textDocument: { completion: {}, definition: {}, hover: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/boundaries.liquid'), source);
    const closingOffset = source.indexOf('{% endjavascript %}');
    const closingOffsets = [source.indexOf('{% endstylesheet %}'), closingOffset];
    for (const boundary of closingOffsets) {
      for (const method of ['textDocument/completion', 'textDocument/definition', 'textDocument/hover']) {
        const result = await client.request(method, {
          textDocument: { uri },
          position: positionAt(source, boundary),
          ...(method === 'textDocument/completion' ? { context: { triggerKind: 1 } } : {}),
        });
        assert.equal(result, null, `${method} must not activate at a closing-tag boundary`);
      }
      assert.deepEqual(
        await client.request('textDocument/rangeFormatting', {
          textDocument: { uri },
          range: {
            start: positionAt(source, boundary),
            end: positionAt(source, boundary),
          },
          options: { tabSize: 2, insertSpaces: true },
        }),
        [],
      );
    }

    const published = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) => params.uri === uri,
    );
    assert(
      published.diagnostics.every(
        (diagnostic) => offsetAt(source, diagnostic.range.end) <= closingOffset,
      ),
      'TypeScript diagnostics must not include Liquid closing delimiters',
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('async responses are discarded after the document changes', { timeout: 10_000 }, async () => {
  const source = `{% render 'card' %}`;
  const changed = '<div>Reference removed</div>';
  const docSource = `{% doc %}\n@param {pro} item\n{% enddoc %}`;
  const theme = await createTheme({
    'sections/stale-definition.liquid': source,
    'snippets/card.liquid': 'card',
    'snippets/stale-doc.liquid': docSource,
  });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({ textDocument: { definition: {} } });
    const uri = client.open(theme.file('sections/stale-definition.liquid'), source);
    const definition = client.request('textDocument/definition', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('card') + 2),
    });
    client.change(uri, changed, 2);
    assert.equal(await definition, null);

    const docUri = client.open(theme.file('snippets/stale-doc.liquid'), docSource);
    const completion = client.request('textDocument/completion', {
      textDocument: { uri: docUri },
      position: positionAt(docSource, docSource.indexOf('pro}') + 'pro'.length),
      context: { triggerKind: 1 },
    });
    client.change(docUri, '<div>Documentation removed</div>', 2);
    assert.equal(await completion, null);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('embedded providers stay disabled outside Shopify bundled-asset directories', { timeout: 10_000 }, async () => {
  const source = `{% javascript %}\nconst broken = ;\n{% endjavascript %}`;
  const theme = await createTheme({ 'layout/theme.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      textDocument: { completion: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('layout/theme.liquid'), source);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('broken')),
      context: { triggerKind: 1 },
    });
    assert.equal(completion, null);

    await new Promise((resolve) => setTimeout(resolve, 700));
    assert(
      !client.notifications.some(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params?.uri === uri &&
          message.params.diagnostics.some((diagnostic) => diagnostic.source === 'typescript'),
      ),
      'unsupported Liquid directories must not produce embedded diagnostics',
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('a directory name alone does not activate Shopify embedded providers', { timeout: 10_000 }, async () => {
  const source = `{{ block.settings. }}
{% javascript %}\ndocument.\n{% endjavascript %}
{% schema %}{"blocks":[{"type":"x","settings":[{"type":"text","id":"heading"}]}]}{% endschema %}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'zed-liquid-unrelated-'));
  const sections = path.join(root, 'sections');
  const filePath = path.join(sections, 'example.liquid');
  await mkdir(sections);
  await writeFile(filePath, source);
  const client = embeddedClient(root);

  try {
    await client.initialize({ textDocument: { completion: {} } });
    const uri = client.open(filePath, source);
    for (const offset of [
      source.indexOf('block.settings.') + 'block.settings.'.length,
      source.indexOf('document.') + 'document.'.length,
    ]) {
      assert.equal(
        await client.request('textDocument/completion', {
          textDocument: { uri },
          position: positionAt(source, offset),
          context: { triggerKind: 2, triggerCharacter: '.' },
        }),
        null,
      );
    }
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace-folder changes invalidate theme activation caches', { timeout: 10_000 }, async () => {
  const source = `{% javascript %}\ndocument.\n{% endjavascript %}`;
  const theme = await createTheme({ 'sections/workspace-change.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      workspace: {
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      textDocument: { completion: {} },
    });
    const uri = client.open(theme.file('sections/workspace-change.liquid'), source);
    const position = positionAt(source, source.indexOf('document.') + 'document.'.length);
    const initial = await client.request('textDocument/completion', {
      textDocument: { uri },
      position,
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(labels(initial).has('querySelector'));

    client.notify('workspace/didChangeWorkspaceFolders', {
      event: {
        added: [],
        removed: [{ uri: pathToFileURL(theme.root).href, name: path.basename(theme.root) }],
      },
    });
    client.change(uri, source, 2);
    assert.equal(
      await client.request('textDocument/completion', {
        textDocument: { uri },
        position,
        context: { triggerKind: 2, triggerCharacter: '.' },
      }),
      null,
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('oversized embedded documents degrade without loading TypeScript', { timeout: 10_000 }, async () => {
  const largeSource = `{% javascript %}\n${'x'.repeat(2048)}\ndocument.\n{% endjavascript %}`;
  const smallSource = `{% javascript %}\ndocument.\n{% endjavascript %}`;
  const theme = await createTheme({ 'sections/oversized.liquid': largeSource });
  const client = embeddedClient(theme.root, {
    env: { LIQUID_MAX_EMBEDDED_DOCUMENT_CODE_UNITS: '1024' },
  });

  try {
    await client.initialize({
      textDocument: { completion: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/oversized.liquid'), largeSource);
    const limited = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === uri &&
        params.diagnostics.some((diagnostic) => diagnostic.code === 'embedded-resource-limit'),
    );
    assert.match(limited.diagnostics[0].message, /document.*exceeds/i);
    assert.equal(
      await client.request('textDocument/completion', {
        textDocument: { uri },
        position: positionAt(largeSource, largeSource.indexOf('document.') + 'document.'.length),
        context: { triggerKind: 2, triggerCharacter: '.' },
      }),
      null,
    );

    client.change(uri, smallSource, 2);
    const completion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(smallSource, smallSource.indexOf('document.') + 'document.'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(labels(completion).has('querySelector'));
    const restored = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === uri &&
        params.diagnostics.every((diagnostic) => diagnostic.code !== 'embedded-resource-limit'),
    );
    assert(restored.diagnostics.every((diagnostic) => diagnostic.source !== 'liquid-embedded-support'));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('duplicate bundled asset tags are not merged into one virtual document', { timeout: 10_000 }, async () => {
  const source = `{% javascript %}\ndocument.\n{% endjavascript %}\n{% javascript %}\ndocument.\n{% endjavascript %}`;
  const theme = await createTheme({ 'sections/duplicate.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({ textDocument: { completion: {} } });
    const uri = client.open(theme.file('sections/duplicate.liquid'), source);
    const firstCompletion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('document.') + 'document.'.length),
      context: { triggerKind: 1 },
    });
    assert.notEqual(firstCompletion, null);

    const secondCompletion = await client.request('textDocument/completion', {
      textDocument: { uri },
      position: positionAt(source, source.lastIndexOf('document.') + 'document.'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert.equal(secondCompletion, null);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('ranged incremental Unicode edits invalidate embedded state', { timeout: 10_000 }, async () => {
  const source = `<p>Crème 🛍️</p>\r\n{% javascript %}\r\nconst oldName = 1;\r\nconsole.log(oldName);\r\n{% endjavascript %}`;
  const updatedSource = source.replace('oldName', 'currentName');
  const theme = await createTheme({ 'sections/incremental.liquid': source });
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({
      textDocument: { definition: {}, publishDiagnostics: {} },
    });
    const uri = client.open(theme.file('sections/incremental.liquid'), source);
    const declarationStart = source.indexOf('oldName');
    client.changeIncrementally(
      uri,
      [
        {
          range: {
            start: positionAt(source, declarationStart),
            end: positionAt(source, declarationStart + 'oldName'.length),
          },
          text: 'currentName',
        },
      ],
      2,
    );

    const useOffset = updatedSource.lastIndexOf('oldName') + 2;
    assert.equal(
      await client.request('textDocument/definition', {
        textDocument: { uri },
        position: positionAt(updatedSource, useOffset),
      }),
      null,
    );
    const diagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === uri &&
        params.diagnostics.some((diagnostic) => /oldName/.test(diagnostic.message)),
    );
    assert(
      diagnostics.diagnostics.every(
        (diagnostic) => offsetAt(updatedSource, diagnostic.range.end) <= updatedSource.indexOf('{% endjavascript %}'),
      ),
    );

    const prefixOffset = updatedSource.indexOf('Crème');
    const shiftedSource =
      updatedSource.slice(0, prefixOffset) + 'Très ' + updatedSource.slice(prefixOffset);
    client.changeIncrementally(
      uri,
      [
        {
          range: {
            start: positionAt(updatedSource, prefixOffset),
            end: positionAt(updatedSource, prefixOffset),
          },
          text: 'Très ',
        },
      ],
      3,
    );
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri },
      position: positionAt(shiftedSource, shiftedSource.indexOf('currentName') + 2),
    });
    assert.match(hover.contents.value, /currentName/);
    assert.deepEqual(
      hover.range.start,
      positionAt(shiftedSource, shiftedSource.indexOf('currentName')),
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('embedded support server protocol contracts', { timeout: 60_000 }, async () => {
  const settingsSource = `{{ block.settings. }}
{% schema %}
{
  "blocks": [
    { "type": "slide", "settings": [{ "type": "text", "id": "heading", "label": "Heading" }] },
    { "type": "image", "settings": [{ "type": "image_picker", "id": "image", "label": "Image" }] }
  ]
}
{% endschema %}
`;
  const docSource = `{% doc %}
@param {} item
@
{% enddoc %}
`;
  const assetSource = `<p>Crème 🛍️</p>
{% stylesheet %}
:root{--brand:red}.button{color:var(--brand)}
{% endstylesheet %}
{% javascript %}
return;
const total=1;console.log(total);missingName;const element=document.querySelector('div');
{% endjavascript %}
`;
  const navigationSource = `{% render 'card' %}
{% section 'footer' %}
{% content_for 'block', type: 'feature' %}
`;
  const nestedNavigationSource = `{% render 'card' %}`;
  const theme = await createTheme({
    'sections/settings.liquid': settingsSource,
    'snippets/doc.liquid': docSource,
    'sections/assets.liquid': assetSource,
    'sections/navigation.liquid': navigationSource,
    'snippets/card.liquid': 'root card',
    'sections/footer.liquid': 'footer',
    'blocks/feature.liquid': 'feature',
    'nested/.theme-check.yml': 'root: .\n',
    'nested/sections/navigation.liquid': nestedNavigationSource,
    'nested/snippets/card.liquid': 'nested card',
  });
  const client = embeddedClient(theme.root);

  try {
    const initialize = await client.initialize({
      textDocument: {
        completion: { completionItem: { snippetSupport: true } },
        definition: {},
        formatting: {},
        hover: { contentFormat: ['markdown'] },
      },
    });
    assert.equal(initialize.serverInfo.name, 'liquid-embedded-support');
    assert.equal(initialize.capabilities.definitionProvider, true);
    assert.equal(initialize.capabilities.documentRangeFormattingProvider, true);
    assert.equal(initialize.capabilities.completionProvider.resolveProvider, true);

    const settingsUri = client.open(theme.file('sections/settings.liquid'), settingsSource);
    const settings = await client.request('textDocument/completion', {
      textDocument: { uri: settingsUri },
      position: positionAt(settingsSource, settingsSource.indexOf('block.settings.') + 'block.settings.'.length),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert.deepEqual([...labels(settings)].sort(), ['heading', 'image']);

    const docUri = client.open(theme.file('snippets/doc.liquid'), docSource);
    const typeCursor = docSource.indexOf('{}') + 1;
    const types = await client.request('textDocument/completion', {
      textDocument: { uri: docUri },
      position: positionAt(docSource, typeCursor),
      context: { triggerKind: 1 },
    });
    assert(labels(types).has('string'));
    assert(labels(types).has('string[]'));
    assert(labels(types).has('product'));
    assert(labels(types).has('product[]'));

    const tagCursor = docSource.indexOf('@\n') + 1;
    const tags = await client.request('textDocument/completion', {
      textDocument: { uri: docUri },
      position: positionAt(docSource, tagCursor),
      context: { triggerKind: 2, triggerCharacter: '@' },
    });
    assert.deepEqual([...labels(tags)].sort(), ['description', 'example', 'param']);
    assert(completionItems(tags).every((item) => item.insertTextFormat === 2));

    const assetUri = client.open(theme.file('sections/assets.liquid'), assetSource);
    const cssOffset = assetSource.indexOf('--brand') + 2;
    assert.equal(
      await client.request('textDocument/completion', {
        textDocument: { uri: assetUri },
        position: positionAt(assetSource, cssOffset),
        context: { triggerKind: 1 },
      }),
      null,
      'Shopify remains the owner of stylesheet completion',
    );
    assert.equal(
      await client.request('textDocument/hover', {
        textDocument: { uri: assetUri },
        position: positionAt(assetSource, cssOffset),
      }),
      null,
      'Shopify remains the owner of stylesheet hover',
    );

    const completionOffset = assetSource.indexOf('document.querySelector') + 'document.'.length;
    const javascript = await client.request('textDocument/completion', {
      textDocument: { uri: assetUri },
      position: positionAt(assetSource, completionOffset),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(labels(javascript).has('querySelector'));
    const querySelectorItem = completionItems(javascript).find(
      (item) => item.label === 'querySelector',
    );
    const resolvedCompletion = await client.request('completionItem/resolve', querySelectorItem);
    assert.match(resolvedCompletion.detail, /querySelector/);
    assert.match(resolvedCompletion.documentation.value, /selector/i);

    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: assetUri },
      position: positionAt(assetSource, assetSource.indexOf('querySelector') + 2),
    });
    assert.match(hover.contents.value, /querySelector/);

    const javascriptDefinition = await client.request('textDocument/definition', {
      textDocument: { uri: assetUri },
      position: positionAt(assetSource, assetSource.indexOf('total)', assetSource.indexOf('total') + 1) + 2),
    });
    assert.equal(locationUri(javascriptDefinition), assetUri);
    assert.deepEqual(javascriptDefinition[0].range.start, positionAt(assetSource, assetSource.indexOf('total')));

    const stylesheetDefinition = await client.request('textDocument/definition', {
      textDocument: { uri: assetUri },
      position: positionAt(assetSource, assetSource.lastIndexOf('--brand') + 2),
    });
    assert.equal(locationUri(stylesheetDefinition), assetUri);
    assert.deepEqual(stylesheetDefinition.range.start, positionAt(assetSource, assetSource.indexOf('--brand')));

    const ranges = [
      [assetSource.indexOf(':root'), assetSource.indexOf('\n{% endstylesheet %}')],
      [assetSource.indexOf('const total'), assetSource.indexOf('\n{% endjavascript %}')],
    ];
    for (const [start, end] of ranges) {
      const edits = await client.request('textDocument/rangeFormatting', {
        textDocument: { uri: assetUri },
        range: { start: positionAt(assetSource, start), end: positionAt(assetSource, end) },
        options: { tabSize: 2, insertSpaces: true },
      });
      assert(edits.length > 0);
      assert(
        edits.every((edit) => {
          const editStart = offsetAt(assetSource, edit.range.start);
          const editEnd = offsetAt(assetSource, edit.range.end);
          return editStart >= start && editEnd <= end;
        }),
        'formatting edits must remain inside the requested embedded block',
      );
    }

    const diagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === assetUri &&
        params.diagnostics.some((diagnostic) => /missingName/.test(diagnostic.message)),
    );
    assert(diagnostics.diagnostics.some((diagnostic) => diagnostic.severity === 1));
    const scriptStart = assetSource.indexOf('const total');
    const scriptEnd = assetSource.indexOf('\n{% endjavascript %}');
    assert(
      diagnostics.diagnostics.every((diagnostic) => {
        const start = offsetAt(assetSource, diagnostic.range.start);
        const end = offsetAt(assetSource, diagnostic.range.end);
        return start >= scriptStart && end <= scriptEnd;
      }),
      'supplemental diagnostics must remain inside JavaScript blocks',
    );

    const navigationUri = client.open(theme.file('sections/navigation.liquid'), navigationSource);
    for (const [reference, target] of [
      ["'card'", 'snippets/card.liquid'],
      ["'footer'", 'sections/footer.liquid'],
      ["'feature'", 'blocks/feature.liquid'],
    ]) {
      const definition = await client.request('textDocument/definition', {
        textDocument: { uri: navigationUri },
        position: positionAt(navigationSource, navigationSource.indexOf(reference) + 2),
      });
      assert.equal(locationUri(definition), pathToFileURL(theme.file(target)).href);
    }

    const nestedUri = client.open(
      theme.file('nested/sections/navigation.liquid'),
      nestedNavigationSource,
    );
    const nestedDefinition = await client.request('textDocument/definition', {
      textDocument: { uri: nestedUri },
      position: positionAt(nestedNavigationSource, nestedNavigationSource.indexOf('card') + 2),
    });
    assert.equal(
      locationUri(nestedDefinition),
      pathToFileURL(theme.file('nested/snippets/card.liquid')).href,
      'the nearest theme root must win over a parent theme',
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('static definitions honor a configured Theme Check root', { timeout: 10_000 }, async () => {
  const source = `{% render 'card' %}`;
  const theme = await createTheme(
    {
      'src/sections/navigation.liquid': source,
      'dist/snippets/card.liquid': 'configured card',
    },
    { themeCheck: 'root: dist\n' },
  );
  const client = embeddedClient(theme.root);

  try {
    await client.initialize({ definition: {} });
    const uri = client.open(theme.file('src/sections/navigation.liquid'), source);
    const definition = await client.request('textDocument/definition', {
      textDocument: { uri },
      position: positionAt(source, source.indexOf('card') + 2),
    });
    assert.equal(
      locationUri(definition),
      pathToFileURL(theme.file('dist/snippets/card.liquid')).href,
    );
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
