# Release Checklist

CI validates the locked dependency graph, repository version contracts,
language-server protocol contracts, Tree-sitter queries, Rust tests, TOML, and
the release WASM builds. Tag builds retain both WASI artifacts for 30 days. Zed does not
currently provide this repository with a headless extension-host harness, so the
host integration remains an explicit release gate rather than an implicit
assumption.

## Automated checks

From a clean checkout with Node.js 22+ and npm 11.17.0, run:

```sh
npm ci
npm run check:repository
npm test
npm audit
node --check language-server/embedded-javascript-server.cjs
cargo fmt --check
cargo test --locked
cargo build --locked --release --target wasm32-wasip1
cargo build --locked --release --target wasm32-wasip2
git diff --check
```

When the grammar pin changes, also run `npm test` and `cargo test` in the
separate `grammars/liquid` checkout before committing and pushing that
repository.

## Zed host smoke test

1. Build `wasm32-wasip2` and install this repository as a Zed development
   extension. Current Zed releases load the Preview 2 component; the Preview 1
   build remains a compatibility validation.
2. Confirm both **Shopify Theme Language Server** and **Liquid Embedded
   Support** start without installation status remaining visible.
3. Open the fixtures under `tests/language-server` in a temporary theme and
   verify Liquid and theme JSON completion. Confirm an unrelated `package.json`
   does not show Shopify JSON completions.
4. In a file under `sections/`, verify JavaScript completion, hover,
   diagnostics, definition, and range formatting inside `{% javascript %}`.
   Verify `render 'cards/product'` navigates to nested snippets and traversal
   references do not leave the theme root.
5. Verify CSS custom-property definition and range formatting inside
   `{% stylesheet %}`.
6. Verify no embedded results appear at either closing tag or in an unrelated
   directory merely named `sections`.
7. Configure `@shopify/prettier-plugin-liquid` in the theme, format a complete
   Liquid document through Zed's Prettier integration, and verify embedded
   stylesheet and JavaScript range formatting remains available.
8. Disable networking, restart both servers, and confirm existing usable
   installations are retained.

## Version and artifact checks

- Update `Cargo.toml`, `Cargo.lock`, and `extension.toml` together; CI rejects a
  `v*` tag that does not match their version.
- The generated embedded server receives `CARGO_PKG_VERSION`; do not add a
  separate hard-coded protocol version.
- Confirm the grammar commit in `extension.toml` matches the tarball commit in
  `package.json`.
- Reinstall the development extension after the release WASM build and repeat
  the host smoke test before tagging the release.
