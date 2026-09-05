'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const schemaLocales = new Map();
let nextLocaleVersion = 0;
const MAX_CACHED_LOCALES = 16;
const MAX_LOCALE_BYTES = 1024 * 1024;

function clearSchemaLocaleCaches() {
  schemaLocales.clear();
}

async function readSchemaLocale(root) {
  try {
    const directory = path.join(root, 'locales');
    const names = await fs.readdir(directory);
    const name = names.filter((name) => name.endsWith('.default.schema.json')).sort()[0];
    if (!name) return {};
    const file = await fs.open(path.join(directory, name), 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_LOCALE_BYTES) return {};
      // A bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > stat.size) return {};
      // Shopify locales allow comments and trailing commas. Load the existing
      // public parser lazily, but reject genuinely malformed JSONC rather than
      // displaying translations recovered from an incomplete file.
      const { parseJSON } = require('@shopify/theme-language-server-common');
      return parseJSON(buffer.toString('utf8', 0, bytesRead), {}, true);
    } finally {
      await file.close();
    }
  } catch (_error) {
    // Missing, malformed, or oversized locales must not break completion.
    return {};
  }
}

function schemaLocale(root) {
  let locale = schemaLocales.get(root);
  if (!locale) {
    const version = ++nextLocaleVersion;
    locale = readSchemaLocale(root).then((data) => ({ version, data }));
  }
  schemaLocales.delete(root);
  schemaLocales.set(root, locale);
  while (schemaLocales.size > MAX_CACHED_LOCALES) {
    schemaLocales.delete(schemaLocales.keys().next().value);
  }
  return locale;
}

function settingDocumentation(setting, locale) {
  return [setting.label, setting.info].map((value) => {
    if (typeof value !== 'string') return '';
    if (!value.startsWith('t:')) return value;
    let translated = locale;
    for (const part of value.slice(2).split('.')) {
      if (!translated || typeof translated !== 'object' ||
          !Object.hasOwn(translated, part)) return '';
      translated = translated[part];
    }
    return typeof translated === 'string' ? translated : '';
  }).filter(Boolean).join('\n\n');
}

function schemaSettingLocations(source) {
  // Called only for a schema already validated with JSON.parse. Tokenize that
  // JSON to retain exact UTF-16 positions without a second JSON dependency or
  // a full retained AST. Paths distinguish settings from presets and other ids.
  const locations = [];
  const stack = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    const frame = stack.at(-1);
    if (token === '}' || token === ']') {
      stack.pop();
      continue;
    }
    if (token === ':') continue;
    if (token === ',') {
      if (frame?.kind === 'object') frame.expectingKey = true;
      continue;
    }
    if (frame?.kind === 'object' && frame.expectingKey) {
      frame.key = JSON.parse(token);
      frame.expectingKey = false;
      continue;
    }
    const valuePath = frame
      ? [...frame.path, frame.kind === 'array' ? frame.index++ : frame.key]
      : [];
    if (token === '{' || token === '[') {
      // Unusually deep schemas are not useful setting-navigation targets.
      if (stack.length >= 64) return [];
      stack.push({
        path: valuePath,
        kind: token === '{' ? 'object' : 'array',
        expectingKey: token === '{',
        index: 0,
      });
      continue;
    }
    const localSetting = valuePath.length === 3 && valuePath[0] === 'settings' &&
      typeof valuePath[1] === 'number' && valuePath[2] === 'id';
    const inlineSetting = valuePath.length === 5 && valuePath[0] === 'blocks' &&
      typeof valuePath[1] === 'number' && valuePath[2] === 'settings' &&
      typeof valuePath[3] === 'number' && valuePath[4] === 'id';
    if ((localSetting || inlineSetting) && token.startsWith('"')) {
      locations.push({
        id: JSON.parse(token),
        inlineBlock: inlineSetting,
        start: match.index + 1,
        end: match.index + token.length - 1,
      });
    }
  }
  return locations;
}

module.exports = {
  clearSchemaLocaleCaches,
  schemaLocale,
  schemaSettingLocations,
  settingDocumentation,
};
