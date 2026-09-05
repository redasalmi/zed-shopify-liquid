'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const {
  CompletionItemKind,
  CompletionItemTag,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  InsertTextFormat,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const {
  changesLineStructure,
  containsOffset,
  containsSpan,
  embeddedJavaScript,
  embeddedSource,
  embeddedStylesheet,
  intersectingRanges,
  sameEmbeddedLanguage,
  updateEmbeddedSource,
} = require('./embedded-language.cjs');
const { liquidDocTools } = require('./liquid-doc-tools.cjs');
const {
  clearSchemaLocaleCaches,
  schemaLocale,
  schemaSettingLocations,
  settingDocumentation,
} = require('./schema-settings.cjs');
const {
  analyzeLiquidDocument,
  parseSchema,
  referencesInSource,
  reusableAnalysis,
  schemaSourceForSource,
  settingsFrom,
} = require('./liquid-document-analysis.cjs');
const {
  EMBEDDED_THEME_DIRECTORIES,
  clearThemeRootCaches,
  fileSupportsEmbeddedAssets,
  fileSupportsLiquidDoc,
  getWorkspaceRoots,
  isWithinDirectory,
  setWorkspaceRoots,
  themeRootForFile,
  themeRootForStandardFile,
  updateWorkspaceRoots,
} = require('./theme-roots.cjs');

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const pendingDocumentChanges = new Map();
const documents = new TextDocuments({
  create: (...args) => TextDocument.create(...args),
  update: (document, changes, version) => {
    const previousDocument = TextDocument.create(
      document.uri,
      document.languageId,
      document.version,
      document.getText(),
    );
    pendingDocumentChanges.set(document.uri, { previousDocument, changes });
    return TextDocument.update(document, changes, version);
  },
});
const statesByUri = new Map();
const statesByFileName = new Map();
const activeJavaScriptStates = new Set();
const validationTimers = new Map();
const librarySnapshots = new Map();
const importedSnapshotFiles = new Set();
const importedSnapshotVersions = new Map();
const moduleDependencies = new Map();
const invalidatedModuleResolutions = new Set();
const configuredTypescriptIdleMilliseconds = Number.parseInt(
  process.env.LIQUID_TYPESCRIPT_IDLE_MS || '',
  10,
);
const typescriptIdleMilliseconds = Number.isFinite(configuredTypescriptIdleMilliseconds)
  ? Math.max(0, configuredTypescriptIdleMilliseconds)
  : 30_000;

