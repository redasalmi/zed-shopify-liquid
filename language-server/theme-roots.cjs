'use strict';

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

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

let workspaceRoots = [];
let workspaceRootsInitialized = false;
const themeEvidenceCache = new Map();
const standardFileRootCache = new Map();
const inferredThemeRootCache = new Map();

function isWithinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalizeRoots(roots) {
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function clearThemeRootCaches() {
  themeEvidenceCache.clear();
  standardFileRootCache.clear();
  inferredThemeRootCache.clear();
}

function setWorkspaceRoots(roots, scoped = roots.length > 0) {
  workspaceRootsInitialized = scoped;
  workspaceRoots = normalizeRoots(roots);
  clearThemeRootCaches();
}

function getWorkspaceRoots() {
  return workspaceRoots;
}

function updateWorkspaceRoots(added, removed) {
  const removedRoots = new Set(normalizeRoots(removed));
  setWorkspaceRoots(
    [
      ...workspaceRoots.filter((root) => !removedRoots.has(root)),
      ...added,
    ],
    true,
  );
}

function belongsToWorkspace(fileName) {
  return (
    !workspaceRootsInitialized ||
    workspaceRoots.some((root) => isWithinDirectory(root, fileName))
  );
}

function hasThemeEvidence(root) {
  if (themeEvidenceCache.has(root)) return themeEvidenceCache.get(root);
  const result = ['.theme-check.yml', 'config', 'layout', 'templates'].some((entry) =>
    fsSync.existsSync(path.join(root, entry)),
  );
  themeEvidenceCache.set(root, result);
  return result;
}

function themeRootForStandardFile(fileName, directories) {
  const directoryKey = [...directories].sort().join(',');
  const cacheKey = `${directoryKey}\0${fileName}`;
  if (standardFileRootCache.has(cacheKey)) return standardFileRootCache.get(cacheKey);

  const assetDirectory = path.dirname(fileName);
  let result = null;
  if (
    directories.has(path.basename(assetDirectory)) &&
    belongsToWorkspace(fileName)
  ) {
    const possibleThemeRoot = path.dirname(assetDirectory);
    if (hasThemeEvidence(possibleThemeRoot)) result = possibleThemeRoot;
  }
  standardFileRootCache.set(cacheKey, result);
  return result;
}

function fileSupportsLiquidDoc(fileName) {
  return Boolean(themeRootForStandardFile(fileName, LIQUID_DOC_THEME_DIRECTORIES));
}

function fileSupportsEmbeddedAssets(fileName) {
  return Boolean(themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES));
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
      // Continue toward the filesystem root when this directory has no config.
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function computeThemeRootForFile(fileName) {
  if (!belongsToWorkspace(fileName)) return null;

  const configuredRoot = await configuredThemeRootForFile(fileName);
  if (
    configuredRoot &&
    (!workspaceRootsInitialized ||
      workspaceRoots.some((root) => isWithinDirectory(root, configuredRoot)))
  ) {
    return configuredRoot;
  }

  let directory = path.dirname(fileName);
  while (true) {
    if (THEME_DIRECTORIES.has(path.basename(directory))) {
      const root = path.dirname(directory);
      return hasThemeEvidence(root) ? root : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function themeRootForFile(fileName) {
  if (!inferredThemeRootCache.has(fileName)) {
    inferredThemeRootCache.set(fileName, computeThemeRootForFile(fileName));
  }
  return inferredThemeRootCache.get(fileName);
}

module.exports = {
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
};
