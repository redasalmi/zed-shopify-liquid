# Shopify Liquid Extension Development

## Purpose

Maintain fast, reliable Shopify Liquid support for Zed, using [Shopify Theme
Tools and its VS Code extension](https://github.com/Shopify/theme-tools) as
behavioral references. Prioritize the current Theme Blocks architecture rather
than legacy compound asset modes.

Read [`docs/PROJECT_HISTORY.md`](docs/PROJECT_HISTORY.md) before substantial
changes. It records the baseline, implemented work, architecture, and important
decisions. Keep it updated when a change materially alters behavior or design.

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
- The embedded support server provides lightweight schema-derived setting
  completion and TypeScript semantics restricted to `{% javascript %}` content.
  TypeScript must remain lazy, incremental, and bounded in memory. Avoid
  per-request TypeScript language services.
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

## Documentation

- Keep `README.md` user-facing: capabilities, configuration, roadmap, and links.
- Record completed architectural work and decisions in
  `docs/PROJECT_HISTORY.md`.
- Bump `Cargo.toml`, `Cargo.lock`, and `extension.toml` together when releasing a
  new extension version.
