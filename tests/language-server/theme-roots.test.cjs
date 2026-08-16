'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EMBEDDED_THEME_DIRECTORIES,
  clearThemeRootCaches,
  setWorkspaceRoots,
  themeRootForFile,
  themeRootForStandardFile,
  updateWorkspaceRoots,
} = require('../../language-server/theme-roots.cjs');

test('theme-root evidence is cached and explicitly invalidated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zed-liquid-root-cache-'));
  const sections = path.join(root, 'sections');
  const fileName = path.join(sections, 'example.liquid');
  await mkdir(sections);
  await writeFile(fileName, '');
  setWorkspaceRoots([root]);

  try {
    assert.equal(themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES), null);
    await mkdir(path.join(root, 'config'));
    assert.equal(
      themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES),
      null,
      'filesystem checks should remain cached until a watched-file invalidation',
    );
    clearThemeRootCaches();
    assert.equal(themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES), root);

    updateWorkspaceRoots([], [root]);
    assert.equal(themeRootForStandardFile(fileName, EMBEDDED_THEME_DIRECTORIES), null);
  } finally {
    setWorkspaceRoots([]);
    await rm(root, { recursive: true, force: true });
  }
});

test('configured Theme Check roots are refreshed after invalidation', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'zed-liquid-config-cache-'));
  const sourceDirectory = path.join(workspace, 'src', 'sections');
  const fileName = path.join(sourceDirectory, 'example.liquid');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(path.join(workspace, 'dist-a'));
  await mkdir(path.join(workspace, 'dist-b'));
  await writeFile(fileName, '');
  await writeFile(path.join(workspace, '.theme-check.yml'), 'root: dist-a\n');
  setWorkspaceRoots([workspace]);

  try {
    assert.equal(await themeRootForFile(fileName), path.join(workspace, 'dist-a'));
    await writeFile(path.join(workspace, '.theme-check.yml'), 'root: dist-b\n');
    assert.equal(
      await themeRootForFile(fileName),
      path.join(workspace, 'dist-a'),
      'async root resolution should use its cache before invalidation',
    );
    clearThemeRootCaches();
    assert.equal(await themeRootForFile(fileName), path.join(workspace, 'dist-b'));
  } finally {
    setWorkspaceRoots([]);
    await rm(workspace, { recursive: true, force: true });
  }
});
