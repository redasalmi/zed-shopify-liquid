'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const cargoToml = read('Cargo.toml');
const cargoLock = read('Cargo.lock');
const extensionToml = read('extension.toml');
const rustSource = read('src/liquid.rs');

function quotedValue(source, key) {
  const match = new RegExp(`^${key} = "([^"]+)"$`, 'm').exec(source);
  assert(match, `missing ${key}`);
  return match[1];
}

const cargoVersion = quotedValue(cargoToml, 'version');
const extensionVersion = quotedValue(extensionToml, 'version');
assert.equal(extensionVersion, cargoVersion, 'Cargo and extension versions must match');
assert.match(
  cargoLock,
  new RegExp(`name = "zed_liquid"\\nversion = "${cargoVersion.replaceAll('.', '\\.')}"`),
  'Cargo.lock package version must match Cargo.toml',
);

const grammarCommit = quotedValue(extensionToml, 'commit');
const grammarPackage = packageJson.devDependencies['tree-sitter-liquid'];
assert(grammarPackage.includes(grammarCommit), 'query grammar tarball must match extension.toml');
assert.equal(
  packageJson.allowScripts[grammarPackage],
  false,
  'the unused grammar native binding must remain disabled',
);

for (const [packageName, constantName] of [
  ['@shopify/theme-language-server-node', 'PACKAGE_VERSION'],
  ['typescript', 'TYPESCRIPT_PACKAGE_VERSION'],
  ['@shopify/liquid-html-parser', 'LIQUID_HTML_PARSER_VERSION'],
  ['@shopify/theme-check-docs-updater', 'THEME_CHECK_DOCS_UPDATER_VERSION'],
  ['@shopify/theme-language-server-common', 'THEME_LANGUAGE_SERVER_COMMON_VERSION'],
  ['vscode-css-languageservice', 'VSCODE_CSS_LANGUAGE_SERVICE_VERSION'],
  ['vscode-languageserver', 'VSCODE_LANGUAGE_SERVER_VERSION'],
  ['vscode-languageserver-textdocument', 'VSCODE_LANGUAGE_SERVER_TEXTDOCUMENT_VERSION'],
]) {
  const expected = packageJson.devDependencies[packageName];
  assert(expected, `${packageName} must be listed in devDependencies`);
  const match = new RegExp(`const ${constantName}: &str = "([^"]+)";`).exec(rustSource);
  assert(match, `missing Rust ${constantName}`);
  assert.equal(match[1], expected, `${packageName} must match its Rust runtime pin`);
}

for (const supportFile of [
  'embedded-language.cjs',
  'liquid-document-analysis.cjs',
  'liquid-doc-tools.cjs',
  'theme-roots.cjs',
]) {
  assert(rustSource.includes(`"${supportFile}"`), `${supportFile} must be written by the extension`);
}

const packageManager = /^npm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager);
assert(packageManager, 'packageManager must pin an exact npm release');

if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    `v${cargoVersion}`,
    'release tag must match the extension version',
  );
}

console.log(
  `repository contracts ok: extension=${cargoVersion} Shopify=${packageJson.devDependencies['@shopify/theme-language-server-node']} TypeScript=${packageJson.devDependencies.typescript} grammar=${grammarCommit}`,
);
