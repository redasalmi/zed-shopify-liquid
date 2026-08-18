'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const snippets = JSON.parse(readFileSync(path.join(root, 'snippets/liquid.json'), 'utf8'));
const extensionManifest = readFileSync(path.join(root, 'extension.toml'), 'utf8');

function prefixes(snippet) {
  return Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
}

function body(snippet) {
  return snippet.body.join('\n');
}

test('Liquid snippets are registered by the extension manifest', () => {
  assert.match(extensionManifest, /^snippets = \["\.\/snippets\/liquid\.json"\]$/m);
  assert(Object.keys(snippets).length >= 100, 'the common Liquid snippet catalog should remain available');
});

test('every Liquid snippet has valid completion metadata', () => {
  const usedPrefixes = new Set();

  for (const [name, snippet] of Object.entries(snippets)) {
    assert(Array.isArray(snippet.body) && snippet.body.length > 0, `${name} needs a non-empty body`);
    assert(typeof snippet.description === 'string' && snippet.description.trim(), `${name} needs a description`);

    const snippetPrefixes = prefixes(snippet);
    assert(snippetPrefixes.length > 0, `${name} needs a prefix`);
    for (const prefix of snippetPrefixes) {
      assert(typeof prefix === 'string' && prefix.length > 0, `${name} has an empty prefix`);
      assert(!prefix.includes(' '), `${name} has a prefix containing spaces`);
      assert(!usedPrefixes.has(prefix), `duplicate Liquid snippet prefix: ${prefix}`);
      usedPrefixes.add(prefix);
    }

    for (const line of snippet.body) {
      assert.equal(typeof line, 'string', `${name} body lines must be strings`);
      assert.doesNotMatch(line, /(^|[^$])\$(?!\d|\{\d)/, `${name} contains a bare snippet $`);
    }
  }
});

test('core control-flow prefixes expand to complete Liquid blocks', () => {
  const expectedBlocks = {
    if: ['if', 'endif'],
    unless: ['unless', 'endunless'],
    for: ['for', 'endfor'],
    capture: ['capture', 'endcapture'],
    'case/when': ['case', 'endcase'],
  };

  for (const [name, [prefix, closingTag]] of Object.entries(expectedBlocks)) {
    const snippet = snippets[name];
    assert(snippet, `missing core snippet: ${name}`);
    assert(prefixes(snippet).includes(prefix), `${name} must be directly triggerable`);
    assert.match(body(snippet), new RegExp(`{%\\s*${closingTag}\\s*%}`));
    assert.match(body(snippet), /\$0/);
  }
});

test('Liquid output and Shopify authoring snippets remain available', () => {
  for (const name of ['output variable', 'render', 'section', 'content_for block', 'schema', 'content_for_header']) {
    assert(snippets[name], `missing Shopify snippet: ${name}`);
  }
  assert.match(body(snippets['output variable']), /\{\{/);
  assert.match(body(snippets.render), /\{%\s*render/);
  assert.match(body(snippets.schema), /\{%\s*schema/);
});
