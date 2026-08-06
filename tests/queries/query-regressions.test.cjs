'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');
const grammarRoot = path.dirname(require.resolve('tree-sitter-liquid/package.json'));
const fixturePath = path.join(__dirname, 'fixtures/modern.liquid');
const fixture = readFileSync(fixturePath, 'utf8');
const treeSitterCli = require.resolve('tree-sitter-cli/cli.js');

assert.match(fixture, /^[\x00-\x7F]*$/, 'position conversion assumes an ASCII fixture');

function offsetAt(row, column) {
  const lines = fixture.split('\n');
  return lines.slice(0, row).reduce((total, line) => total + line.length + 1, 0) + column;
}

function runQuery(name) {
  const queryPath = path.join(repositoryRoot, `languages/liquid/${name}.scm`);
  const result = spawnSync(
    process.execPath,
    [treeSitterCli, 'query', queryPath, fixturePath, '--captures'],
    { cwd: grammarRoot, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `${name}.scm did not compile or execute:\n${result.stderr || result.stdout}`,
  );

  const captures = [];
  const capturePattern =
    /capture:\s+\d+\s+-\s+([^,\s]+), start: \((\d+), (\d+)\), end: \((\d+), (\d+)\)/g;
  for (const match of result.stdout.matchAll(capturePattern)) {
    const start = offsetAt(Number(match[2]), Number(match[3]));
    const end = offsetAt(Number(match[4]), Number(match[5]));
    captures.push({ name: match[1], text: fixture.slice(start, end) });
  }
  assert(captures.length > 0, `${name}.scm returned no captures`);
  return captures;
}

function assertCapture(captures, name, expected, { contains = false, trim = false } = {}) {
  const matching = captures.filter((capture) => capture.name === name);
  const expectedText = trim ? expected.trim() : expected;
  const found = matching.some((capture) => {
    const actual = trim ? capture.text.trim() : capture.text;
    return contains ? actual.includes(expectedText) : actual === expectedText;
  });
  assert(
    found,
    `missing @${name} capture for ${JSON.stringify(expected)}; got ${JSON.stringify(
      matching.map((capture) => capture.text),
    )}`,
  );
}

test('highlight captures preserve modern Liquid and LiquidDoc semantics', () => {
  const captures = runQuery('highlights');
  assertCapture(captures, 'keyword', '@prompt');
  assertCapture(captures, 'string', 'Keep this concise for merchants.', { contains: true });
  assertCapture(captures, 'type', '{product}');
  assertCapture(captures, 'variable.parameter', 'type');
  assertCapture(captures, 'variable.parameter', 'variant');
  assertCapture(captures, 'keyword.import', 'render');
  assertCapture(captures, 'keyword', 'content_for');
  assertCapture(captures, 'property', 'available');
  assertCapture(captures, 'property', 'title');
});

test('injection captures preserve embedded language boundaries', () => {
  const captures = runQuery('injections');
  assertCapture(captures, 'injection.content', 'title: Query fixture', { contains: true });
  assertCapture(captures, 'injection.content', 'Query-only comment.', { contains: true });
  assertCapture(captures, 'injection.content', '<div class="product-card">', {
    contains: true,
  });
  assertCapture(captures, 'injection.content', '.button { color: red; }', { contains: true });
  assertCapture(captures, 'injection.content', '.deep-button { color: blue; }', { contains: true });
  assertCapture(captures, 'injection.content', 'document.querySelector', { contains: true });
  assertCapture(captures, 'injection.content', '"settings":[]', { contains: true });

  const query = readFileSync(path.join(repositoryRoot, 'languages/liquid/injections.scm'), 'utf8');
  for (const language of ['html', 'javascript', 'json', 'css', 'yaml', 'comment', 'liquid']) {
    assert.match(query, new RegExp(`injection\\.language "${language}"`));
  }
});

test('indent captures preserve indentation and folding boundaries', () => {
  const captures = runQuery('indents');
  assertCapture(captures, 'start', 'for');
  assertCapture(captures, 'end', 'endfor');
  assertCapture(captures, 'start', 'if');
  assertCapture(captures, 'start', 'else');
  assertCapture(captures, 'end', 'endif');
  assertCapture(
    captures,
    'indent',
    `{% for variant in product.variants %}
  {{ variant.title }}
{% endfor %}`,
    { trim: true },
  );
  assertCapture(
    captures,
    'indent',
    `{% if product.available %}
  <div class="product-card">{{ product.title }}</div>
{% else %}
  <p>Unavailable</p>
{% endif %}`,
    { trim: true },
  );
  assertCapture(
    captures,
    'indent',
    `{% stylesheet %}
.button { color: red; }
{% endstylesheet %}`,
    { trim: true },
  );
  assertCapture(
    captures,
    'indent',
    `{% javascript %}
const banner = document.querySelector('.product-card');
{% endjavascript %}`,
    { trim: true },
  );
  assertCapture(
    captures,
    'indent',
    `{% schema %}
{"name":"Product card","settings":[]}
{% endschema %}`,
    { trim: true },
  );
  assertCapture(captures, 'indent', '@prompt', { contains: true });
});

test('outline captures preserve composition and control-flow landmarks', () => {
  const captures = runQuery('outline');
  assertCapture(captures, 'context', 'render');
  assertCapture(captures, 'name', "'card'");
  assertCapture(captures, 'context', 'content_for');
  assertCapture(captures, 'name', "'hero'");
  assertCapture(captures, 'context', 'assign');
  assertCapture(captures, 'name', 'card_title');
  assertCapture(captures, 'context', 'for');
  assertCapture(captures, 'name', 'variant');
  assertCapture(captures, 'name', 'product.available');
  assertCapture(captures, 'name', 'stylesheet');
  assertCapture(captures, 'name', 'javascript');
  assertCapture(captures, 'name', 'schema');
});
