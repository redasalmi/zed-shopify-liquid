'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  CompletionItemKind,
  CompletionItemTag,
  DiagnosticSeverity,
  InsertTextFormat,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const pendingDocumentChanges = new Map();
const documents = new TextDocuments({
  create: (...args) => TextDocument.create(...args),
  update: (document, changes, version) => {
    pendingDocumentChanges.set(document.uri, { previousDocument: document, changes });
    return TextDocument.update(document, changes, version);
  },
});
const statesByUri = new Map();
const statesByFileName = new Map();
const validationTimers = new Map();
const librarySnapshots = new Map();
const configuredTypescriptIdleMilliseconds = Number.parseInt(
  process.env.LIQUID_TYPESCRIPT_IDLE_MS || '',
  10,
);
const typescriptIdleMilliseconds = Number.isFinite(configuredTypescriptIdleMilliseconds)
  ? Math.max(0, configuredTypescriptIdleMilliseconds)
  : 30_000;
const performanceLogging = process.env.LIQUID_PERFORMANCE_LOGGING === '1';
let projectVersion = 0;
let ts;
let compilerOptions;
let cssLanguageService;
let documentRegistry;
let languageService;
let languageServiceIdleTimer;
let liquidDocParamTypesPromise;
let liquidDocLanguageTools;
let liquidParser;
let shuttingDown = false;
let typescriptLibraryRoot;
let workspaceRoots = [];

function terminateAfterUnexpectedFailure(error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (shuttingDown) return;
  shuttingDown = true;
  setImmediate(() => process.exit(1));
}

process.once('uncaughtException', terminateAfterUnexpectedFailure);
process.once('unhandledRejection', terminateAfterUnexpectedFailure);

const BASIC_LIQUID_DOC_PARAM_TYPES = [
  ['string', undefined],
  ['number', undefined],
  ['boolean', undefined],
  ['object', 'A generic type used to represent any Liquid object or primitive value.'],
];
const THEME_DIRECTORIES = new Set([
  'assets',
  'blocks',
  'config',
  'layout',
  'locales',
  'sections',
  'snippets',
  'templates',
]);
const EMBEDDED_THEME_DIRECTORIES = new Set(['blocks', 'sections', 'snippets']);
const LIQUID_DOC_THEME_DIRECTORIES = new Set(['blocks', 'snippets']);

async function readLiquidDocObjects() {
  const docsUpdater = require('@shopify/theme-check-docs-updater');
  const candidates = [
    path.join(docsUpdater.root, 'objects.json'),
    path.join(
      path.dirname(require.resolve('@shopify/theme-check-docs-updater/package.json')),
      'data',
      'objects.json',
    ),
  ];

  for (const candidate of candidates) {
    try {
      const objects = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (Array.isArray(objects)) return objects;
    } catch (_error) {
      // Prefer Shopify's updated cache, then fall back to the object data
      // bundled with the pinned language server package.
    }
  }
  return [];
}

function liquidDocParamTypes() {
  if (!liquidDocParamTypesPromise) {
    liquidDocParamTypesPromise = readLiquidDocObjects().then((objects) => {
      const types = new Map(BASIC_LIQUID_DOC_PARAM_TYPES);
      for (const object of objects) {
        if (typeof object?.name === 'string' && object.name.length > 0) {
          types.set(object.name, object.summary || object.description);
        }
      }
      const arrayTypes = new Map(
        [...types].map(([name, description]) => [
          `${name}[]`,
          description
            ? `Array of ${name} values.\n\n${description}`
            : `Array of ${name} values.`,
        ]),
      );
      return new Map([...types, ...arrayTypes]);
    });
  }
  return liquidDocParamTypesPromise;
}

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function themeRootForStandardFile(fileName, directories) {
  const assetDirectory = path.dirname(fileName);
  if (!directories.has(path.basename(assetDirectory))) return null;
  if (workspaceRoots.length > 0 && !workspaceRoots.some((root) => isWithinDirectory(root, fileName))) {
    return null;
  }

  const possibleThemeRoot = path.dirname(assetDirectory);
  const hasThemeEvidence = ['.theme-check.yml', 'config', 'layout', 'templates'].some((entry) =>
    fsSync.existsSync(path.join(possibleThemeRoot, entry)),
  );
  return hasThemeEvidence ? possibleThemeRoot : null;
}

function fileSupportsLiquidDoc(fileName) {
  return Boolean(themeRootForStandardFile(fileName, LIQUID_DOC_THEME_DIRECTORIES));
}

