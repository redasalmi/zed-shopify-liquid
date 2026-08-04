'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const statesByUri = new Map();
const statesByFileName = new Map();
const validationTimers = new Map();
const librarySnapshots = new Map();
let projectVersion = 0;
let ts;
let compilerOptions;
let cssLanguageService;
let documentRegistry;
let languageService;
let liquidDocParamTypesPromise;
let liquidDocLanguageTools;
let liquidParser;

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
      return types;
    });
  }
  return liquidDocParamTypesPromise;
}

function fileSupportsLiquidDoc(fileName) {
  const normalized = fileName.replace(/\\/g, '/');
  return normalized.includes('/snippets/') || normalized.includes('/blocks/');
}

function isInsideLiquidDoc(source, offset) {
  const tagPattern = /{%-?\s*(end)?doc\s*-?%}/g;
  let active = false;
  let match;
  while ((match = tagPattern.exec(source)) !== null && match.index < offset) {
    active = !match[1];
  }
  return active;
}

function liquidDocTagCompletions(state, offset, context) {
  if (context?.triggerCharacter !== '@' || !fileSupportsLiquidDoc(state.fileName)) return null;

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
  if (!fileSupportsLiquidDoc(state.fileName)) return null;

  const source = state.document.getText();
  if (!isInsideLiquidDoc(source, offset)) return null;

  const beforeCursor = source.slice(0, offset);
  const currentLine = beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1);
  if (!/^\s*@param\s+\{\s*[a-zA-Z_]*$/.test(currentLine)) return null;

  // Shopify's provider handles an unfinished opening brace. Supplement the
  // paired-brace form produced by Zed's autoclose behavior.
  if (!/^\s*\}/.test(source.slice(offset))) return null;

  const types = await liquidDocParamTypes();
  return {
    isIncomplete: false,
    items: [...types].map(([label, description]) => {
      const item = {
        label,
        kind: CompletionItemKind.EnumMember,
        detail: 'LiquidDoc parameter type',
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

function themeRootForFile(fileName) {
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
    root = themeRootForFile(fileURLToPath(state.document.uri));
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

function embeddedLanguage(source, tagName) {
  const ranges = [];
  const pattern = new RegExp(
    `(?<opening>{%-?\\s*${tagName}\\s*-?%})(?<content>[\\s\\S]*?)(?<closing>{%-?\\s*end${tagName}\\s*-?%})`,
    'g',
  );
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const start = match.index + match.groups.opening.length;
    ranges.push({ start, end: start + match.groups.content.length });
  }

  // Preserve UTF-16 offsets and line endings so embedded-service ranges map
  // directly back to Liquid. Avoid virtual sources when the tag is absent.
  if (ranges.length === 0) return { source: '', ranges };

  const segments = [];
  let cursor = 0;
  for (const range of ranges) {
    segments.push(source.slice(cursor, range.start).replace(/[^\r\n]/g, ' '));
    segments.push(source.slice(range.start, range.end));
    cursor = range.end;
  }
  segments.push(source.slice(cursor).replace(/[^\r\n]/g, ' '));

  return { source: segments.join(''), ranges };
}

function embeddedJavaScript(source) {
  return embeddedLanguage(source, 'javascript');
}

function embeddedStylesheet(source) {
  return embeddedLanguage(source, 'stylesheet');
}

function containsOffset(ranges, offset) {
  return ranges.some((range) => offset >= range.start && offset <= range.end);
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

function schemaSourceForSource(source) {
  const match = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/.exec(source);
  return match?.[1] ?? null;
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

function settingsCompletions(state, offset) {
  const match = /\b(section|block)\.settings\.([a-zA-Z0-9_-]*)$/.exec(
    state.document.getText().slice(0, offset),
  );
  if (!match || !state.schema) return null;

  const objectName = match[1];
  const partial = match[2];
  const pathName = state.fileName.replace(/\\/g, '/');
  let settings = [];

  // Shopify's server already completes section settings and settings in Theme
  // Block files. Only supplement its upstream gap for inline blocks declared
  // by traditional section schemas, avoiding duplicate entries in Zed.
  if (objectName !== 'block' || !pathName.includes('/sections/')) return null;

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

function updateState(document) {
  const previous = statesByUri.get(document.uri);
  const source = document.getText();
  const embedded = embeddedJavaScript(source);
  const stylesheet = embeddedStylesheet(source);
  const schemaSource = schemaSourceForSource(source);
  const scriptChanged = previous
    ? previous.embedded.source !== embedded.source
    : embedded.ranges.length > 0;
  const hadEmbeddedJavaScript = (previous?.embedded.ranges.length ?? 0) > 0;
  const state = {
    document,
    embedded,
    stylesheet,
    fileName: previous?.fileName || fileNameForUri(document.uri),
    schema:
      schemaSource === previous?.schemaSource ? previous.schema : parseSchema(schemaSource),
    schemaSource,
    hadEmbeddedJavaScript,
    needsValidation: !previous || scriptChanged,
    scriptVersion: (previous?.scriptVersion ?? 0) + (scriptChanged ? 1 : 0),
  };

  statesByUri.set(document.uri, state);
  statesByFileName.set(state.fileName, state);
  if (scriptChanged) projectVersion += 1;
  return state;
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
    if (state) return ts.ScriptSnapshot.fromString(state.embedded.source);

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
  fileExists: (...args) => ts.sys.fileExists(...args),
  readFile: (...args) => ts.sys.readFile(...args),
  readDirectory: (...args) => ts.sys.readDirectory(...args),
  directoryExists: (...args) => ts.sys.directoryExists(...args),
  getDirectories: (...args) => ts.sys.getDirectories(...args),
  useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  getNewLine: () => ts.sys.newLine,
};

// One incremental service is shared by all open Liquid documents. Creating a
// service per request repeatedly parsed the DOM libraries and allowed the
// document registry to retain hundreds of megabytes of duplicate programs.
// Load TypeScript lazily so themes without open JavaScript blocks pay almost no
// memory or startup cost for this optional server.
function ensureLanguageService() {
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
      state.stylesheet.source,
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
  const stylesheet = service.parseStylesheet(document);
  const definition = service.findDefinition(document, document.positionAt(offset), stylesheet);
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
        containsOffset(state.embedded.ranges, diagnostic.start),
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
      }
    }, 350),
  );
}

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      triggerCharacters: ['.', '"', "'", '{', '@'],
    },
    definitionProvider: true,
    documentRangeFormattingProvider: true,
    hoverProvider: true,
  },
  serverInfo: {
    name: 'liquid-embedded-support',
    version: '0.5.0',
  },
}));

