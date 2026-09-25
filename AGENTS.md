# Shopify Liquid Extension Development

## Purpose

Maintain fast, reliable Shopify Liquid support for Zed, using [Shopify Theme
Tools and its VS Code extension](https://github.com/Shopify/theme-tools) as
behavioral references. Prioritize the current Theme Blocks architecture rather
than legacy compound asset modes.

## Related repositories and fixtures

- Extension: this repository
- Shopify Theme Tools and VS Code reference: https://github.com/Shopify/theme-tools
- Shopify-focused grammar checkout: `grammars/liquid` (a separate Git repository)
- Grammar fork: `https://github.com/redasalmi/tree-sitter-liquid`
- Grammar upstream: `https://github.com/hankthetank27/tree-sitter-liquid`
- Extension fixtures: `tests/queries/fixtures` and `tests/language-server`

There is no required local Theme Tools or representative-theme checkout; use
Shopify's repository and the checked-in fixtures above.

## Architecture and constraints

- Run `@shopify/theme-language-server-node` directly; do not restore the full
  `@shopify/cli` bootstrap path.
- Keep Shopify's server settings at the workspace-configuration root. Do not
  nest `themeCheck.*` under a `liquid` key.
- Preserve installed language-server files when an update fails and the existing
  installation is usable.
- Delegate to Shopify's server; do not duplicate its completion, validation,
  navigation, links, or HTML editing providers. The embedded support server
  (`liquid-embedded-javascript`) only fills gaps confirmed by protocol tests:
  - `block.settings.*` completion for inline blocks declared by a section
    (Shopify completes section and Theme Block settings);
  - setting-ID and static file definitions (Shopify's definition provider only
    resolves translation keys; it still owns document links);
  - LiquidDoc `@` tag completion (Zed's trigger request receives none) and type
    completion inside autoclosed `{}` (Shopify handles only an unfinished `{`);
  - CSS custom-property definitions and range formatting in `{% stylesheet %}`
    (Shopify owns CSS completion, hover, and diagnostics);
  - all JavaScript semantics in `{% javascript %}`.
- Embedded semantics apply only to `sections/`, `blocks/`, and `snippets/` files
  of a directory with theme evidence, and only to the first tag of each kind.
  Virtual documents preserve Liquid source offsets; JavaScript is wrapped in a
  function, as Shopify bundles it.
- TypeScript must remain lazy, incremental, shared, and bounded in memory (128
  MiB V8 heap). Avoid per-request language services. `npm run test:stress`
  enforces the RSS budgets; keep optimizations only when they improve a
  measured workload.
- The embedded server imports only TypeScript and the packages pinned in
  `SUPPORT_PACKAGES`; a Rust test enforces this. TypeScript stays on 5.x because
  TypeScript 7's CommonJS package lacks the language-service API.
- Zed does not restart a language server after it exits: log unhandled
  rejections and exit only on uncaught exceptions.
- Zed ignores `#set! priority` and paints the last matching capture. Order
  highlight queries from generic to specific.
- Full-document formatting belongs to Zed's Prettier integration with
  `@shopify/prettier-plugin-liquid`.
- Tree-sitter queries provide highlighting, injections, indentation, outlines,
  folding structure, and brackets. LSPs provide semantic editor behavior.
- Modern priorities include `content_for`, Theme Blocks, schema authoring,
  bundled `{% stylesheet %}` / `{% javascript %}`, and LiquidDoc.
- Do not add dedicated `.js.liquid` or `.css.liquid` modes.
- Preserve public behavior and use targeted, maintainable changes.

## Grammar changes

`grammars/liquid` is a separate checkout. For grammar work:

1. Add or update corpus fixtures.
2. Run `npm test` and `cargo test` in `grammars/liquid`.
3. Commit and push the grammar repository separately.
4. Pin the resulting grammar commit in `extension.toml`.
5. Ensure its `origin` remains the Shopify-focused fork and `upstream` remains
   the original grammar repository.

Keep the fork small: change it only where upstream lacks Shopify syntax, and
contribute generally useful fixes upstream when practical.

## Validation

Run the cheapest relevant checks first. Before completing a normal extension
change, use the applicable subset of:

```sh
cargo fmt --check
cargo test
node --check language-server/*.cjs
npm test
cargo build --release --target wasm32-wasip1
git diff --check
```

Also parse changed TOML, compile changed tree-sitter queries, and run grammar
corpus tests when relevant. For language-server changes, use a protocol-level
fixture before relying on a manual Zed check. Finish editor-visible changes by
rebuilding the development extension and testing them in Zed.

## Zed smoke test

No headless Zed extension host exists, so run this before a release. Build
`wasm32-wasip2`, install the repository as a development extension, and in a
temporary theme verify:

1. Both servers start and installation status clears. Liquid and theme JSON
   complete; an unrelated `package.json` receives no Shopify completions.
2. In `sections/`, `{% javascript %}` has completion, hover, diagnostics,
   definition, signature help, references, rename (refused for globals and
   imports), and range formatting. Repairing `javascrip` activates it without
   reopening.
3. Static file, setting-ID, and CSS custom-property definitions work; nested
   snippets resolve and traversal references do not. Saving a default schema
   locale updates inline-block completion documentation.
4. No embedded results appear at closing tags or in an unrelated directory named
   `sections`.
5. Properties, argument keys, `blank`, and comment/doc delimiters use their
   intended colors.
6. Full-document Prettier formatting with the Shopify plugin works.
7. Restarting both servers offline keeps existing installations.

## Documentation

- Keep `README.md` user-facing: capabilities, configuration, roadmap, and links.
- Record lasting design decisions as constraints in this file; history belongs
  in commit messages.
- Bump `Cargo.toml`, `Cargo.lock`, and `extension.toml` together when releasing a
  new extension version; CI rejects a `v*` tag that does not match.
