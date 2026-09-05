'use strict';

const assert = require('node:assert/strict');
const { writeFile, unlink } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { schemaSettingLocations, settingDocumentation } = require('../../language-server/schema-settings.cjs');
const { createTheme, embeddedClient, positionAt, completionItems } = require('./protocol-harness.cjs');

test('schema setting locations distinguish declarations and preserve escaped source offsets', () => {
  const source = '{"settings":[{"id":"he\\u0061ding"}],"blocks":[{"type":"card","settings":[{"id":"heading"}]}],"presets":[{"settings":{"id":"not_a_setting"}}]}';
  const locations = schemaSettingLocations(source);
  assert.deepEqual(locations.map(({ id, inlineBlock }) => ({ id, inlineBlock })), [
    { id: 'heading', inlineBlock: false }, { id: 'heading', inlineBlock: true },
  ]);
  assert.equal(source.slice(locations[0].start, locations[0].end), 'he\\u0061ding');
  assert.equal(settingDocumentation({ label: 't:heading.label', info: 'Untranslated info' }, { heading: { label: 'Titre' } }), 'Titre\n\nUntranslated info');
  assert.equal(settingDocumentation({ label: 't:missing', info: 't:__proto__.toString' }, {}), '');
});

test('setting definitions navigate local and ambiguous inline schemas, not strings or presets', async () => {
  const schema = JSON.stringify({
    settings: [{ type: 'text', id: 'heading' }],
    blocks: [
      { type: 'card', settings: [{ type: 'text', id: 'heading' }] },
      { type: 'slide', settings: [{ type: 'text', id: 'heading' }] },
    ],
    presets: [{ settings: { id: 'heading' } }],
  });
  const source = `🛍️\r\n{{ section.settings.heading }}\r\n{{ block.settings["heading"] }}\r\n{{ 'block.settings.heading' }}\r\n{% comment %}{{ block.settings.heading }}{% endcomment %}\r\n{% javascript %}const text = '{{ block.settings.heading }}';{% endjavascript %}\r\n{% schema %}${schema}{% endschema %}`;
  const blockSource = `{{ block.settings.heading }}\n{{ section.settings.heading }}\n{% schema %}${schema}{% endschema %}`;
  const theme = await createTheme({ 'sections/settings.liquid': source, 'blocks/card.liquid': blockSource });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ textDocument: { definition: {} } });
    const uri = client.open(theme.file('sections/settings.liquid'), source);
    const definition = (uri, source, offset) => client.request('textDocument/definition', {
      textDocument: { uri }, position: positionAt(source, offset),
    });
    const localOffset = source.indexOf('section.settings.heading') + 19;
    const local = await definition(uri, source, localOffset);
    assert.equal(local.length, 1);
    assert.deepEqual(local[0].range.start, positionAt(source, source.indexOf('"id":"heading"') + 6));
    const blockOffset = source.indexOf('block.settings["heading"]') + 18;
    const inline = await definition(uri, source, blockOffset);
    assert.equal(inline.length, 2);
    assert(inline.every((location) => location.uri === uri));
    const idPositions = [...source.matchAll(/"id":"heading"/g)].map((match) => match.index + 6);
    assert.deepEqual(inline.map((location) => location.range.start), idPositions.slice(1, 3).map((offset) => positionAt(source, offset)));
    for (const needle of ["'block.settings.heading'", '{% comment %}{{ block.settings.heading', "const text = '{{ block.settings.heading }}'"]) {
      assert.equal(await definition(uri, source, source.indexOf(needle) + needle.indexOf('heading') + 2), null);
    }
    const blockUri = client.open(theme.file('blocks/card.liquid'), blockSource);
    const block = await definition(blockUri, blockSource, blockSource.indexOf('block.settings.heading') + 17);
    assert.equal(block.length, 1);
    assert.deepEqual(block[0].range.start, positionAt(blockSource, blockSource.indexOf('"id":"heading"') + 6));
    assert.equal(await definition(blockUri, blockSource, blockSource.indexOf('section.settings.heading') + 19), null);

    const shifted = 'prefix\r\n' + source;
    client.changeIncrementally(uri, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'prefix\r\n' }], 2);
    const moved = await definition(uri, shifted, localOffset + 8);
    assert.deepEqual(moved[0].range.start, positionAt(shifted, shifted.indexOf('"id":"heading"') + 6));
    const changed = shifted.replace('"id":"heading"', '"id":"renamed"');
    client.change(uri, changed, 3);
    assert.equal(await definition(uri, changed, localOffset + 8), null);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});

test('inline setting documentation resolves schema locales and invalidates cached translations', async () => {
  const source = '{{ block.settings. }}\n{% schema %}' + JSON.stringify({ blocks: [{
    type: 'card', settings: [{ type: 'text', id: 'heading', label: 't:card.heading', info: 't:card.info' }],
  }] }) + '{% endschema %}';
  const theme = await createTheme({
    'sections/settings.liquid': source,
    'locales/en.default.schema.json': JSON.stringify({ card: { heading: 'Heading', info: 'Helpful text' } }),
    'locales/fr.schema.json': JSON.stringify({ card: { heading: 'Titre' } }),
    'nested/.theme-check.yml': 'root: .',
    'nested/sections/settings.liquid': source,
    'nested/locales/en.default.schema.json': JSON.stringify({ card: { heading: 'Nested heading' } }),
  });
  const client = embeddedClient(theme.root);
  try {
    await client.initialize({ workspace: { didChangeWatchedFiles: { dynamicRegistration: true } }, textDocument: { completion: {} } });
    const uri = client.open(theme.file('sections/settings.liquid'), source);
    const complete = async (uri) => completionItems(await client.request('textDocument/completion', {
      textDocument: { uri }, position: positionAt(source, source.indexOf('block.settings.') + 15),
    })).find((item) => item.label === 'heading');
    assert.equal((await complete(uri)).documentation, 'Heading\n\nHelpful text');
    const nestedUri = client.open(theme.file('nested/sections/settings.liquid'), source);
    assert.equal((await complete(nestedUri)).documentation, 'Nested heading');
    const localePath = theme.file('locales/en.default.schema.json');
    for (const [contents, expected] of [
      [JSON.stringify({ card: { heading: 'Updated heading' } }), 'Updated heading'],
      ['/* Generated locale */\n{"card":{"heading":"Commented heading"}}', 'Commented heading'],
      ['{"card":{"heading":"Trailing comma heading",},}', 'Trailing comma heading'],
      ['{malformed', undefined],
      ['{"card":{"heading":"Incomplete locale"}', undefined],
      [' '.repeat(1024 * 1024 + 1), undefined],
      [JSON.stringify({ card: { heading: 'Restored heading' } }), 'Restored heading'],
    ]) {
      await writeFile(localePath, contents);
      client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(localePath).href, type: 2 }] });
      assert.equal((await complete(uri)).documentation, expected);
    }
    await unlink(localePath);
    client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(localePath).href, type: 3 }] });
    assert.equal((await complete(uri)).documentation, undefined);
  } finally {
    await client.stop();
    await theme.cleanup();
  }
});
