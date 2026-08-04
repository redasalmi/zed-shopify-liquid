'use strict';

const assert = require('node:assert/strict');
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
  const assetSource = `{% stylesheet %}
:root{--brand:red}.button{color:var(--brand)}
{% endstylesheet %}
{% javascript %}
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
    assert(labels(types).has('product'));

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
