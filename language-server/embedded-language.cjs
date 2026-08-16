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

function sameEmbeddedLanguage(left, right) {
  if (left.ranges.length !== right.ranges.length) return false;
  return left.ranges.every((range, index) => {
    const candidate = right.ranges[index];
    if (range.start !== candidate.start || range.end !== candidate.end) return false;
    for (let offset = range.start; offset < range.end; offset += 1) {
      if (left.documentSource.charCodeAt(offset) !== right.documentSource.charCodeAt(offset)) {
        return false;
      }
    }
    return true;
  });
}

function maskSource(source) {
  return source.replace(/[^\r\n]/g, ' ');
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
  containsOffset,
  containsSpan,
  embeddedJavaScript,
  embeddedSource,
  embeddedStylesheet,
  intersectingRanges,
  sameEmbeddedLanguage,
};
