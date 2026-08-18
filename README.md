# Shopify Liquid Extension for Zed

This extension adds syntax highlighting and Shopify's Theme Language Server to
Zed for Liquid and Shopify theme JSON files. The language server provides Theme
Check diagnostics, completion, hover, navigation, and editing features using the
same core package as [Shopify's VS Code extension](https://github.com/Shopify/theme-tools/tree/main/packages/vscode-extension).

The extension also provides Liquid-aware indentation, code folding, document
outlines, bracket matching, embedded HTML, CSS, JavaScript, and JSON
highlighting, modern Theme Blocks syntax such as `content_for`, and a catalog
of Liquid and Shopify snippets. Typing `if`, `for`, `unless`, `case`, `render`,
or other common prefixes offers ready-to-expand code blocks with tab stops.
Bundled `{% stylesheet %}` blocks support CSS completion, hover, diagnostics, local
custom-property navigation, and selection formatting. Bundled
`{% javascript %}` blocks support JavaScript completion, hover,
TypeScript-powered diagnostics, local symbol navigation, and selection
formatting. Embedded asset semantics apply to Shopify-supported `sections/`,
`blocks/`, and `snippets/` files; invalid tags elsewhere remain Shopify Theme
Check diagnostics only.
Schema-derived completion is also available for `section.settings.*` and
`block.settings.*`, including inline blocks declared by a section. Shopify's
language server provides modern `{% schema %}` completion and validation for
`@theme`, `@app`, targeted and nested blocks, and presets. LiquidDoc `@param`
declarations complete every supported primitive, array, and Shopify Liquid
object type inside paired `{}` braces. Typing `@` in LiquidDoc opens Shopify's
`@param`,
`@description`, and `@example` snippets, while system-authored `@prompt` blocks
receive dedicated highlighting. Go-to-definition and document links navigate
static `render`, `include`, `section`, `content_for 'block'`, and `asset_url` file references.
HTML opening tags autoclose, and renaming an opening or closing tag updates its
linked counterpart through Shopify's language server.

The extension follows [Shopify Theme Tools](https://github.com/Shopify/theme-tools)
for language-server behavior while adding Zed-specific Tree-sitter queries and
embedded-language integration. Contributions are welcome!

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
embedded server automatically. If JSON has an explicit list, include `liquid`
to retain Shopify's theme JSON completion and navigation.

The embedded JavaScript server loads TypeScript only when a JavaScript block is
open and releases its analysis state 30 seconds after the final JavaScript
document becomes inactive. TypeScript semantics and the extension's
supplemental CSS navigation/formatting are limited to Shopify-supported
`sections/`, `blocks/`, and `snippets/` files. Shopify's own stylesheet provider
may still provide CSS completion, hover, and diagnostics in other Liquid files.
To protect the editor process, documents over 2 MiB
or embedded blocks over 512 KiB receive an informational diagnostic instead of
loading embedded semantics. For very large themes, setting
`themeCheck.preloadOnBoot` to `false`
reduces Shopify language-server startup work and memory at the cost of making
some whole-theme navigation operations slower on first use. Setting
`themeCheck.checkOnChange` to `false` further reduces work while typing while
retaining checks on open and save.

## Configure Prettier formatting and Tailwind LSP

The language server formats selections contained in bundled stylesheet and
JavaScript blocks. Use Shopify's Prettier plugin when formatting the complete
Liquid document.

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

- [x] Shopify Theme Language Server integration for Liquid and theme JSON,
      including Theme Check diagnostics
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
      `render`, `include`, `section`, static `content_for`, and `asset_url` references
- [x] LiquidDoc tag and type completion, `@prompt` highlighting, hover, and
      render/block parameter semantics
- [x] HTML tag autoclosing and linked opening/closing tag editing through
      Shopify's language server
- [x] Embedded CSS and JavaScript selection formatting, diagnostics, hover, and
      local navigation with lazy services and bounded memory

### Quality

- [x] Black-box protocol tests for extension-owned language-server behavior and
      a minimal Shopify integration smoke suite
- [x] Curated query regression fixtures for highlighting, injections,
      indentation, folding, and outlines
- [x] Repeatable embedded-server stress coverage for bounded memory and
      stale-state regressions

Generally useful grammar changes should be contributed upstream when practical;
Shopify- or Zed-specific behavior remains local.

Dedicated `.js.liquid` and `.css.liquid` modes are not planned. These legacy
files remain usable as Liquid, but new work focuses on bundled assets and modern
theme architecture. Platform-controlled settings remain Shopify-owned theme
JSON data; the extension delegates their JSON semantics to Shopify's server and
does not maintain a parallel implementation.

### Differences from Shopify's VS Code extension

The extension reuses Shopify's language server, but Zed does not currently have
equivalents for the VS Code Theme Graph views, dead-code command, browser/VFS
filesystem adapter, or bundled Prettier provider. Full-document formatting uses
Zed's Prettier integration, so themes should install
`@shopify/prettier-plugin-liquid` and configure it as shown above. Shopify JSON
providers remain quiet for unrelated JSON files even though Zed's manifest
associates the server with the general `JSON` language.

## Development

Using Node.js 22 or newer and npm 11.17.0, install the test
dependencies and run the protocol and query suites. The grammar's unused native
Node binding is disabled, so this test install does not require a C++ toolchain:

```sh
npm ci
npm test
```

Run the embedded-server stress workload independently with `npm run test:stress`.
The enforced budgets and optimization strategy are documented in the
[Performance Plan](docs/PERFORMANCE.md).

See [Project History and Architecture](docs/PROJECT_HISTORY.md) for a detailed
comparison with the pre-overhaul extension, completed work, design decisions,
performance notes, and repository relationships. The
[Release Checklist](docs/RELEASE.md) records the automated and Zed-host release
gates. [`AGENTS.md`](AGENTS.md) provides concise project guidance that Pi and
compatible coding agents load in future sessions.

## Credits

This extension uses a [Shopify-focused grammar fork](https://github.com/redasalmi/tree-sitter-liquid), based on [tree-sitter-liquid](https://github.com/hankthetank27/tree-sitter-liquid), and queries from [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter/tree/master/queries/liquid).
