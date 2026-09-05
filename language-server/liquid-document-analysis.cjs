'use strict';

let liquidParser;

function ensureLiquidParser() {
  if (!liquidParser) liquidParser = require('@shopify/liquid-html-parser');
  return liquidParser;
}

function needsLiquidAnalysis(source) {
  return /{%-?\s*(?:comment|raw|doc|javascript|stylesheet|schema)\b/.test(source) ||
    /\b(?:section|block)\.settings\b/.test(source);
}

function analyzeLiquidDocument(source) {
  const rawTags = [];
  const liquidExpressionRanges = [];
  const settingReferences = [];
  let analysisReusable = true;
  if (!needsLiquidAnalysis(source)) {
    return { rawTags, liquidExpressionRanges, settingReferences, analysisReusable, analysisSkipped: true };
  }

  try {
    const { NodeTypes, toTolerantLiquidHtmlAST, walk } = ensureLiquidParser();
    const ast = toTolerantLiquidHtmlAST(source);
    walk(ast, (node) => {
      if (node.type === NodeTypes.LiquidErrorNode || node.reason) analysisReusable = false;
      if (
        node.type === NodeTypes.LiquidRawTag &&
        typeof node.name === 'string' &&
        node.body?.position
      ) {
        rawTags.push({
          name: node.name,
          position: { ...node.position },
          body: { position: { ...node.body.position } },
        });
        return;
      }

      if (
        node.type === NodeTypes.VariableLookup &&
        (node.name === 'section' || node.name === 'block') &&
        node.lookups[0]?.type === NodeTypes.String &&
        node.lookups[0].value === 'settings' &&
        node.lookups[1]?.type === NodeTypes.String
      ) {
        settingReferences.push({
          objectName: node.name,
          id: node.lookups[1].value,
          ...node.lookups[1].position,
        });
      }

      const isVariableOutput = node.type === NodeTypes.LiquidVariableOutput;
      const isExpressionTag =
        node.type === NodeTypes.LiquidTag && node.name !== 'liquid' && node.name !== '#';
      const isConditionalBranch = node.type === NodeTypes.LiquidBranch && node.name !== null;
      if (
        (isVariableOutput || isExpressionTag || isConditionalBranch) &&
        node.markupPosition
      ) {
        liquidExpressionRanges.push({ ...node.markupPosition });
      }
    });
    const rawOpeningPattern = /{%-?\s*(?:comment|raw|doc|javascript|stylesheet|schema)\b/g;
    for (const match of source.matchAll(rawOpeningPattern)) {
      if (
        !rawTags.some(
          (node) => match.index >= node.position.start && match.index < node.position.end,
        )
      ) {
        analysisReusable = false;
        break;
      }
    }
  } catch (_error) {
    // Incomplete documents can still fail tolerant parsing. Semantic providers
    // should not treat arbitrary text as Liquid or an embedded language then.
    analysisReusable = false;
  }
  const outsideRawBody = (range) => !rawTags.some((node) =>
    range.start >= node.body.position.start && range.end <= node.body.position.end,
  );
  return {
    rawTags,
    liquidExpressionRanges: liquidExpressionRanges.filter(outsideRawBody),
    settingReferences: settingReferences.filter(outsideRawBody),
    analysisReusable,
  };
}

function rawTagNodes(source) {
  return analyzeLiquidDocument(source).rawTags;
}

function referencesInSource(source) {
  const references = [];
  try {
    const { NodeTypes, toTolerantLiquidHtmlAST, walk } = ensureLiquidParser();
    const ast = toTolerantLiquidHtmlAST(source);

    walk(ast, (node) => {
      if (node.type === NodeTypes.LiquidVariableOutput) {
        const markup = node.markup;
        if (
          markup &&
          typeof markup !== 'string' &&
          markup.expression?.type === NodeTypes.String &&
          markup.filters?.[0]?.name === 'asset_url'
        ) {
          references.push({
            category: 'assets',
            name: markup.expression.value,
            start: markup.expression.position.start,
            end: markup.expression.position.end,
          });
        }
        return;
      }
      if (node.type !== NodeTypes.LiquidTag || typeof node.markup === 'string') return;

      let category;
      let target;
      if ((node.name === 'render' || node.name === 'include') && node.markup.snippet) {
        category = 'snippets';
        target = node.markup.snippet;
      } else if (node.name === 'section' && node.markup.name) {
        category = 'sections';
        target = node.markup.name;
      } else if (node.name === 'content_for' && node.markup.contentForType?.value === 'block') {
        category = 'blocks';
        target = node.markup.args?.find((argument) => argument.name === 'type')?.value;
      }

      if (category && target?.type === NodeTypes.String) {
        references.push({
          category,
          name: target.value,
          start: target.position.start,
          end: target.position.end,
        });
      }
    });
  } catch (_error) {
    // Incomplete documents can still fail tolerant parsing. Definition requests
    // should simply fall through instead of disrupting the support server.
  }
  return references;
}

function schemaSourceForSource(source, rawTags = rawTagNodes(source)) {
  const schema = rawTags.find((node) => node.name === 'schema');
  if (!schema?.body?.position) return null;
  return source.slice(schema.body.position.start, schema.body.position.end);
}

function parseSchema(source) {
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch (_error) {
    return null;
  }
}

function settingsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (setting) =>
      setting &&
      typeof setting === 'object' &&
      typeof setting.id === 'string' &&
      setting.id.length > 0,
  );
}