function fileSupportsEmbeddedAssets(fileName) {
  return Boolean(themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES));
}

function isInsideLiquidDoc(source, offset) {
  const rawTags = rawTagNodes(source);
  const ignoredRanges = rawTags
    .filter((node) => node.name !== 'doc')
    .map((node) => node.position);
  const tagPattern = /{%-?\s*(end)?doc\s*-?%}/g;
  let active = false;
  let match;
  while ((match = tagPattern.exec(source)) !== null && match.index < offset) {
    if (
      ignoredRanges.some(
        (range) => match.index >= range.start && match.index < range.end,
      )
    ) {
      continue;
    }
    active = !match[1];
  }
  return active;
}

function liquidDocTagCompletions(state, offset, context) {
  if (
    context?.triggerCharacter !== '@' ||
    !fileSupportsLiquidDoc(state.sourceFileName || state.fileName)
  ) {
    return null;
  }

  const source = state.document.getText();
  if (!isInsideLiquidDoc(source, offset)) return null;
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  if (!/^\s*@$/.test(source.slice(lineStart, offset))) return null;

  if (!liquidDocLanguageTools) {
    liquidDocLanguageTools = require(
      '@shopify/theme-language-server-common/dist/utils/liquidDoc',
    );
  }
  const { formatLiquidDocTagHandle, SUPPORTED_LIQUID_DOC_TAG_HANDLES } =
    liquidDocLanguageTools;

  return {
    isIncomplete: false,
    items: Object.entries(SUPPORTED_LIQUID_DOC_TAG_HANDLES).map(
      ([label, { description, example, template }]) => ({
        label,
        kind: CompletionItemKind.EnumMember,
        documentation: {
          kind: 'markdown',
          value: formatLiquidDocTagHandle(label, description, example),
        },
        insertText: template,
        insertTextFormat: InsertTextFormat.Snippet,
      }),
    ),
  };
}

async function liquidDocTypeCompletions(state, offset) {
  if (!fileSupportsLiquidDoc(state.sourceFileName || state.fileName)) return null;

  const source = state.document.getText();
  if (!isInsideLiquidDoc(source, offset)) return null;

  const beforeCursor = source.slice(0, offset);
  const currentLine = beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1);
  const typeMatch = /^(\s*@param\s+\{\s*)([a-zA-Z_]*(?:\[\]?)?)$/.exec(currentLine);
  if (!typeMatch) return null;

  // Shopify's provider handles an unfinished opening brace. Supplement the
  // paired-brace form produced by Zed's autoclose behavior.
  if (!/^\s*\}/.test(source.slice(offset))) return null;

  const types = await liquidDocParamTypes();
  const partial = typeMatch[2];
  const partialStart = offset - partial.length;
  return {
    isIncomplete: false,
    items: [...types].map(([label, description]) => {
      const item = {
        label,
        kind: CompletionItemKind.EnumMember,
        detail: 'LiquidDoc parameter type',
        textEdit: {
          range: {
            start: state.document.positionAt(partialStart),
            end: state.document.positionAt(offset),
          },
          newText: label,
        },
      };
      if (description) item.documentation = { kind: 'markdown', value: description };
      return item;
    }),
  };
}

function ensureLiquidParser() {
  if (!liquidParser) liquidParser = require('@shopify/liquid-html-parser');
  return liquidParser;
}