connection.onCompletion(async (params) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state) return null;

  const offset = state.document.offsetAt(params.position);
  const settingResults = settingsCompletions(state, offset);
  if (settingResults) return settingResults;
  const liquidDocTagResults = liquidDocTagCompletions(state, offset, params.context);
  if (liquidDocTagResults) return liquidDocTagResults;
  const liquidDocTypeResults = await liquidDocTypeCompletions(state, offset);
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
      };
      if (entry.insertText) item.insertText = entry.insertText;
      if (entry.isSnippet) item.insertTextFormat = InsertTextFormat.Snippet;
      if (entry.replacementSpan) {
        item.textEdit = {
          range: rangeForSpan(state.document, entry.replacementSpan),
          newText: entry.insertText || entry.name,
        };
      }
      return item;
    }),
  };
});

connection.onDefinition(async (params) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state) return null;

  const offset = state.document.offsetAt(params.position);
  return (
    javascriptDefinitions(state, offset) ??
    stylesheetDefinition(state, offset) ??
    definitionForReference(state, offset)
  );
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
  if (!info) return null;
  const signature = ts.displayPartsToString(info.displayParts);
  const documentation = ts.displayPartsToString(info.documentation);
  const value = documentation ? `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060\n\n${documentation}` : `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060`;
  return {
    contents: { kind: 'markdown', value },
    range: rangeForSpan(state.document, info.textSpan),
  };
});

documents.onDidOpen(({ document }) => scheduleValidation(updateState(document)));
documents.onDidChangeContent(({ document }) => scheduleValidation(updateState(document)));
documents.onDidClose(({ document }) => {
  clearTimeout(validationTimers.get(document.uri));
  validationTimers.delete(document.uri);

  const state = statesByUri.get(document.uri);
  if (state) {
    statesByFileName.delete(state.fileName);
    if (state.embedded.ranges.length > 0) projectVersion += 1;
  }
  statesByUri.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

connection.onShutdown(() => {
  languageService?.dispose();
  librarySnapshots.clear();
});

documents.listen(connection);
connection.listen();