function configuredPositiveLimit(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const maxEmbeddedDocumentCodeUnits = configuredPositiveLimit(
  'LIQUID_MAX_EMBEDDED_DOCUMENT_CODE_UNITS',
  2 * 1024 * 1024,
);
const maxEmbeddedBlockCodeUnits = configuredPositiveLimit(
  'LIQUID_MAX_EMBEDDED_BLOCK_CODE_UNITS',
  512 * 1024,
);
const maxImportedFileCodeUnits = configuredPositiveLimit(
  'LIQUID_MAX_IMPORTED_FILE_CODE_UNITS',
  1024 * 1024,
);
const maxImportedFiles = configuredPositiveLimit('LIQUID_MAX_IMPORTED_FILES', 128);
const performanceLogging = process.env.LIQUID_PERFORMANCE_LOGGING === '1';
let projectVersion = 0;
let ts;
let compilerOptions;
let cssLanguageService;
let documentRegistry;
let languageService;
let languageServiceIdleTimer;
let liquidDocParamTypesPromise;
let liquidDocTagCompletionItems;
let shuttingDown = false;
let supportsWatchedFileRegistration = false;
let supportsWorkspaceFolderChanges = false;
let typescriptLibraryRoot;

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

function isInsideLiquidDoc(rawTags, offset) {
  return rawTags.some(
    (node) =>
      node.name === 'doc' &&
      offset >= node.body.position.start &&
      offset <= node.body.position.end,
  );
}

function liquidDocTagCompletions(state, offset, context) {
  if (
    context?.triggerCharacter !== '@' ||
    !fileSupportsLiquidDoc(state.sourceFileName || state.fileName)
  ) {
    return null;
  }

  const source = state.document.getText();
  if (!isInsideLiquidDoc(state.rawTags, offset)) return null;
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  if (!/^\s*@$/.test(source.slice(lineStart, offset))) return null;

  if (!liquidDocTagCompletionItems) {
    const { formatLiquidDocTagHandle, SUPPORTED_LIQUID_DOC_TAG_HANDLES } =
      liquidDocTools();
    liquidDocTagCompletionItems = Object.entries(SUPPORTED_LIQUID_DOC_TAG_HANDLES).map(
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
    );
  }

  return { isIncomplete: false, items: liquidDocTagCompletionItems };
}

async function liquidDocTypeCompletions(state, offset) {
  if (!fileSupportsLiquidDoc(state.sourceFileName || state.fileName)) return null;

  const source = state.document.getText();
  if (!isInsideLiquidDoc(state.rawTags, offset)) return null;

  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const currentLine = source.slice(lineStart, offset);
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

async function definitionForReference(state, offset) {
  if (state.documentTooLarge) return null;
  if (!state.definitionReferences) {
    state.definitionReferences = referencesInSource(state.document.getText());
  }
  const reference = state.definitionReferences.find(
    (candidate) => offset >= candidate.start && offset <= candidate.end,
  );
  if (!reference) return null;

  let root;
  try {
    root = await themeRootForFile(fileURLToPath(state.document.uri));
  } catch (_error) {
    return null;
  }
  if (!root) return null;

  // Shopify permits nested snippet paths. Resolve references against their
  // category directory instead of rejecting every name containing a slash,
  // while still preventing traversal outside the theme root.
  const categoryRoot = path.resolve(root, reference.category);
  const targetName =
    reference.category === 'assets' ? reference.name : `${reference.name}.liquid`;
  const candidate = path.resolve(categoryRoot, targetName);
  if (!isWithinDirectory(categoryRoot, candidate)) return null;
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

function fileNameForUri(uri) {
  try {
    return `${fileURLToPath(uri)}.__embedded.js`;
  } catch (_error) {
    return `${uri.replace(/[^a-zA-Z0-9._-]/g, '_')}.__embedded.js`;
  }
}

function filePathsForWorkspaceUri(uri) {
  try {
    return [fileURLToPath(uri)];
  } catch (_error) {
    return [];
  }
}

function changeAffectsThemeRoots(change) {
  let fileName;
  try {
    fileName = fileURLToPath(change.uri);
  } catch (_error) {
    return false;
  }
  const parts = path.resolve(fileName).split(path.sep);
  return (
    path.basename(fileName) === '.theme-check.yml' ||
    parts.some((part) => part === 'config' || part === 'layout' || part === 'templates')
  );
}

function invalidateImportedSnapshots(changes = []) {
  const affected = new Set();
  for (const change of changes) {
    let fileName;
    try {
      fileName = path.resolve(fileURLToPath(change.uri));
    } catch (_error) {
      continue;
    }
    const isModuleFile = /\.(?:(?:c|m)?[jt]s|jsx|tsx)$/i.test(fileName);
    const packageChanged = path.basename(fileName) === 'package.json';
    if (!isModuleFile && !packageChanged) continue;
    const invalidatedForChange = new Set();
    for (const [containingFile, dependencies] of moduleDependencies) {
      if (packageChanged || dependencies.files.has(fileName) ||
          (change.type === 1 && dependencies.unresolved)) {
        invalidatedModuleResolutions.add(containingFile);
        invalidatedForChange.add(containingFile);
      }
    }
    // Triple-slash references can load snapshots without resolveModuleNames.
    // Without module edges we cannot identify their consumers, so conservatively
    // refresh all active documents rather than retaining stale type information.
    const untrackedDependency = importedSnapshotFiles.has(fileName) && invalidatedForChange.size === 0;
    for (const state of activeJavaScriptStates) {
      if (untrackedDependency) {
        affected.add(state);
        continue;
      }
      const pending = [state.fileName];
      const visited = new Set();
      while (pending.length > 0) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        if (current === fileName || invalidatedForChange.has(current)) {
          affected.add(state);
          break;
        }
        for (const dependency of moduleDependencies.get(current)?.files || []) {
          pending.push(dependency);
        }
      }
    }
    const removedSnapshot = librarySnapshots.delete(fileName);
    const removedImportedFile = importedSnapshotFiles.delete(fileName);
    if (removedSnapshot || removedImportedFile) {
      importedSnapshotVersions.set(
        fileName,
        (importedSnapshotVersions.get(fileName) || 0) + 1,
      );
    }
  }
  if (affected.size > 0) projectVersion += 1;
  return affected;
}

function resetImportedSnapshots() {
  for (const fileName of moduleDependencies.keys()) invalidatedModuleResolutions.add(fileName);
  for (const fileName of importedSnapshotFiles) {
    librarySnapshots.delete(fileName);
    importedSnapshotVersions.set(
      fileName,
      (importedSnapshotVersions.get(fileName) || 0) + 1,
    );
  }
  importedSnapshotFiles.clear();
  // Workspace changes can alter both package and relative module resolution,
  // including previously unresolved imports that have no cached snapshot.
  projectVersion += 1;
}

async function settingsCompletions(state, offset) {
  const source = state.document.getText();
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const match = /\b(section|block)\.settings\.([a-zA-Z0-9_-]*)$/.exec(
    source.slice(lineStart, offset),
  );
  const isLiquidExpression = state.liquidExpressionRanges.some(
    (range) => offset >= range.start && offset <= range.end,
  );
  if (!match || !state.schema || !isLiquidExpression) return null;

  const objectName = match[1];
  const partial = match[2];
  const pathName = (state.sourceFileName || state.fileName).replace(/\\/g, '/');

  // Shopify's server already completes section settings and settings in Theme
  // Block files. Only supplement its upstream gap for inline blocks declared
  // by traditional section schemas, avoiding duplicate entries in Zed.
  const root = themeRootForStandardFile(
    state.sourceFileName || state.fileName, EMBEDDED_THEME_DIRECTORIES,
  );
  if (objectName !== 'block' || !pathName.includes('/sections/') || !root) {
    return null;
  }

  if (!state.inlineBlockSettingItems) {
    // The exact block.type cannot always be narrowed statically. Offer the
    // union so every declared block setting remains discoverable; duplicate
    // ids are collapsed below. Cache the complete items for this document
    // version so each completion only filters the current prefix.
    const settings = Array.isArray(state.schema.blocks)
      ? state.schema.blocks.flatMap((block) => settingsFrom(block?.settings))
      : [];
    const uniqueSettings = new Map(settings.map((setting) => [setting.id, setting]));
    state.inlineBlockSettingItems = [...uniqueSettings.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((setting) => {
        const item = {
          label: setting.id,
          kind: CompletionItemKind.Property,
        };
        if (typeof setting.type === 'string') item.detail = `Shopify ${setting.type} setting`;
        return { item, setting };
      });
  }

  const needsLocale = state.inlineBlockSettingItems.some(({ setting }) =>
    [setting.label, setting.info].some((value) => typeof value === 'string' && value.startsWith('t:')),
  );
  const locale = needsLocale ? await schemaLocale(root) : null;
  if (!state.localizedSettingItems || state.settingLocaleVersion !== locale?.version) {
    // Retain only the version and the documentation actually used by this
    // schema, so open documents cannot pin evicted complete locale dictionaries.
    state.settingLocaleVersion = locale?.version;
    state.localizedSettingItems = state.inlineBlockSettingItems.map(({ item, setting }) => {
      const documentation = settingDocumentation(setting, locale?.data);
      return documentation ? { ...item, documentation } : item;
    });
  }
  return {
    isIncomplete: false,
    items: state.localizedSettingItems.filter((item) => item.label.startsWith(partial)),
  };
}

function settingDefinitions(state, offset) {
  if (!state.schema) return null;
  const reference = state.settingReferences.find(
    (reference) => offset >= reference.start && offset < reference.end,
  );
  if (!reference) return null;
  const root = themeRootForStandardFile(state.sourceFileName, EMBEDDED_THEME_DIRECTORIES);
  if (!root) return null;
  const category = path.basename(path.dirname(state.sourceFileName));
  if (category !== 'sections' && category !== 'blocks') return null;
  if (reference.objectName === 'section' && category !== 'sections') return null;
  const inlineBlock = reference.objectName === 'block' && category === 'sections';
  state.schemaSettingLocations ||= schemaSettingLocations(state.schemaSource);
  const schemaStart = state.rawTags.find((node) => node.name === 'schema').body.position.start;
  const locations = state.schemaSettingLocations
    .filter((location) => location.id === reference.id && location.inlineBlock === inlineBlock)
    .map((location) => ({
      uri: state.document.uri,
      range: rangeForSpan(state.document, {
        start: schemaStart + location.start,
        length: location.end - location.start,
      }),
    }));
  return locations.length > 0 ? locations : null;
}

function embeddedResourceLimits(rawTags, enabled) {
  if (!enabled) return [];

  const limits = [];
  for (const tagName of ['javascript', 'stylesheet']) {
    const tag = rawTags.find((candidate) => candidate.name === tagName);
    if (!tag) continue;
    const blockLength = tag.body.position.end - tag.body.position.start;
    let message;
    if (blockLength > maxEmbeddedBlockCodeUnits) {
      message =
        `Embedded ${tagName} support is disabled because this block exceeds ` +
        `${maxEmbeddedBlockCodeUnits} UTF-16 code units.`;
    }
    if (message) {
      limits.push({ tagName, message, position: tag.body.position });
    }
  }
  return limits;
}

function resourceLimitDiagnostics(state) {
  return state.resourceLimits.map((limit) => ({
    range: {
      start: state.document.positionAt(limit.position.start),
      end: state.document.positionAt(
        Math.min(limit.position.end, limit.position.start + 1),
      ),
    },
    severity: DiagnosticSeverity.Information,
    code: 'embedded-resource-limit',
    source: 'liquid-embedded-support',
    message: limit.message,
  }));
}

function updateState(document, change) {
  const previous = statesByUri.get(document.uri);
  const source = document.getText();
  // Limit all supplemental parser entry points, not only TypeScript. Building
  // the Liquid AST itself can exhaust the heap before embedded limits run.
  const documentTooLarge = source.length > maxEmbeddedDocumentCodeUnits;
  const analysisReuse = documentTooLarge ? null : reusableAnalysis(previous, change);
  const analysis = documentTooLarge
    ? { rawTags: [], liquidExpressionRanges: [], settingReferences: [], analysisReusable: false }
    : analysisReuse?.analysis || analyzeLiquidDocument(source);
  if (performanceLogging) {
    connection.console.info(`Liquid analysis ${documentTooLarge ? 'limited' : analysisReuse ? 'reused' : 'parsed'}: ${document.uri}`);
  }
  const rawTags = analysis.rawTags;
  let sourceFileName;
  try {
    sourceFileName = fileURLToPath(document.uri);
  } catch (_error) {
    sourceFileName = document.uri;
  }
  const supportsEmbeddedAssets = fileSupportsEmbeddedAssets(sourceFileName);
  const resourceLimits = documentTooLarge
    ? [{
        message: 'Supplemental Liquid support is disabled because this document ' +
          `exceeds ${maxEmbeddedDocumentCodeUnits} UTF-16 code units.`,
        position: { start: 0, end: 1 },
      }]
    : embeddedResourceLimits(rawTags, supportsEmbeddedAssets);
  const resourceLimitedTags = new Set(resourceLimits.map((limit) => limit.tagName));
  const embedded = embeddedJavaScript(
    source,
    rawTags,
    supportsEmbeddedAssets && !resourceLimitedTags.has('javascript'),
  );
  const stylesheet = embeddedStylesheet(
    source,
    rawTags,
    supportsEmbeddedAssets && !resourceLimitedTags.has('stylesheet'),
  );
  const schemaSource = schemaSourceForSource(source, rawTags);
  const scriptLineStructureChanged = changesLineStructure(
    change,
    previous?.embedded.ranges || [],
  );
  const stylesheetLineStructureChanged = changesLineStructure(
    change,
    previous?.stylesheet.ranges || [],
  );
  const scriptChanged = previous
    ? analysisReuse
      ? scriptLineStructureChanged ||
        analysisReuse.rawBodyChange?.tagName === 'javascript' ||
        analysisReuse.shiftedRawTagNames.has('javascript') ||
        previous.embedded.ranges.length !== embedded.ranges.length
      : !sameEmbeddedLanguage(previous.embedded, embedded, change)
    : embedded.ranges.length > 0;
  const stylesheetChanged = previous
    ? analysisReuse
      ? stylesheetLineStructureChanged ||
        analysisReuse.rawBodyChange?.tagName === 'stylesheet' ||
        analysisReuse.shiftedRawTagNames.has('stylesheet') ||
        previous.stylesheet.ranges.length !== stylesheet.ranges.length
      : !sameEmbeddedLanguage(previous.stylesheet, stylesheet, change)
    : stylesheet.ranges.length > 0;
  if (previous && !scriptChanged) embedded.source = previous.embedded.source;
  if (previous && !stylesheetChanged) stylesheet.source = previous.stylesheet.source;
  if (analysisReuse?.rawBodyChange?.tagName === 'javascript') {
    updateEmbeddedSource(previous.embedded, embedded, analysisReuse.rawBodyChange);
  } else if (analysisReuse?.rawBodyChange?.tagName === 'stylesheet') {
    updateEmbeddedSource(previous.stylesheet, stylesheet, analysisReuse.rawBodyChange);
  }
  const hadEmbeddedJavaScript = (previous?.embedded.ranges.length ?? 0) > 0;
  const hadResourceLimits = (previous?.resourceLimits.length ?? 0) > 0;
  const state = {
    document,
    embedded,
    stylesheet,
    resourceLimits,
    documentTooLarge,
    sourceFileName,
    fileName: previous?.fileName || fileNameForUri(document.uri),
    rawTags,
    analysisReusable: analysis.analysisReusable,
    analysisSkipped: analysis.analysisSkipped,
    liquidExpressionRanges: analysis.liquidExpressionRanges,
    settingReferences: analysis.settingReferences,
    schema:
      schemaSource === previous?.schemaSource ? previous.schema : parseSchema(schemaSource),
    schemaSource,
    inlineBlockSettingItems:
      schemaSource === previous?.schemaSource ? previous.inlineBlockSettingItems : undefined,
    localizedSettingItems:
      schemaSource === previous?.schemaSource ? previous.localizedSettingItems : undefined,
    settingLocaleVersion:
      schemaSource === previous?.schemaSource ? previous.settingLocaleVersion : undefined,
    schemaSettingLocations:
      schemaSource === previous?.schemaSource ? previous.schemaSettingLocations : undefined,
    hadEmbeddedJavaScript,
    hadResourceLimits,
    cssDocument: stylesheetChanged ? undefined : previous?.cssDocument,
    cssStylesheet: stylesheetChanged ? undefined : previous?.cssStylesheet,
    needsValidation: !previous || scriptChanged || resourceLimits.length > 0 || hadResourceLimits,
    scriptSnapshot: scriptChanged ? undefined : previous?.scriptSnapshot,
    scriptVersion: (previous?.scriptVersion ?? 0) + (scriptChanged ? 1 : 0),
  };

  if (previous?.embedded.ranges.length > 0) activeJavaScriptStates.delete(previous);
  if (embedded.ranges.length > 0) activeJavaScriptStates.add(state);
  statesByUri.set(document.uri, state);
  statesByFileName.set(state.fileName, state);
  if (scriptChanged) projectVersion += 1;
  if (embedded.ranges.length > 0) cancelLanguageServiceDisposal();
  else if (hadEmbeddedJavaScript) scheduleLanguageServiceDisposal();
  return state;
}

function refreshOpenDocumentStates() {
  const openDocuments = [...statesByUri.values()].map((state) => state.document);
  for (const document of openDocuments) scheduleValidation(updateState(document));
}

function revalidateActiveJavaScriptStates(states = activeJavaScriptStates) {
  for (const state of states) {
    state.needsValidation = true;
    scheduleValidation(state);
  }
}

function allowedTypeScriptPath(fileName) {
  if (statesByFileName.get(fileName)?.embedded.ranges.length > 0) return true;
  if (!typescriptLibraryRoot) {
    typescriptLibraryRoot = path.dirname(require.resolve('typescript/lib/typescript.js'));
  }
  return (
    isWithinDirectory(typescriptLibraryRoot, fileName) ||
    getWorkspaceRoots().some((root) => isWithinDirectory(root, fileName))
  );
}

function allowedTypeScriptDirectory(directory) {
  if (!typescriptLibraryRoot) {
    typescriptLibraryRoot = path.dirname(require.resolve('typescript/lib/typescript.js'));
  }
  return [typescriptLibraryRoot, ...getWorkspaceRoots()].some(
    (root) => isWithinDirectory(root, directory) || isWithinDirectory(directory, root),
  );
}

const languageServiceHost = {
  getCompilationSettings: () => compilerOptions,
  getScriptFileNames: () => [...activeJavaScriptStates].map((state) => state.fileName),
  getScriptVersion: (fileName) =>
    String(
      statesByFileName.get(fileName)?.scriptVersion ??
        importedSnapshotVersions.get(fileName) ??
        0,
    ),
  getProjectVersion: () => String(projectVersion),
  getScriptSnapshot: (fileName) => {
    const state = statesByFileName.get(fileName);
    if (state) {
      if (!state.scriptSnapshot) {
        state.scriptSnapshot = ts.ScriptSnapshot.fromString(embeddedSource(state.embedded));
      }
      return state.scriptSnapshot;
    }

    if (!allowedTypeScriptPath(fileName)) return undefined;
    let snapshot = librarySnapshots.get(fileName);
    if (snapshot) return snapshot;

    const contents = ts.sys.readFile(fileName);
    if (contents === undefined) return undefined;
    const isTypeScriptLibrary = isWithinDirectory(typescriptLibraryRoot, fileName);
    if (!isTypeScriptLibrary) {
      if (contents.length > maxImportedFileCodeUnits) return undefined;
      if (!importedSnapshotFiles.has(fileName) && importedSnapshotFiles.size >= maxImportedFiles) {
        return undefined;
      }
      importedSnapshotFiles.add(fileName);
      if (!importedSnapshotVersions.has(fileName)) importedSnapshotVersions.set(fileName, 0);
    }
    snapshot = ts.ScriptSnapshot.fromString(contents);
    librarySnapshots.set(fileName, snapshot);
    return snapshot;
  },
  getScriptKind: (fileName) =>
    statesByFileName.has(fileName) ? ts.ScriptKind.JS : ts.getScriptKindFromFileName(fileName),
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  hasInvalidatedResolutions: (fileName) => invalidatedModuleResolutions.has(fileName),
  resolveModuleNames: (moduleNames, containingFile) => {
    const dependencies = { files: new Set(), unresolved: false };
    const resolved = moduleNames.map((moduleName) => {
      const resolvedModule = ts.resolveModuleName(
        moduleName,
        containingFile,
        compilerOptions,
        languageServiceHost,
      ).resolvedModule;
      if (resolvedModule) dependencies.files.add(path.resolve(resolvedModule.resolvedFileName));
      else dependencies.unresolved = true;
      return resolvedModule;
    });
    moduleDependencies.set(containingFile, dependencies);
    invalidatedModuleResolutions.delete(containingFile);
    return resolved;
  },
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
  return activeJavaScriptStates.size > 0;
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
  importedSnapshotFiles.clear();
  importedSnapshotVersions.clear();
  moduleDependencies.clear();
  invalidatedModuleResolutions.clear();
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

function localJavaScriptSpan(state, entry) {
  return entry.fileName === state.fileName && containsSpan(
    state.embedded.ranges, entry.textSpan.start, entry.textSpan.start + entry.textSpan.length,
  );
}

function localJavaScriptSymbol(state, offset) {
  if (!containsOffset(state.embedded.ranges, offset)) return false;
  const definitions = ensureLanguageService().getDefinitionAtPosition(state.fileName, offset);
  // Do not offer a partial refactor of imported symbols or browser globals.
  return definitions?.length > 0 && definitions.every((entry) => localJavaScriptSpan(state, entry));
}

function javascriptRenameInfo(state, offset) {
  if (!localJavaScriptSymbol(state, offset)) return null;
  const info = ensureLanguageService().getRenameInfo(state.fileName, offset, {
    allowRenameOfImportPath: false,
  });
  if (!info.canRename || info.fileToRename || !containsSpan(
    state.embedded.ranges, info.triggerSpan.start, info.triggerSpan.start + info.triggerSpan.length,
  )) return null;
  return info;
}

function javascriptSignatureHelp(state, offset) {
  if (!containsOffset(state.embedded.ranges, offset)) return null;
  const help = ensureLanguageService().getSignatureHelpItems(state.fileName, offset, undefined);
  if (!help || !containsSpan(
    state.embedded.ranges, help.applicableSpan.start, help.applicableSpan.start + help.applicableSpan.length,
  )) return null;
  return {
    signatures: help.items.map((item) => ({
      label: ts.displayPartsToString(item.prefixDisplayParts) +
        item.parameters.map((parameter) => ts.displayPartsToString(parameter.displayParts))
          .join(ts.displayPartsToString(item.separatorDisplayParts)) +
        ts.displayPartsToString(item.suffixDisplayParts),
      documentation: ts.displayPartsToString(item.documentation),
      parameters: item.parameters.map((parameter) => ({
        label: ts.displayPartsToString(parameter.displayParts),
        documentation: ts.displayPartsToString(parameter.documentation),
      })),
      activeParameter: item.isVariadic
        ? Math.min(help.argumentIndex, Math.max(0, item.parameters.length - 1))
        : help.argumentIndex,
    })),
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex,
  };
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
  if (!state) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  if (performanceLogging) connection.console.info(`Validating JavaScript: ${uri}`);
  const limitedDiagnostics = resourceLimitDiagnostics(state);
  if (state.embedded.ranges.length === 0) {
    connection.sendDiagnostics({ uri, diagnostics: limitedDiagnostics });
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

  connection.sendDiagnostics({ uri, diagnostics: [...limitedDiagnostics, ...diagnostics] });
}

function scheduleValidation(state) {
  if (state.embedded.ranges.length === 0) {
    if (state.hadEmbeddedJavaScript || state.hadResourceLimits || state.resourceLimits.length > 0) {
      clearTimeout(validationTimers.get(state.document.uri));
      validationTimers.delete(state.document.uri);
      connection.sendDiagnostics({
        uri: state.document.uri,
        diagnostics: resourceLimitDiagnostics(state),
      });
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
        const current = statesByUri.get(state.document.uri);
        connection.sendDiagnostics({
          uri: state.document.uri,
          diagnostics: current ? resourceLimitDiagnostics(current) : [],
        });
      }
    }, 350),
  );
}

connection.onInitialize((params) => {
  supportsWatchedFileRegistration = Boolean(
    params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration,
  );
  supportsWorkspaceFolderChanges = Boolean(params.capabilities.workspace?.workspaceFolders);
  const rootUris = [
    ...(params.workspaceFolders || []).map((folder) => folder.uri),
    params.rootUri,
  ].filter(Boolean);
  setWorkspaceRoots(rootUris.flatMap(filePathsForWorkspaceUri));

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.', '"', "'", '{', '@'],
      },
      definitionProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
      renameProvider: { prepareProvider: true },
      referencesProvider: true,
      documentRangeFormattingProvider: true,
      hoverProvider: true,
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
    serverInfo: {
      name: 'liquid-embedded-support',
      version: process.env.LIQUID_EXTENSION_VERSION || 'development',
    },
  };
});

connection.onInitialized(() => {
  if (supportsWorkspaceFolderChanges) {
    connection.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
      updateWorkspaceRoots(
        added.flatMap((folder) => filePathsForWorkspaceUri(folder.uri)),
        removed.flatMap((folder) => filePathsForWorkspaceUri(folder.uri)),
      );
      resetImportedSnapshots();
      clearSchemaLocaleCaches();
      refreshOpenDocumentStates();
      revalidateActiveJavaScriptStates();
    });
  }
  if (supportsWatchedFileRegistration) {
    connection.client
      .register(DidChangeWatchedFilesNotification.type, {
        watchers: [
          { globPattern: '**/.theme-check.yml' },
          { globPattern: '**/config/**' },
          { globPattern: '**/layout/**' },
          { globPattern: '**/templates/**' },
          { globPattern: '**/locales/*.schema.json' },
          { globPattern: '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}' },
          { globPattern: '**/package.json' },
        ],
      })
      .catch((error) => connection.console.warn(`Unable to watch theme roots: ${error}`));
  }
});
connection.onDidChangeWatchedFiles((params) => {
  if (params.changes.some((change) => /\/locales\/[^/]+\.schema\.json$/.test(change.uri))) {
    clearSchemaLocaleCaches();
  }
  if (params.changes.some(changeAffectsThemeRoots)) {
    clearSchemaLocaleCaches();
    clearThemeRootCaches();
    refreshOpenDocumentStates();
  }
  revalidateActiveJavaScriptStates(invalidateImportedSnapshots(params.changes));
});

