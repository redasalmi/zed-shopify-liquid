# Shopify Liquid Extension for Zed

This extension adds syntax highlighting and Shopify's Theme Language Server to
Zed. The language server provides Theme Check diagnostics, completion, hover,
navigation, and editing features using the same core package as Shopify's VS
Code extension.

The extension also provides Liquid-aware indentation, code folding, document
outlines, bracket matching, embedded HTML, CSS, JavaScript, and JSON
highlighting, and modern Theme Blocks syntax such as `content_for`. Bundled
`{% stylesheet %}` blocks support CSS completion, hover, and diagnostics through
Shopify's language server. Bundled `{% javascript %}` blocks additionally
support JavaScript completion, hover, and TypeScript-powered diagnostics.
Schema-derived completion is also available for `section.settings.*` and
`block.settings.*`, including inline blocks declared by a section. Shopify's
language server provides modern `{% schema %}` completion and validation for
`@theme`, `@app`, targeted and nested blocks, and presets. LiquidDoc `@param`
declarations complete every supported primitive and Shopify Liquid object type
inside paired `{}` braces. Typing `@` in LiquidDoc opens Shopify's `@param`,
`@description`, and `@example` snippets, while system-authored `@prompt` blocks
receive dedicated highlighting. Go-to-definition and document links navigate
static `render`, `include`, `section`, and `content_for 'block'` file references.

More work is needed to reach full VS Code parity, so contributions are welcome!

## Configure diagnostics

Theme Check runs on open, change, and save by default. The settings can be
overridden in Zed settings:

```json
"lsp": {
  "liquid": {
    "settings": {
      "themeCheck": {
        "checkOnOpen": true,
        "checkOnChange": true,
        "checkOnSave": true,
        "preloadOnBoot": true
      }
    }
  }
}
```

Malformed HTML and Liquid are reported as diagnostics without stopping the
server. If diagnostics disappear, open Zed's language server logs and restart
the `Shopify Theme Language Server`; existing server files are retained when an
update cannot be downloaded.

If Liquid has an explicit `language_servers` list in Zed settings, include both
`liquid` and `liquid-embedded-javascript`. Lists containing `"..."` include the
embedded server automatically.

The embedded JavaScript server loads TypeScript only when a JavaScript block is
open. For very large themes, setting `themeCheck.preloadOnBoot` to `false`
reduces Shopify language-server startup work and memory at the cost of making
some whole-theme navigation operations slower on first use. Setting
`themeCheck.checkOnChange` to `false` further reduces work while typing while
retaining checks on open and save.

## Configure Prettier formatting and Tailwind LSP

```json
"lsp": {
  "tailwindcss-language-server": {
    "settings": {
      "includeLanguages": {
        "liquid": "html"
      }
    }
  }
},
"languages": {
  "Liquid": {
    "prettier": {
      "allowed": true,
      "plugins": [
        "@shopify/prettier-plugin-liquid",
        "prettier-plugin-tailwindcss"
      ]
    },
    "language_servers": ["tailwindcss-language-server", "..."]
  }
}
```

## Roadmap

The roadmap prioritizes Shopify's current Theme Blocks architecture and reliable,
responsive editing over legacy compound asset modes.

### Foundation

- [x] Shopify Theme Language Server integration and Theme Check diagnostics
- [x] Liquid-aware highlighting, indentation, folding, outlines, and brackets
- [x] Modern `content_for` Theme Blocks syntax
- [x] CSS support in `{% stylesheet %}` blocks
- [x] TypeScript-powered JavaScript support in `{% javascript %}` blocks
- [x] Lazy loading and bounded memory for embedded JavaScript analysis
- [x] Schema-derived `section.settings` and `block.settings` completion

### Next

- [x] Modern `{% schema %}` completion and validation for `@theme`, `@app`,
      targeted blocks, nested blocks, and presets through Shopify's server
- [x] Go-to-definition and document links for snippets, sections, blocks,
      `render`, `include`, `section`, and static `content_for` references
- [x] LiquidDoc tag and type completion, `@prompt` highlighting, hover, and
      render/block parameter semantics
- [ ] Add HTML tag autoclosing and linked opening/closing tag editing
- [ ] Improve embedded CSS and JavaScript formatting, diagnostics, hover, and
      navigation while continuing to profile latency and memory use

### Quality

- [ ] Add query regression fixtures for highlighting, indentation, injections,
      folding, and outlines
- [ ] Add black-box language-server tests for diagnostics, completion, hover,
      links, and embedded assets
- [ ] Consider contributing generally useful grammar improvements upstream

Dedicated `.js.liquid` and `.css.liquid` modes are not planned. These legacy
files remain usable as Liquid, but new work focuses on bundled assets and modern
theme architecture. Platform-controlled settings remain Shopify-owned theme
JSON data; the extension does not duplicate unsupported JSON semantics.

## Development

See [Project History and Architecture](docs/PROJECT_HISTORY.md) for a detailed
comparison with the pre-overhaul extension, completed work, design decisions,
performance notes, and repository relationships. [`AGENTS.md`](AGENTS.md)
provides concise project guidance that Pi and compatible coding agents load in
future sessions.

## Credits

This extension uses a [Shopify-focused grammar fork](https://github.com/redasalmi/tree-sitter-liquid), based on [tree-sitter-liquid](https://github.com/hankthetank27/tree-sitter-liquid), and queries from [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter/tree/master/queries/liquid).