function reusableAnalysis(previous, change) {
  if (
    !previous ||
    previous.analysisReusable === false ||
    !change ||
    change.changes.length !== 1
  ) {
    return null;
  }
  const [contentChange] = change.changes;
  if (!contentChange.range) return null;

  const start = change.previousDocument.offsetAt(contentChange.range.start);
  const end = change.previousDocument.offsetAt(contentChange.range.end);
  const source = change.previousDocument.getText();
  if (previous.analysisSkipped) {
    // The edit itself need not contain a complete keyword: e.g. inserting the
    // final 't' in javascrip. Recheck the cheap gate before reusing empty state.
    const updated = source.slice(0, start) + contentChange.text + source.slice(end);
    if (needsLiquidAnalysis(updated)) return null;
    return {
      analysis: {
        rawTags: [], liquidExpressionRanges: [], settingReferences: [],
        analysisReusable: true, analysisSkipped: true,
      },
      shiftedRawTagNames: new Set(),
      rawBodyChange: null,
    };
  }
  const removed = source.slice(start, end);
  const bodyTag = previous.rawTags.find(
    (node) =>
      (node.name === 'javascript' || node.name === 'stylesheet') &&
      start >= node.body.position.start && end <= node.body.position.end,
  );
  if (bodyTag) {
    const body = source.slice(bodyTag.body.position.start, bodyTag.body.position.end);
    const updatedBody =
      source.slice(bodyTag.body.position.start, start) + contentChange.text +
      source.slice(end, bodyTag.body.position.end);
    // Keyword edits to an existing pseudo-delimiter and delimiters assembled
    // across edit boundaries must both use the tolerant parser instead.
    if (/{[{%]/.test(body) || /{[{%]/.test(updatedBody)) return null;
  } else if (/[{}%]|settings/.test(removed) || /[{}%]|settings/.test(contentChange.text)) {
    return null;
  }

  const overlapsRange = (range) => start < range.end && end > range.start;
  const touchesRawTag = (range) =>
    start === end ? start > range.start && start < range.end : overlapsRange(range);
  const touchesExpression = (range) =>
    start === end ? start >= range.start && start <= range.end : overlapsRange(range);
  if (
    previous.rawTags.some((node) => node !== bodyTag && touchesRawTag(node.position)) ||
    previous.liquidExpressionRanges.some(touchesExpression)
  ) {
    return null;
  }

  const delta = contentChange.text.length - (end - start);
  const shiftPosition = (position) =>
    position.start >= end
      ? { start: position.start + delta, end: position.end + delta }
      : { ...position };
  const rawTags = previous.rawTags.map((node) => ({
    ...node,
    position: node === bodyTag
      ? { start: node.position.start, end: node.position.end + delta }
      : shiftPosition(node.position),
    body: {
      ...node.body,
      position: node === bodyTag
        ? { start: node.body.position.start, end: node.body.position.end + delta }
        : shiftPosition(node.body.position),
    },
  }));
  const liquidExpressionRanges = previous.liquidExpressionRanges.map(shiftPosition);
  return {
    analysis: {
      rawTags,
      liquidExpressionRanges,
      settingReferences: (previous.settingReferences || []).map((reference) => ({
        ...reference,
        ...shiftPosition(reference),
      })),
      analysisReusable: true,
    },
    rawBodyChange: bodyTag ? { tagName: bodyTag.name, start, end, text: contentChange.text } : null,
    shiftedRawTagNames: new Set(
      delta === 0
        ? []
        : previous.rawTags
            .filter((node) => node.position.start >= end)
            .map((node) => node.name),
    ),
  };
}

module.exports = {
  analyzeLiquidDocument,
  parseSchema,
  rawTagNodes,
  referencesInSource,
  reusableAnalysis,
  schemaSourceForSource,
  settingsFrom,
};
