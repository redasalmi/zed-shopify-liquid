'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const {
  analyzeLiquidDocument,
  reusableAnalysis,
} = require('../../language-server/liquid-document-analysis.cjs');

function comparableAnalysis(analysis) {
  return {
    rawTags: analysis.rawTags.map((node) => ({
      name: node.name,
      position: node.position,
      body: node.body.position,
    })),
    liquidExpressionRanges: analysis.liquidExpressionRanges,
  };
}

function boundaries(source) {
  const result = [0];
  for (let offset = 1; offset <= source.length; offset += 1) {
    const code = source.charCodeAt(offset);
    if (!(code >= 0xdc00 && code <= 0xdfff)) result.push(offset);
  }
  return result;
}

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

test('reused incremental analysis matches a clean parse', () => {
  const random = randomGenerator(0x5eedc0de);
  const insertions = ['', 'x', 'é', '🛍️', '\r\n', 'settings', '{{', '%}', ' plain text '];
  let source = `<p>Crème 🛍️</p>\r\n
{% comment %}ignored{% endcomment %}
{{ block.settings.heading }}
{% javascript %}
const value = 1;
document.querySelector('main');
{% endjavascript %}
{% stylesheet %}
:root { --brand: red; }
{% endstylesheet %}
{% schema %}
{"blocks":[{"type":"x","settings":[{"type":"text","id":"heading"}]}]}
{% endschema %}`;
  let document = TextDocument.create('file:///theme/sections/differential.liquid', 'liquid', 1, source);
  let analysis = analyzeLiquidDocument(source);
  let reuseCount = 0;

  for (let version = 2; version <= 502; version += 1) {
    const validBoundaries = boundaries(source);
    const startIndex = Math.floor(random() * validBoundaries.length);
    const maximumEndIndex = Math.min(validBoundaries.length - 1, startIndex + 4);
    const endIndex = startIndex + Math.floor(random() * (maximumEndIndex - startIndex + 1));
    const start = validBoundaries[startIndex];
    const end = validBoundaries[endIndex];
    const text = insertions[Math.floor(random() * insertions.length)];
    const contentChange = {
      range: { start: document.positionAt(start), end: document.positionAt(end) },
      text,
    };
    const previousDocument = TextDocument.create(
      document.uri,
      document.languageId,
      document.version,
      document.getText(),
    );
    document = TextDocument.update(document, [contentChange], version);
    source = document.getText();

    const reused = reusableAnalysis(
      { ...analysis, rawTags: analysis.rawTags, liquidExpressionRanges: analysis.liquidExpressionRanges },
      { previousDocument, changes: [contentChange] },
    );
    const clean = analyzeLiquidDocument(source);
    if (reused) {
      reuseCount += 1;
      assert.deepEqual(
        comparableAnalysis(reused.analysis),
        comparableAnalysis(clean),
        `incremental analysis diverged at version ${version}`,
      );
    }
    analysis = clean;
  }

  assert(reuseCount >= 100, `expected substantial reuse, got ${reuseCount} edits`);
});
