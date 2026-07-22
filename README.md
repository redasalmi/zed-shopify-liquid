# Shopify Liquid Extension for Zed

This extension adds syntax highlighting and Shopify's Theme Language Server to
Zed. The language server provides Theme Check diagnostics, completion, hover,
navigation, and editing features using the same core package as Shopify's VS
Code extension.

The extension also provides Liquid-aware indentation, code folding, document
outlines, bracket matching, and embedded HTML, CSS, JavaScript, and JSON
highlighting.

More work is needed to reach full VS Code parity, so contributions are welcome!

> [!CAUTION]
> The injections.scm used by this plugin considers the template
> content to only be HTML.
>
> *.js.liquid will not have correctly highlighted JS. No info is derived
> from the file extension to set the base file type.
>
> How to deal with this will come in the future.

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

This extension uses [grammar](https://github.com/hankthetank27/tree-sitter-liquid) and queries from [nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter/tree/master/queries/liquid)
