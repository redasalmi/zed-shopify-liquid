'use strict';

function embeddedLanguage(source, tagName, rawTags, enabled = true) {
  // Shopify allows one bundled asset tag of each kind per file. Analyze only
  // the first one so invalid duplicate tags cannot be merged into one virtual
  // program or stylesheet with misleading cross-block semantics.
  const ranges = (enabled ? rawTags.filter((node) => node.name === tagName).slice(0, 1) : []).map(
    (node) => ({
      start: node.body.position.start,
      end: node.body.position.end,
      containerStart: node.position.start,
      containerEnd: node.position.end,
    }),
  );
  // Shopify's parser knows which Liquid raw tags own their bodies, so tags in
  // comments, raw content, and documentation examples cannot become false
  // embedded-language regions. Preserve UTF-16 offsets and line endings so
  // virtual-service ranges map directly back to Liquid.
  return {
    documentSource: ranges.length > 0 ? source : null,
    source: ranges.length > 0 ? null : '',
    ranges,
    wrapInFunction: tagName === 'javascript',
  };
}

function embeddedJavaScript(source, rawTags, enabled) {
  return embeddedLanguage(source, 'javascript', rawTags, enabled);
}

function embeddedStylesheet(source, rawTags, enabled) {
  return embeddedLanguage(source, 'stylesheet', rawTags, enabled);
}

function changesLineStructure(documentChange, ranges) {
  if (!documentChange?.changes?.length || !documentChange.previousDocument) return false;

  return documentChange.changes.some((change) => {
    if (!change.range) return ranges.length > 0;
    const start = documentChange.previousDocument.offsetAt(change.range.start);
    if (!ranges.some((range) => start < range.end)) return false;
    if (/[\r\n]/.test(change.text) || change.range.start.line !== change.range.end.line) {
      return true;
    }
    const end = documentChange.previousDocument.offsetAt(change.range.end);
    return /[\r\n]/.test(documentChange.previousDocument.getText().slice(start, end));
  });
}

function sameEmbeddedLanguage(left, right, documentChange) {
  if (
    left.ranges.length !== right.ranges.length ||
    changesLineStructure(documentChange, left.ranges)
  ) {
    return false;
  }
  if (!left.ranges.every((range, index) => {
    const candidate = right.ranges[index];
    return range.start === candidate.start && range.end === candidate.end;
  })) {
    return false;
  }

  const changes = documentChange?.changes;
  if (changes?.length > 0 && documentChange.previousDocument) {
    // When an incremental edit leaves every embedded range at the same source
    // offset and does not touch a range, the virtual document is unchanged.
    // Avoid rescanning the complete CSS/JavaScript block in that common case.
    return changes.every((change) => {
      if (!change.range) return false;
      const start = documentChange.previousDocument.offsetAt(change.range.start);
      const end = documentChange.previousDocument.offsetAt(change.range.end);
      return !left.ranges.some((range) =>
        start < range.end && end > range.start ||
        start === end && start >= range.start && start <= range.end,
      );
    });
  }

  if (changes?.length === 0 || documentChange?.previousDocument?.getText() === right.documentSource) {
    return true;
  }

  for (const range of left.ranges) {
    for (let offset = range.start; offset < range.end; offset += 1) {
      if (left.documentSource.charCodeAt(offset) !== right.documentSource.charCodeAt(offset)) {
        return false;
      }
    }
  }
  return true;
}

function maskSource(source) {
  return source.replace(/[^\r\n]+/g, (line) => ' '.repeat(line.length));
}

function injectAtStart(source, text) {
  const masked = maskSource(source);
  return text.length <= masked.length ? text + masked.slice(text.length) : masked;
}

function injectAtEnd(source, text) {
  const masked = maskSource(source);
  return text.length <= masked.length
    ? masked.slice(0, masked.length - text.length) + text
    : masked;
}

function embeddedSource(embedded) {
  if (embedded.source !== null) return embedded.source;

  const segments = [];
  let cursor = 0;
  for (const range of embedded.ranges) {
    segments.push(maskSource(embedded.documentSource.slice(cursor, range.containerStart)));
    const opening = embedded.documentSource.slice(range.containerStart, range.start);
    const body = embedded.documentSource.slice(range.start, range.end);
    const closing = embedded.documentSource.slice(range.end, range.containerEnd);
    if (embedded.wrapInFunction) {
      // Shopify evaluates bundled JavaScript inside an anonymous function. The
      // injected tokens replace masked tag characters one-for-one, preserving
      // every source offset used by TypeScript and the LSP.
      segments.push(injectAtStart(opening, '(function(){'));
      segments.push(body);
      segments.push(injectAtEnd(closing, '})()'));
    } else {
      segments.push(maskSource(opening));
      segments.push(body);
      segments.push(maskSource(closing));
    }
    cursor = range.containerEnd;
  }
  segments.push(maskSource(embedded.documentSource.slice(cursor)));
  embedded.source = segments.join('');
  return embedded.source;
}

function updateEmbeddedSource(previous, embedded, bodyChange) {
  if (!bodyChange || previous?.source == null ||
      previous.source.length !== previous.documentSource?.length) return;
  const { start, end, text } = bodyChange;
  if (containsSpan(previous.ranges, start, end) && embedded.ranges.length > 0) {
    // A parser-verified raw-body edit can splice the existing masked document;
    // no need to remask the surrounding HTML/Liquid on every keystroke.
    embedded.source = previous.source.slice(0, start) + text + previous.source.slice(end);
  }
}

function containsOffset(ranges, offset) {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function containsSpan(ranges, start, end) {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function intersectingRanges(ranges, start, end) {
  return ranges
    .map((range) => ({ start: Math.max(range.start, start), end: Math.min(range.end, end) }))
    .filter((range) => range.start < range.end);
}

module.exports = {
  changesLineStructure,
  containsOffset,
  containsSpan,
  embeddedJavaScript,
  embeddedSource,
  embeddedStylesheet,
  intersectingRanges,
  sameEmbeddedLanguage,
  updateEmbeddedSource,
};