function analyzeLiquidDocument(source) {
  const rawTags = [];
  const liquidExpressionRanges = [];
  if (
    !/{%-?\s*(?:comment|raw|doc|javascript|stylesheet|schema)\b/.test(source) &&
    !/\b(?:section|block)\.settings\b/.test(source)
  ) {
    return { rawTags, liquidExpressionRanges };
  }

  try {
    const { NodeTypes, toTolerantLiquidHtmlAST, walk } = ensureLiquidParser();
    const ast = toTolerantLiquidHtmlAST(source);
    walk(ast, (node) => {
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

      const isVariableOutput = node.type === NodeTypes.LiquidVariableOutput;
      const isExpressionTag =
        node.type === NodeTypes.LiquidTag && node.name !== 'liquid' && node.name !== '#';
      const isConditionalBranch = node.type === NodeTypes.LiquidBranch && node.name !== null;
      if (
        (isVariableOutput || isExpressionTag || isConditionalBranch) &&
        node.markupPosition
      ) {
        liquidExpressionRanges.push(node.markupPosition);
      }
    });
  } catch (_error) {
    // Incomplete documents can still fail tolerant parsing. Semantic providers
    // should not treat arbitrary text as Liquid or an embedded language then.
  }
  return { rawTags, liquidExpressionRanges };
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

function configuredThemeRoot(contents) {
  const match = /^\s*root\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#\r\n]*))\s*(?:#.*)?$/m.exec(
    contents,
  );
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  if (!value || value === '~' || value.toLowerCase() === 'null') return null;
  return value;
}

async function configuredThemeRootForFile(fileName) {
  let directory = path.dirname(fileName);
  while (true) {
    try {
      const contents = await fs.readFile(path.join(directory, '.theme-check.yml'), 'utf8');
      const root = configuredThemeRoot(contents);
      if (root) return path.resolve(directory, root);
    } catch (_error) {
      // Continue toward the workspace root when this directory has no config.
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function themeRootForFile(fileName) {
  const configuredRoot = await configuredThemeRootForFile(fileName);
  if (configuredRoot) return configuredRoot;

  let directory = path.dirname(fileName);
  while (true) {
    if (THEME_DIRECTORIES.has(path.basename(directory))) return path.dirname(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function definitionForReference(state, offset) {
  if (!state.definitionReferences) {
    state.definitionReferences = referencesInSource(state.document.getText());
  }
  const reference = state.definitionReferences.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );
  if (!reference || path.basename(reference.name) !== reference.name) return null;

  let root;
  try {
    root = await themeRootForFile(fileURLToPath(state.document.uri));
  } catch (_error) {
    return null;
  }
  if (!root) return null;

  const candidate = path.join(root, reference.category, `${reference.name}.liquid`);
  try {
    if (!(await fs.stat(candidate)).isFile()) return null;
  } catch (_error) {
    return null;
  }

  return {
    uri: pathToFileURL(candidate).toString(),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
}

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

function fileNameForUri(uri) {
  try {
    return `${fileURLToPath(uri)}.__embedded.js`;
  } catch (_error) {
    return `${uri.replace(/[^a-zA-Z0-9._-]/g, '_')}.__embedded.js`;
  }
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
  if (!previous || !change || change.changes.length !== 1) return null;
  const [contentChange] = change.changes;
  if (!contentChange.range) return null;

  const start = change.previousDocument.offsetAt(contentChange.range.start);
  const end = change.previousDocument.offsetAt(contentChange.range.end);
  const removed = change.previousDocument.getText().slice(start, end);
  if (/[{}%]|settings/.test(removed) || /[{}%]|settings/.test(contentChange.text)) {
    return null;
  }

  const overlapsRange = (range) => start < range.end && end > range.start;
  const touchesRawTag = (range) =>
    start === end ? start > range.start && start < range.end : overlapsRange(range);
  const touchesExpression = (range) =>
    start === end ? start >= range.start && start <= range.end : overlapsRange(range);
  if (
    previous.rawTags.some((node) => touchesRawTag(node.position)) ||
    previous.liquidExpressionRanges.some(touchesExpression)
  ) {
    return null;
  }

  const delta = contentChange.text.length - (end - start);
  const shiftPosition = (position) =>
    position.start >= end
      ? { start: position.start + delta, end: position.end + delta }
      : position;
  const rawTags = previous.rawTags.map((node) => ({
    ...node,
    position: shiftPosition(node.position),
    body: {
      ...node.body,
      position: shiftPosition(node.body.position),
    },
  }));
  const liquidExpressionRanges = previous.liquidExpressionRanges.map(shiftPosition);
  return {
    analysis: { rawTags, liquidExpressionRanges },
    shiftedRawTagNames: new Set(
      delta === 0
        ? []
        : previous.rawTags
            .filter((node) => node.position.start >= end)
            .map((node) => node.name),
    ),
  };
}

function settingsCompletions(state, offset) {
  const match = /\b(section|block)\.settings\.([a-zA-Z0-9_-]*)$/.exec(
    state.document.getText().slice(0, offset),
  );
  const isLiquidExpression = state.liquidExpressionRanges.some(
    (range) => offset >= range.start && offset <= range.end,
  );
  if (!match || !state.schema || !isLiquidExpression) return null;

  const objectName = match[1];
  const partial = match[2];
  const pathName = (state.sourceFileName || state.fileName).replace(/\\/g, '/');
  let settings = [];

  // Shopify's server already completes section settings and settings in Theme
  // Block files. Only supplement its upstream gap for inline blocks declared
  // by traditional section schemas, avoiding duplicate entries in Zed.
  if (
    objectName !== 'block' ||
    !pathName.includes('/sections/') ||
    !themeRootForStandardFile(state.sourceFileName || state.fileName, EMBEDDED_THEME_DIRECTORIES)
  ) {
    return null;
  }

  // The exact block.type cannot always be narrowed statically. Offer the union
  // so every declared block setting remains discoverable; duplicate ids are
  // collapsed below.
  settings = Array.isArray(state.schema.blocks)
    ? state.schema.blocks.flatMap((block) => settingsFrom(block?.settings))
    : [];

  const uniqueSettings = new Map(settings.map((setting) => [setting.id, setting]));
  const items = [...uniqueSettings.values()]
    .filter((setting) => setting.id.startsWith(partial))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((setting) => {
      const item = {
        label: setting.id,
        kind: CompletionItemKind.Property,
      };
      if (typeof setting.type === 'string') item.detail = `Shopify ${setting.type} setting`;
      const documentation = [setting.label, setting.info]
        .filter(
          (value) =>
            typeof value === 'string' && value.length > 0 && !value.startsWith('t:'),
        )
        .join('\n\n');
      if (documentation) item.documentation = documentation;
      return item;
    });

  return { isIncomplete: false, items };
}

function updateState(document, change) {
  const previous = statesByUri.get(document.uri);
  const source = document.getText();
  const analysisReuse = reusableAnalysis(previous, change);
  const analysis = analysisReuse?.analysis || analyzeLiquidDocument(source);
  const rawTags = analysis.rawTags;
  let sourceFileName;
  try {
    sourceFileName = fileURLToPath(document.uri);
  } catch (_error) {
    sourceFileName = document.uri;
  }
  const supportsEmbeddedAssets = fileSupportsEmbeddedAssets(sourceFileName);
  const embedded = embeddedJavaScript(source, rawTags, supportsEmbeddedAssets);
  const stylesheet = embeddedStylesheet(source, rawTags, supportsEmbeddedAssets);
  const schemaSource = schemaSourceForSource(source, rawTags);
  const scriptChanged = previous
    ? analysisReuse
      ? analysisReuse.shiftedRawTagNames.has('javascript')
      : !sameEmbeddedLanguage(previous.embedded, embedded)
    : embedded.ranges.length > 0;
  const stylesheetChanged = previous
    ? analysisReuse
      ? analysisReuse.shiftedRawTagNames.has('stylesheet')
      : !sameEmbeddedLanguage(previous.stylesheet, stylesheet)
    : stylesheet.ranges.length > 0;
  if (previous && !scriptChanged) embedded.source = previous.embedded.source;
  if (previous && !stylesheetChanged) stylesheet.source = previous.stylesheet.source;
  const hadEmbeddedJavaScript = (previous?.embedded.ranges.length ?? 0) > 0;
  const state = {
    document,
    embedded,
    stylesheet,
    sourceFileName,
    fileName: previous?.fileName || fileNameForUri(document.uri),
    rawTags,
    liquidExpressionRanges: analysis.liquidExpressionRanges,
    schema:
      schemaSource === previous?.schemaSource ? previous.schema : parseSchema(schemaSource),
    schemaSource,
    hadEmbeddedJavaScript,
    cssDocument: stylesheetChanged ? undefined : previous?.cssDocument,
    cssStylesheet: stylesheetChanged ? undefined : previous?.cssStylesheet,
    needsValidation: !previous || scriptChanged,
    scriptSnapshot: scriptChanged ? undefined : previous?.scriptSnapshot,
    scriptVersion: (previous?.scriptVersion ?? 0) + (scriptChanged ? 1 : 0),
  };

  statesByUri.set(document.uri, state);
  statesByFileName.set(state.fileName, state);
  if (scriptChanged) projectVersion += 1;
  if (embedded.ranges.length > 0) cancelLanguageServiceDisposal();
  else if (hadEmbeddedJavaScript) scheduleLanguageServiceDisposal();
  return state;
}

function allowedTypeScriptPath(fileName) {
  if (statesByFileName.has(fileName)) return true;
  if (!typescriptLibraryRoot) {
    typescriptLibraryRoot = path.dirname(require.resolve('typescript/lib/typescript.js'));
  }
  return (
    isWithinDirectory(typescriptLibraryRoot, fileName) ||
    workspaceRoots.some((root) => isWithinDirectory(root, fileName))
  );
}

function allowedTypeScriptDirectory(directory) {
  if (!typescriptLibraryRoot) {
    typescriptLibraryRoot = path.dirname(require.resolve('typescript/lib/typescript.js'));
  }
  return [typescriptLibraryRoot, ...workspaceRoots].some(
    (root) => isWithinDirectory(root, directory) || isWithinDirectory(directory, root),
  );
}

const languageServiceHost = {
  getCompilationSettings: () => compilerOptions,
  getScriptFileNames: () =>
    [...statesByUri.values()]
      .filter((state) => state.embedded.ranges.length > 0)
      .map((state) => state.fileName),
  getScriptVersion: (fileName) => String(statesByFileName.get(fileName)?.scriptVersion ?? 0),
  getProjectVersion: () => String(projectVersion),
  getScriptSnapshot: (fileName) => {
    const state = statesByFileName.get(fileName);
    if (state) {
      if (!state.scriptSnapshot) {
        state.scriptSnapshot = ts.ScriptSnapshot.fromString(embeddedSource(state.embedded));
      }
      return state.scriptSnapshot;
    }

    let snapshot = librarySnapshots.get(fileName);
    if (snapshot) return snapshot;
    const contents = ts.sys.readFile(fileName);
    if (contents === undefined) return undefined;
    snapshot = ts.ScriptSnapshot.fromString(contents);
    librarySnapshots.set(fileName, snapshot);
    return snapshot;
  },
  getScriptKind: (fileName) =>
    statesByFileName.has(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.Unknown,
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: (fileName) => allowedTypeScriptPath(fileName) && ts.sys.fileExists(fileName),
  readFile: (fileName) =>
    allowedTypeScriptPath(fileName) ? ts.sys.readFile(fileName) : undefined,
  readDirectory: (directory, ...args) =>
    allowedTypeScriptDirectory(directory) ? ts.sys.readDirectory(directory, ...args) : [],
  directoryExists: (directory) =>
    allowedTypeScriptDirectory(directory) && ts.sys.directoryExists(directory),
  getDirectories: (directory) =>
    allowedTypeScriptDirectory(directory) ? ts.sys.getDirectories(directory) : [],
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getNewLine: () => ts.sys.newLine,
};

// One incremental service is shared by all open Liquid documents. Creating a
// service per request repeatedly parsed the DOM libraries and allowed the
// document registry to retain hundreds of megabytes of duplicate programs.
// Load TypeScript lazily so themes without open JavaScript blocks pay almost no
// memory or startup cost for this optional server.
function hasEmbeddedJavaScriptDocuments() {
  return [...statesByUri.values()].some((state) => state.embedded.ranges.length > 0);
}

function cancelLanguageServiceDisposal() {
  clearTimeout(languageServiceIdleTimer);
  languageServiceIdleTimer = undefined;
}

function disposeLanguageService() {
  languageService?.dispose();
  languageService = undefined;
  documentRegistry = undefined;
  compilerOptions = undefined;
  librarySnapshots.clear();
  languageServiceIdleTimer = undefined;
  if (performanceLogging) connection.console.info('TypeScript language service disposed');
}

function scheduleLanguageServiceDisposal() {
  if (!languageService || hasEmbeddedJavaScriptDocuments()) return;
  cancelLanguageServiceDisposal();
  languageServiceIdleTimer = setTimeout(() => {
    if (!hasEmbeddedJavaScriptDocuments()) disposeLanguageService();
  }, typescriptIdleMilliseconds);
  languageServiceIdleTimer.unref?.();
}

function ensureLanguageService() {
  cancelLanguageServiceDisposal();
  if (languageService) return languageService;

  ts = require('typescript');
  compilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    noEmit: true,
  };
  documentRegistry = ts.createDocumentRegistry();
  languageService = ts.createLanguageService(languageServiceHost, documentRegistry);
  return languageService;
}

function rangeForSpan(document, span) {
  return {
    start: document.positionAt(span.start),
    end: document.positionAt(span.start + span.length),
  };
}

function ensureCssLanguageService() {
  if (!cssLanguageService) {
    const { getCSSLanguageService } = require('vscode-css-languageservice');
    cssLanguageService = getCSSLanguageService();
  }
  return cssLanguageService;
}

function cssDocument(state) {
  if (!state.cssDocument) {
    state.cssDocument = TextDocument.create(
      state.document.uri,
      'css',
      state.document.version,
      embeddedSource(state.stylesheet),
    );
  }
  return state.cssDocument;
}

function javascriptDefinitions(state, offset) {
  if (!containsOffset(state.embedded.ranges, offset)) return null;

  const definitions = ensureLanguageService().getDefinitionAtPosition(state.fileName, offset);
  if (!definitions) return null;

  const locations = definitions.flatMap((definition) => {
    const targetState = statesByFileName.get(definition.fileName);
    const end = definition.textSpan.start + definition.textSpan.length;
    if (!targetState || !containsSpan(targetState.embedded.ranges, definition.textSpan.start, end)) {
      return [];
    }
    return [
      {
        uri: targetState.document.uri,
        range: rangeForSpan(targetState.document, definition.textSpan),
      },
    ];
  });
  return locations.length > 0 ? locations : null;
}

function stylesheetDefinition(state, offset) {
  if (!containsOffset(state.stylesheet.ranges, offset)) return null;

  const document = cssDocument(state);
  const service = ensureCssLanguageService();
  if (!state.cssStylesheet) state.cssStylesheet = service.parseStylesheet(document);
  const definition = service.findDefinition(
    document,
    document.positionAt(offset),
    state.cssStylesheet,
  );
  if (!definition || definition.uri !== state.document.uri) return null;

  const start = document.offsetAt(definition.range.start);
  const end = document.offsetAt(definition.range.end);
  return containsSpan(state.stylesheet.ranges, start, end) ? definition : null;
}

function intersectingRanges(ranges, start, end) {
  return ranges
    .map((range) => ({ start: Math.max(range.start, start), end: Math.min(range.end, end) }))
    .filter((range) => range.start < range.end);
}

function embeddedRangeFormatting(state, params) {
  const requestedStart = state.document.offsetAt(params.range.start);
  const requestedEnd = state.document.offsetAt(params.range.end);
  const edits = [];

  const scriptRanges = intersectingRanges(state.embedded.ranges, requestedStart, requestedEnd);
  if (scriptRanges.length > 0) {
    const service = ensureLanguageService();
    const options = {
      ...ts.getDefaultFormatCodeSettings(state.document.getText().includes('\r\n') ? '\r\n' : '\n'),
      indentSize: params.options.tabSize,
      tabSize: params.options.tabSize,
      convertTabsToSpaces: params.options.insertSpaces,
    };
    for (const range of scriptRanges) {
      const changes = service.getFormattingEditsForRange(
        state.fileName,
        range.start,
        range.end,
        options,
      );
      for (const change of changes) {
        const end = change.span.start + change.span.length;
        if (containsSpan(state.embedded.ranges, change.span.start, end)) {
          edits.push({
            range: rangeForSpan(state.document, change.span),
            newText: change.newText,
          });
        }
      }
    }
  }

  const styleRanges = intersectingRanges(state.stylesheet.ranges, requestedStart, requestedEnd);
  if (styleRanges.length > 0) {
    const document = cssDocument(state);
    const service = ensureCssLanguageService();
    const source = state.document.getText();
    for (const range of styleRanges) {
      while (range.start < range.end && /\s/.test(source[range.start])) range.start += 1;
      while (range.end > range.start && /\s/.test(source[range.end - 1])) range.end -= 1;
      if (range.start === range.end) continue;

      const changes = service.format(
        document,
        { start: document.positionAt(range.start), end: document.positionAt(range.end) },
        params.options,
      );
      for (const change of changes) {
        const start = document.offsetAt(change.range.start);
        const end = document.offsetAt(change.range.end);
        if (containsSpan(state.stylesheet.ranges, start, end)) edits.push(change);
      }
    }
  }

  return edits;
}

function completionKind(kind) {
  switch (kind) {
    case ts.ScriptElementKind.classElement:
      return CompletionItemKind.Class;
    case ts.ScriptElementKind.constElement:
      return CompletionItemKind.Constant;
    case ts.ScriptElementKind.constructorImplementationElement:
      return CompletionItemKind.Constructor;
    case ts.ScriptElementKind.enumElement:
      return CompletionItemKind.Enum;
    case ts.ScriptElementKind.enumMemberElement:
      return CompletionItemKind.EnumMember;
    case ts.ScriptElementKind.functionElement:
      return CompletionItemKind.Function;
    case ts.ScriptElementKind.interfaceElement:
      return CompletionItemKind.Interface;
    case ts.ScriptElementKind.keyword:
      return CompletionItemKind.Keyword;
    case ts.ScriptElementKind.letElement:
    case ts.ScriptElementKind.variableElement:
      return CompletionItemKind.Variable;
    case ts.ScriptElementKind.memberFunctionElement:
    case ts.ScriptElementKind.methodElement:
      return CompletionItemKind.Method;
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return CompletionItemKind.Property;
    case ts.ScriptElementKind.moduleElement:
      return CompletionItemKind.Module;
    case ts.ScriptElementKind.string:
      return CompletionItemKind.Value;
    case ts.ScriptElementKind.typeElement:
    case ts.ScriptElementKind.typeParameterElement:
      return CompletionItemKind.TypeParameter;
    default:
      return CompletionItemKind.Text;
  }
}

function diagnosticSeverity(category) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return DiagnosticSeverity.Error;
    case ts.DiagnosticCategory.Warning:
      return DiagnosticSeverity.Warning;
    case ts.DiagnosticCategory.Suggestion:
      return DiagnosticSeverity.Information;
    default:
      return DiagnosticSeverity.Hint;
  }
}

function validate(uri) {
  const state = statesByUri.get(uri);
  if (!state || state.embedded.ranges.length === 0) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const service = ensureLanguageService();
  const diagnostics = [
    ...service.getSyntacticDiagnostics(state.fileName),
    ...service.getSemanticDiagnostics(state.fileName),
    ...service.getSuggestionDiagnostics(state.fileName),
  ]
    .filter(
      (diagnostic) =>
        diagnostic.start !== undefined &&
        diagnostic.length !== undefined &&
        containsOffset(state.embedded.ranges, diagnostic.start) &&
        containsSpan(
          state.embedded.ranges,
          diagnostic.start,
          diagnostic.start + diagnostic.length,
        ),
    )
    .map((diagnostic) => ({
      range: rangeForSpan(state.document, {
        start: diagnostic.start,
        length: diagnostic.length,
      }),
      severity: diagnosticSeverity(diagnostic.category),
      code: diagnostic.code,
      source: 'typescript',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));

  connection.sendDiagnostics({ uri, diagnostics });
}

function scheduleValidation(state) {
  if (state.embedded.ranges.length === 0) {
    if (state.hadEmbeddedJavaScript) {
      clearTimeout(validationTimers.get(state.document.uri));
      validationTimers.delete(state.document.uri);
      connection.sendDiagnostics({ uri: state.document.uri, diagnostics: [] });
    }
    return;
  }
  if (!state.needsValidation) return;

  clearTimeout(validationTimers.get(state.document.uri));
  validationTimers.set(
    state.document.uri,
    setTimeout(() => {
      validationTimers.delete(state.document.uri);
      try {
        validate(state.document.uri);
      } catch (error) {
        connection.console.error(String(error));
        connection.sendDiagnostics({ uri: state.document.uri, diagnostics: [] });
      }
    }, 350),
  );
}

connection.onInitialize((params) => {
  const rootUris = [
    ...(params.workspaceFolders || []).map((folder) => folder.uri),
    params.rootUri,
  ].filter(Boolean);
  workspaceRoots = rootUris.flatMap((uri) => {
    try {
      return [fileURLToPath(uri)];
    } catch (_error) {
      return [];
    }
  });

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.', '"', "'", '{', '@'],
      },
      definitionProvider: true,
      documentRangeFormattingProvider: true,
      hoverProvider: true,
    },
    serverInfo: {
      name: 'liquid-embedded-support',
      version: process.env.LIQUID_EXTENSION_VERSION || 'development',
    },
  };
});

connection.onCompletion(async (params, cancellationToken) => {
  const uri = params.textDocument.uri;
  const state = statesByUri.get(uri);
  if (!state || cancellationToken.isCancellationRequested) return null;

  const offset = state.document.offsetAt(params.position);
  const settingResults = settingsCompletions(state, offset);
  if (settingResults) return settingResults;
  const liquidDocTagResults = liquidDocTagCompletions(state, offset, params.context);
  if (liquidDocTagResults) return liquidDocTagResults;
  const liquidDocTypeResults = await liquidDocTypeCompletions(state, offset);
  if (
    cancellationToken.isCancellationRequested ||
    statesByUri.get(uri) !== state
  ) {
    return null;
  }
  if (liquidDocTypeResults) return liquidDocTypeResults;
  if (!containsOffset(state.embedded.ranges, offset)) return null;

  const result = ensureLanguageService().getCompletionsAtPosition(state.fileName, offset, {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: true,
  });
  if (!result) return null;

  return {
    isIncomplete: false,
    items: result.entries.map((entry) => {
      const item = {
        label: entry.name,
        kind: completionKind(entry.kind),
        sortText: entry.sortText,
        data: {
          provider: 'typescript',
          uri,
          version: state.document.version,
          offset,
          name: entry.name,
          source: entry.source,
          entryData: entry.data,
        },
      };
      if (entry.insertText) item.insertText = entry.insertText;
      if (entry.isSnippet) item.insertTextFormat = InsertTextFormat.Snippet;
      if (
        entry.replacementSpan &&
        containsSpan(
          state.embedded.ranges,
          entry.replacementSpan.start,
          entry.replacementSpan.start + entry.replacementSpan.length,
        )
      ) {
        item.textEdit = {
          range: rangeForSpan(state.document, entry.replacementSpan),
          newText: entry.insertText || entry.name,
        };
      }
      return item;
    }),
  };
});

connection.onCompletionResolve((item, cancellationToken) => {
  const data = item.data;
  if (data?.provider !== 'typescript' || cancellationToken.isCancellationRequested) return item;
  const state = statesByUri.get(data.uri);
  if (!state || state.document.version !== data.version) return item;

  const details = ensureLanguageService().getCompletionEntryDetails(
    state.fileName,
    data.offset,
    data.name,
    undefined,
    data.source,
    undefined,
    data.entryData,
  );
  if (!details) return item;

  const detail = ts.displayPartsToString(details.displayParts);
  const documentation = ts.displayPartsToString(details.documentation);
  const tags = (details.tags || [])
    .map((tag) => {
      const text = ts.displayPartsToString(tag.text);
      return text ? `**@${tag.name}** — ${text}` : `**@${tag.name}**`;
    })
    .join('\n\n');
  if (detail) item.detail = detail;
  if (documentation || tags) {
    item.documentation = {
      kind: 'markdown',
      value: [documentation, tags].filter(Boolean).join('\n\n'),
    };
  }
  if (details.tags?.some((tag) => tag.name === 'deprecated')) {
    item.tags = [CompletionItemTag.Deprecated];
  }
  return item;
});

connection.onDefinition(async (params, cancellationToken) => {
  const uri = params.textDocument.uri;
  const state = statesByUri.get(uri);
  if (!state || cancellationToken.isCancellationRequested) return null;

  const offset = state.document.offsetAt(params.position);
  const embeddedDefinition =
    javascriptDefinitions(state, offset) ?? stylesheetDefinition(state, offset);
  if (embeddedDefinition) return embeddedDefinition;

  const definition = await definitionForReference(state, offset);
  if (cancellationToken.isCancellationRequested || statesByUri.get(uri) !== state) return null;
  return definition;
});

connection.onDocumentRangeFormatting((params) => {
  const state = statesByUri.get(params.textDocument.uri);
  return state ? embeddedRangeFormatting(state, params) : [];
});

connection.onHover((params) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state) return null;

  const offset = state.document.offsetAt(params.position);
  if (!containsOffset(state.embedded.ranges, offset)) return null;

  const info = ensureLanguageService().getQuickInfoAtPosition(state.fileName, offset);
  if (
    !info ||
    !containsSpan(
      state.embedded.ranges,
      info.textSpan.start,
      info.textSpan.start + info.textSpan.length,
    )
  ) {
    return null;
  }
  const signature = ts.displayPartsToString(info.displayParts);
  const documentation = ts.displayPartsToString(info.documentation);
  const value = documentation ? `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060\n\n${documentation}` : `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060`;
  return {
    contents: { kind: 'markdown', value },
    range: rangeForSpan(state.document, info.textSpan),
  };
});

documents.onDidOpen(({ document }) => scheduleValidation(updateState(document)));
documents.onDidChangeContent(({ document }) => {
  const change = pendingDocumentChanges.get(document.uri);
  pendingDocumentChanges.delete(document.uri);
  scheduleValidation(updateState(document, change));
});
documents.onDidClose(({ document }) => {
  pendingDocumentChanges.delete(document.uri);
  clearTimeout(validationTimers.get(document.uri));
  validationTimers.delete(document.uri);

  const state = statesByUri.get(document.uri);
  if (state) {
    statesByFileName.delete(state.fileName);
    if (state.embedded.ranges.length > 0) projectVersion += 1;
  }
  statesByUri.delete(document.uri);
  scheduleLanguageServiceDisposal();
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

connection.onShutdown(() => {
  shuttingDown = true;
  cancelLanguageServiceDisposal();
  languageService?.dispose();
  librarySnapshots.clear();
});

documents.listen(connection);
connection.listen();
