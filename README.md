# Shopify Liquid Extension for Zed

This extension adds syntax highlighting and Shopify's Theme Language Server to
Zed. The language server provides Theme Check diagnostics, completion, hover,
navigation, and editing features using the same core package as Shopify's VS
Code extension.

The extension also provides Liquid-aware indentation, code folding, document
outlines, bracket matching, embedded HTML, CSS, JavaScript, and JSON
highlighting, and modern Theme Blocks syntax such as `content_for`.

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

## Configure Prettier formatting and Tailwind LSP
``` json
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

## Credits

This extension uses a [Shopify-focused grammar fork](https://github.com/redasalmi/tree-sitter-liquid), based on [tree-sitter-liquid](https://github.com/hankthetank27/tree-sitter-liquid), and queries from [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter/tree/master/queries/liquid).
