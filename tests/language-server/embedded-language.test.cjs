'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TextDocument } = require('vscode-languageserver-textdocument');
const {
  embeddedJavaScript,
  sameEmbeddedLanguage,
} = require('../../language-server/embedded-language.cjs');

function rangesFor(source) {
  const open = source.indexOf('{% javascript %}');
  const bodyStart = open + '{% javascript %}'.length;
  const bodyEnd = source.indexOf('{% endjavascript %}', bodyStart);
  const closeEnd = bodyEnd + '{% endjavascript %}'.length;
  return [
    {
      name: 'javascript',
      position: { start: open, end: closeEnd },
      body: { position: { start: bodyStart, end: bodyEnd } },
    },
  ];
}

function documentChange(source, range, text) {
  return {
    previousDocument: TextDocument.create('file:///example.liquid', 'liquid', 1, source),
    changes: [{ range, text }],
  };
}

test('embedded range comparison skips edits outside unchanged ranges', () => {
  const source = '{% javascript %}\nconst value = 1;\n{% endjavascript %}\n';
  const updated = `${source}<!-- unrelated -->\n`;
  const left = embeddedJavaScript(source, rangesFor(source), true);
  const right = embeddedJavaScript(updated, rangesFor(updated), true);
  assert.equal(
    sameEmbeddedLanguage(
      left,
      right,
      documentChange(source, {
        start: { line: 2, character: '{% endjavascript %}'.length },
        end: { line: 2, character: '{% endjavascript %}'.length },
      }, '<!-- unrelated -->\n'),
    ),
    true,
  );
});

test('embedded range comparison invalidates edits inside a range', () => {
  const source = '{% javascript %}\nconst value = 1;\n{% endjavascript %}\n';
  const updated = source.replace('value', 'other');
  const left = embeddedJavaScript(source, rangesFor(source), true);
  const right = embeddedJavaScript(updated, rangesFor(updated), true);
  const start = source.indexOf('value');

  assert.equal(
    sameEmbeddedLanguage(
      left,
      right,
      documentChange(
        source,
        {
          start: { line: 1, character: start - source.indexOf('\n') - 1 },
          end: { line: 1, character: start - source.indexOf('\n') - 1 + 'value'.length },
        },
        'other',
      ),
    ),
    false,
  );
});