connection.onCompletion(async (params, cancellationToken) => {
  const uri = params.textDocument.uri;
  const state = statesByUri.get(uri);
  if (!state || state.documentTooLarge || cancellationToken.isCancellationRequested) return null;

  const offset = state.document.offsetAt(params.position);
  const settingResults = await settingsCompletions(state, offset);
  if (cancellationToken.isCancellationRequested || statesByUri.get(uri) !== state) return null;
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
    settingDefinitions(state, offset) ??
    javascriptDefinitions(state, offset) ?? stylesheetDefinition(state, offset);
  if (embeddedDefinition) return embeddedDefinition;

  const definition = await definitionForReference(state, offset);
  if (cancellationToken.isCancellationRequested || statesByUri.get(uri) !== state) return null;
  return definition;
});

connection.onSignatureHelp((params, cancellationToken) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state || cancellationToken.isCancellationRequested) return null;
  return javascriptSignatureHelp(state, state.document.offsetAt(params.position));
});

connection.onPrepareRename((params, cancellationToken) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state || cancellationToken.isCancellationRequested) return null;
  const info = javascriptRenameInfo(state, state.document.offsetAt(params.position));
  return info ? { range: rangeForSpan(state.document, info.triggerSpan), placeholder: info.displayName } : null;
});

connection.onRenameRequest((params, cancellationToken) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state || cancellationToken.isCancellationRequested) return null;
  const offset = state.document.offsetAt(params.position);
  const info = javascriptRenameInfo(state, offset);
  if (!info) return null;
  const service = ensureLanguageService();
  const sourceFile = service.getProgram().getSourceFile(state.fileName);
  const isPrivate = ts.isPrivateIdentifier(ts.getTokenAtPosition(sourceFile, info.triggerSpan.start));
  const identifier = isPrivate && params.newName.startsWith('#') ? params.newName.slice(1) : params.newName;
  const token = ts.stringToToken(identifier);
  if (!ts.isIdentifierText(identifier, ts.ScriptTarget.ES2022) ||
      (isPrivate
        ? identifier === 'constructor'
        : (token >= ts.SyntaxKind.FirstReservedWord && token <= ts.SyntaxKind.LastReservedWord) ||
          identifier === 'await' || identifier === 'yield')) return null;
  // TypeScript's rename spans include '#'. Preserve privacy even when the
  // client submits a bare name, and do not mistake quoted properties for fields.
  const newName = isPrivate ? `#${identifier}` : identifier;
  const locations = service.findRenameLocations(
    state.fileName, offset, false, false, { providePrefixAndSuffixTextForRename: true },
  );
  if (!locations?.length || !locations.every((entry) => localJavaScriptSpan(state, entry))) return null;
  return {
    changes: {
      [state.document.uri]: locations.map((location) => ({
        range: rangeForSpan(state.document, location.textSpan),
        newText: (location.prefixText || '') + newName + (location.suffixText || ''),
      })),
    },
  };
});

