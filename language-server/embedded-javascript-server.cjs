'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const ts = require('typescript');
const {
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  ProposedFeatures,
  TextDocumentSyncKind,
  createConnection,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const { TextDocuments } = require('vscode-languageserver/node');

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
const documentRegistry = ts.createDocumentRegistry();
const validationTimers = new Map();

function embeddedJavaScript(source) {
  const ranges = [];
  const pattern = /(?<opening>{%-?\s*javascript\s*-?%})(?<content>[\s\S]*?)(?<closing>{%-?\s*endjavascript\s*-?%})/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const start = match.index + match.groups.opening.length;
    ranges.push({ start, end: start + match.groups.content.length });
  }

  const characters = source
    .split('')
    .map((character) => (character === '\n' || character === '\r' ? character : ' '));
  for (const range of ranges) {
    for (let offset = range.start; offset < range.end; offset += 1) {
      characters[offset] = source[offset];
    }
  }

  return { source: characters.join(''), ranges };
}

function containsOffset(ranges, offset) {
  return ranges.some((range) => offset >= range.start && offset <= range.end);
}

function fileNameForUri(uri) {
  try {
    return `${fileURLToPath(uri)}.__embedded.js`;
  } catch (_error) {
    return `${uri.replace(/[^a-zA-Z0-9._-]/g, '_')}.__embedded.js`;
  }
}

function languageServiceFor(document) {
  const fileName = fileNameForUri(document.uri);
  const embedded = embeddedJavaScript(document.getText());
  const compilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    noEmit: true,
  };

  const host = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => String(document.version),
    getScriptSnapshot: (requestedFileName) => {
      if (requestedFileName === fileName) {
        return ts.ScriptSnapshot.fromString(embedded.source);
      }
      const contents = ts.sys.readFile(requestedFileName);
      return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
    },
    getScriptKind: (requestedFileName) =>
      requestedFileName === fileName ? ts.ScriptKind.JS : ts.ScriptKind.Unknown,
    getCurrentDirectory: () => path.dirname(fileName),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };

  return {
    embedded,
    fileName,
    service: ts.createLanguageService(host, documentRegistry),
  };
}

function rangeForSpan(document, span) {
  return {
    start: document.positionAt(span.start),
    end: document.positionAt(span.start + span.length),
  };
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

async function validate(document) {
  const { embedded, fileName, service } = languageServiceFor(document);
  try {
    const diagnostics = [
      ...service.getSyntacticDiagnostics(fileName),
      ...service.getSemanticDiagnostics(fileName),
      ...service.getSuggestionDiagnostics(fileName),
    ]
      .filter(
        (diagnostic) =>
          diagnostic.start !== undefined &&
          diagnostic.length !== undefined &&
          containsOffset(embedded.ranges, diagnostic.start),
      )
      .map((diagnostic) => ({
        range: rangeForSpan(document, {
          start: diagnostic.start,
          length: diagnostic.length,
        }),
        severity: diagnosticSeverity(diagnostic.category),
        code: diagnostic.code,
        source: 'typescript',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      }));

    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  } finally {
    service.dispose();
  }
}

function scheduleValidation(document) {
  clearTimeout(validationTimers.get(document.uri));
  validationTimers.set(
    document.uri,
    setTimeout(() => {
      validationTimers.delete(document.uri);
      validate(document).catch((error) => connection.console.error(String(error)));
    }, 200),
  );
}

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      triggerCharacters: ['.', '"', "'"],
    },
    hoverProvider: true,
  },
  serverInfo: {
    name: 'liquid-embedded-javascript',
    version: '0.1.0',
  },
}));

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const offset = document.offsetAt(params.position);
  const { embedded, fileName, service } = languageServiceFor(document);
  if (!containsOffset(embedded.ranges, offset)) {
    service.dispose();
    return null;
  }

  try {
    const result = service.getCompletionsAtPosition(fileName, offset, {
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
            range: rangeForSpan(document, entry.replacementSpan),
            newText: entry.insertText || entry.name,
          };
        }
        return item;
      }),
    };
  } finally {
    service.dispose();
  }
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const offset = document.offsetAt(params.position);
  const { embedded, fileName, service } = languageServiceFor(document);
  if (!containsOffset(embedded.ranges, offset)) {
    service.dispose();
    return null;
  }

  try {
    const info = service.getQuickInfoAtPosition(fileName, offset);
    if (!info) return null;
    const signature = ts.displayPartsToString(info.displayParts);
    const documentation = ts.displayPartsToString(info.documentation);
    const value = documentation ? `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060\n\n${documentation}` : `\u0060\u0060\u0060javascript\n${signature}\n\u0060\u0060\u0060`;
    return {
      contents: { kind: 'markdown', value },
      range: rangeForSpan(document, info.textSpan),
    };
  } finally {
    service.dispose();
  }
});

documents.onDidOpen(({ document }) => scheduleValidation(document));
documents.onDidChangeContent(({ document }) => scheduleValidation(document));
documents.onDidClose(({ document }) => {
  clearTimeout(validationTimers.get(document.uri));
  validationTimers.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
