'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const {
  completionItems,
  createTheme,
  positionAt,
  shopifyClient,
} = require('./protocol-harness.cjs');

test('pinned Shopify language server integration smoke test', { timeout: 90_000 }, async () => {
  const featureSource = `{% render 'card' %}
{{ product. }}
{{ product | definitely_not_a_filter }}
<article>Text</article>
`;
  const autocloseSource = '<main>';
  const theme = await createTheme({
    'sections/features.liquid': featureSource,
    'sections/autoclose.liquid': autocloseSource,
    'snippets/card.liquid': '<div>Card</div>',
  });
  const client = shopifyClient(theme.root);

  try {
    const initialize = await client.initialize({
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: true },
      },
      window: { workDoneProgress: true },
      textDocument: {
        completion: {
          dynamicRegistration: false,
          completionItem: { documentationFormat: ['markdown'], snippetSupport: true },
        },
        definition: { dynamicRegistration: false },
        documentLink: { dynamicRegistration: false, tooltipSupport: true },
        hover: { dynamicRegistration: false, contentFormat: ['markdown'] },
        linkedEditingRange: { dynamicRegistration: false },
        onTypeFormatting: { dynamicRegistration: false },
        publishDiagnostics: { relatedInformation: true },
      },
    });
    const capabilities = initialize.capabilities;
    assert(capabilities.completionProvider);
    assert(capabilities.hoverProvider);
    assert.equal(capabilities.documentLinkProvider.resolveProvider, false);
    assert.equal(capabilities.linkedEditingRangeProvider, true);
    assert(capabilities.documentOnTypeFormattingProvider.moreTriggerCharacter.includes('>'));

    const featureUri = client.open(theme.file('sections/features.liquid'), featureSource);
    const completionOffset = featureSource.indexOf('product.') + 'product.'.length;
    const completions = await client.request('textDocument/completion', {
      textDocument: { uri: featureUri },
      position: positionAt(featureSource, completionOffset),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    assert(
      completionItems(completions).some((item) => item.label === 'title'),
      'Shopify object-property completion should reach the client',
    );

    const hover = await client.request('textDocument/hover', {
      textDocument: { uri: featureUri },
      position: positionAt(featureSource, featureSource.lastIndexOf('product') + 2),
    });
    assert.match(JSON.stringify(hover.contents), /product/i);

    const links = await client.request('textDocument/documentLink', {
      textDocument: { uri: featureUri },
    });
    assert(
      links.some((link) => link.target === pathToFileURL(theme.file('snippets/card.liquid')).href),
      'Shopify document links should resolve static render references',
    );

    const linked = await client.request('textDocument/linkedEditingRange', {
      textDocument: { uri: featureUri },
      position: positionAt(featureSource, featureSource.indexOf('article') + 2),
    });
    assert.equal(linked.ranges.length, 2);
    assert.deepEqual(linked.ranges[0].start, positionAt(featureSource, featureSource.indexOf('article')));
    assert.deepEqual(linked.ranges[1].start, positionAt(featureSource, featureSource.lastIndexOf('article')));

    const autocloseUri = client.open(theme.file('sections/autoclose.liquid'), autocloseSource);
    const autoclose = await client.request('textDocument/onTypeFormatting', {
      textDocument: { uri: autocloseUri },
      position: positionAt(autocloseSource, autocloseSource.length),
      ch: '>',
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.deepEqual(autoclose, [
      {
        range: {
          start: positionAt(autocloseSource, autocloseSource.length),
          end: positionAt(autocloseSource, autocloseSource.length),
        },
        newText: '</main>',
      },
    ]);

    const diagnostics = await client.waitForNotification(
      'textDocument/publishDiagnostics',
      (params) =>
        params.uri === featureUri &&
        params.diagnostics.some((diagnostic) => /definitely_not_a_filter/.test(diagnostic.message)),
      60_000,
    );
    assert(diagnostics.diagnostics.some((diagnostic) => diagnostic.severity === 1));
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