connection.onReferences((params, cancellationToken) => {
  const state = statesByUri.get(params.textDocument.uri);
  if (!state || cancellationToken.isCancellationRequested) return null;
  const offset = state.document.offsetAt(params.position);
  if (!localJavaScriptSymbol(state, offset)) return null;
  const symbols = ensureLanguageService().findReferences(state.fileName, offset) || [];
  const locations = symbols.flatMap((symbol) => symbol.references)
    .filter((entry) => localJavaScriptSpan(state, entry) &&
      (params.context.includeDeclaration || !entry.isDefinition))
    .map((entry) => ({ uri: state.document.uri, range: rangeForSpan(state.document, entry.textSpan) }));
  return locations.length > 0 ? locations : null;
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

// TextDocuments also emits onDidChangeContent for didOpen. Handle it only once.
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
    moduleDependencies.delete(state.fileName);
    invalidatedModuleResolutions.delete(state.fileName);
    if (state.embedded.ranges.length > 0) {
      activeJavaScriptStates.delete(state);
      projectVersion += 1;
    }
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
  importedSnapshotFiles.clear();
  importedSnapshotVersions.clear();
  moduleDependencies.clear();
  invalidatedModuleResolutions.clear();
  clearSchemaLocaleCaches();
});

documents.listen(connection);
connection.listen();
