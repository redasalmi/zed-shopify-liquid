# Project History and Architecture

This document records how the extension differs from its pre-overhaul state and
why the current architecture exists. It is intended for maintainers and future
coding-agent sessions. User-facing capabilities and planned work remain in the
[README](../README.md).

## Comparison baseline

The practical comparison baseline is commit `d622732` (`v0.7.0`), the last
release before the focused reliability and modern Shopify architecture work.
At that point, the extension:

- provided Liquid syntax highlighting and basic injections;
- used `hankthetank27/tree-sitter-liquid` directly;
- launched the language server through the full `@shopify/cli` package;
- nested workspace settings under `liquid`, which prevented Shopify's server
  from receiving `themeCheck.*` configuration correctly;
- had bracket queries and early LiquidDoc highlighting;
- did not provide Liquid-aware indentation, outlines, modern `content_for`
  parsing, object-property completion fixes, or embedded JavaScript semantics.

The repository itself predates that baseline. Its initial commit contained only
an extension manifest, after which syntax support, Shopify LSP integration,
front matter, bundled stylesheet highlighting, and LiquidDoc support were added
incrementally by the original maintainers.

## Completed overhaul

### Language-server reliability — `26b9ca4`

- Replaced the full Shopify CLI bootstrap with direct, pinned use of
  `@shopify/theme-language-server-node@2.22.0`.
- Added a generated Node wrapper that starts Shopify's server directly and logs
  uncaught exceptions and rejected promises without contaminating LSP stdout.
- Corrected workspace configuration so `themeCheck.*` remains at the root.
- Added initialization-options passthrough.
- Removed panic-prone startup handling.
- Retained existing usable server and TypeScript installations when an update
  fails.
- Added Rust coverage for startup, package paths, configuration, and failure
  handling.

### Liquid editing and navigation — `c6ffe1b`

- Added Liquid-aware indentation.
- Added indentation-based folding behavior.
- Added outlines for composition tags, assignments, loops, forms, embedded
  blocks, and conditional constructs.
- Expanded bracket matching and autoclosing for Liquid delimiters and common
  punctuation.
- Improved property, loop-variable, custom-tag, and Liquid literal highlighting.
- Added Prettier parser metadata and completion-query configuration.

### Modern Theme Blocks — `1717e7b`

- Added first-class grammar support for dynamic and static `content_for` forms,
  including named parameters, `closest.*` paths, multiline and partially typed
  expressions, and `{% liquid %}` usage.
- Added `content_for` highlighting and outline entries. Static block entries use
  their `type` argument as the outline name.
- Created the Shopify-focused grammar fork at
  `redasalmi/tree-sitter-liquid` because the original grammar did not parse this
  syntax as a first-class construct.
- Fixed the grammar's Rust build to compile its external scanner.
- Added corpus fixtures and checked representative syntax from a modern Shopify
  theme.
- Pinned grammar commit `e229daeca9b64337451e02db52b1b92da77961b2`.

The grammar checkout under `grammars/liquid` is a separate Git repository. Its
`origin` is the Shopify-focused fork and its `upstream` is the original grammar.
Grammar changes must be committed there first and then pinned in this extension.

### Modern schema authoring

The pinned Shopify language server already supplies completion and validation
for modern `{% schema %}` constructs, including `@theme`, `@app`, targeted and
private block files, nested preset blocks, and preset setting ids. Protocol-level
verification confirmed that these providers discover block files from the current
theme and correctly exclude private blocks from unrestricted preset choices.
The extension delegates this behavior to Shopify rather than maintaining a
parallel schema implementation.

Platform-controlled custom CSS is Shopify-owned data in `settings_data.json`
and JSON template section instances, not a user-authored `{% schema %}` setting.
The official Shopify server is attached to Liquid and theme JSON documents, so
JSON completion and navigation remain Shopify-owned rather than being
reimplemented by the extension.

### Shopify object completion — `ffe94e8`

Shopify's server already returned object properties such as the 44 documented
`product` fields. Zed hid those results because `.` was configured as a
completion query character and filtered labels such as `title` against the full
text `product.`. Removing `.` restored object-property completion while keeping
hyphenated Liquid queries usable.

### Embedded assets — `d30e560`

- Retained Shopify's CSS completion, hover, and diagnostics inside bundled
  `{% stylesheet %}` blocks.
- Added a second language server for bundled `{% javascript %}` blocks.
- Used TypeScript's JavaScript language-service API for browser-aware completion,
  hover, syntactic diagnostics, and semantic diagnostics.
- Preserved source offsets by masking non-JavaScript content in virtual
  documents.
- Uses Shopify's tolerant Liquid parser to identify raw tag bodies, avoiding
  embedded providers inside comments, raw content, and documentation examples.
- Restricted embedded results and diagnostics to supported asset block ranges.
- Restricted bundled asset semantics to Shopify's `sections/`, `blocks/`, and
  `snippets/` directories, and analyze only the first asset tag of each kind
  because Shopify permits one `{% javascript %}` and one `{% stylesheet %}` per
  file.
- Modelled Shopify's anonymous JavaScript wrapper with offset-preserving virtual
  source tokens, so valid statements such as `return` retain the same Liquid
  source ranges while receiving function-body semantics.
- Added support for whitespace-trimmed JavaScript delimiters.
- Pinned TypeScript `5.9.3`; TypeScript 7's current CommonJS package does not
  expose the stable JavaScript language-service API used here.

Users with an explicit Zed `language_servers` list must include both `liquid`
and `liquid-embedded-javascript`; a `"..."` entry includes both automatically.

### Embedded-server performance — `671cbf3`

The first embedded JavaScript implementation created and disposed a TypeScript
language service for each request. In a live Zed session its RSS grew to roughly
700 MB. The optimized implementation:

- shares one incremental TypeScript service across open Liquid documents;
- loads TypeScript only when a JavaScript block needs analysis;
- avoids creating virtual source for files without JavaScript blocks;
- does not invalidate the TypeScript project for unrelated Liquid/HTML edits;
- caches standard-library snapshots;
- debounces diagnostics so completion remains responsive;
- bounds V8's old-generation heap at 128 MB;
- disposes the service during shutdown.

A local stress run of 501 document changes and completion requests measured
approximately 6.5 ms per request on average, about 213 MB active RSS, and about
60 MB idle RSS before TypeScript was loaded. These figures are development
measurements rather than cross-platform guarantees.

Subsequent hardening added per-document snapshot caching, embedded-range change
detection that ignores unrelated prefix/suffix edits, lazy reusable JavaScript
and CSS virtual documents, and idle TypeScript disposal with lazy recreation.
Current budgets and workloads live in
[`PERFORMANCE.md`](PERFORMANCE.md).

### Embedded navigation and range formatting

Shopify's language server remains responsible for completion, hover, and
diagnostics in bundled stylesheet blocks. Its definition provider does not
expose CSS navigation, and it exposes no document or range formatter. The
embedded support server therefore supplements only the missing capabilities:
go-to-definition for local CSS custom properties, go-to-definition for local
JavaScript symbols, and selection formatting constrained to `{% stylesheet %}`
and `{% javascript %}` content. Full-document formatting remains delegated to
Shopify's Prettier plugin so HTML and Liquid are formatted coherently with the
embedded assets.

CSS and TypeScript services load lazily on the first relevant request, virtual
documents preserve Liquid source offsets, and formatting edits that escape an
embedded range are discarded. A local mixed workload of 200 CSS/JavaScript
definition and formatting requests averaged about 0.85 ms per request. RSS was
about 64 MB before either service loaded, 211 MB after warm-up, and 217 MB after
the run under the existing 128 MB V8 old-generation limit. These are local
development measurements rather than cross-platform guarantees.

### Schema-derived setting completion — `0.12.0`

Shopify's server returns local `section.settings.*` properties in section files
and local `block.settings.*` properties in Theme Block files. The embedded
support server fills an upstream gap for traditional inline blocks declared
inside a section: because the exact `block.type` is not always statically
narrowable, completion offers the deduped union of setting ids declared across
that section's block definitions. It deliberately leaves local section and
Theme Block completion to Shopify's server to avoid duplicate entries in Zed.

The supplemental provider parses an unchanged schema only once, provides
setting type and human-readable label information, suppresses untranslated
`t:` label and info keys, emits no replacement ranges that Zed could reject,
and does not load TypeScript. A protocol test covering inline section-block
settings used about 63 MB RSS.

### LiquidDoc parameter type completion

The embedded support server supplements Shopify's LiquidDoc completion when
Zed autocloses the type braces in `@param {} name`. Shopify's provider handles
an unfinished `{`, but not a cursor before an existing `}`. The supplemental
provider offers the four primitive LiquidDoc types, their one-dimensional array
forms, and every Shopify Liquid object type with its array form, reading
Shopify's updated documentation cache with the pinned package data as an
offline fallback. It replaces the typed prefix in the paired-brace completion
range so partially typed types are not duplicated. It remains limited to
LiquidDoc-capable snippet and Theme Block files and does not load TypeScript.

### LiquidDoc tags and parameter semantics

Shopify's language server remains responsible for LiquidDoc tag hover and for
using documented parameters in `render` and static `content_for` completion,
hover, rename, and Theme Check diagnostics. Protocol verification confirmed its
hover and render-parameter providers. Its advertised `@` trigger returned no tag
completions through Zed's trigger request, despite the underlying provider
support, so the embedded server fills only that integration gap. It imports
Shopify's own supported handles, documentation, and snippet templates and runs
only for an `@` trigger at the start of a LiquidDoc line.

The grammar now recognizes Shopify's system-controlled `@prompt` annotation and
highlights its free-form content. Prompt and example content preserve unknown
`@words`, email addresses, braces, and embedded Liquid while still ending at the
next supported annotation. This matches the annotation already parsed by
Shopify's Liquid parser and highlighted by Shopify's TextMate grammar without
exposing it as a public completion tag.

### Static file navigation

Shopify's language server remains the owner of document links for static
`render`, `include`, `section`, asset, schema block, and `content_for 'block'`
references. Its definition provider only resolves translation keys, however, so
the embedded support server fills that confirmed gap for snippet, section, and
static block file references. It uses Shopify's tolerant Liquid parser lazily,
returns definitions only for files that exist, supports references inside
`{% liquid %}`, honors the `root` value in the nearest `.theme-check.yml`, and
otherwise infers the nearest root from standard theme directories so nested
themes do not resolve references from an unrelated parent theme.

### HTML tag editing

Shopify's language server already provides HTML element autoclosing through
`textDocument/onTypeFormatting` and synchronized opening/closing tag names
through `textDocument/linkedEditingRange`. Protocol fixtures confirmed both the
closing-tag edit returned after typing `>` and the paired name ranges returned
inside an existing element. Zed enables on-type formatting and linked edits by
default, so the extension delegates both features to Shopify without adding a
second parser or provider. Users can still override Zed's `use_on_type_format`
or `linked_edits` settings.

### Language-server protocol contracts

A persistent Node test harness now launches both language servers over stdio,
implements the client-side workspace requests they require, and exercises them
against temporary Shopify theme roots. The embedded-server suite covers inline
block settings, LiquidDoc tags and paired-brace primitive/object/array types,
JavaScript completion, hover, diagnostics and definitions,
Shopify-supported embedded-file boundaries,
function-wrapper semantics, duplicate-tag isolation, CSS custom-property
definitions, embedded range boundaries, static Liquid file definitions,
configured Theme Check roots, and nearest-theme-root isolation. A deliberately
small Shopify smoke suite checks the pinned server's capabilities plus
representative Liquid and JSON completion, hover, diagnostics, document links,
HTML autoclosing, and linked tag editing without duplicating Shopify's
provider-level test suite.

The test dependencies pin the same Shopify server and TypeScript versions used
by the extension. `npm run test:lsp` is the deterministic protocol command; Zed
remains the final host-level check.

### Tree-sitter query contracts

Grammar corpus tests validate syntax trees but not the captures consumed by Zed.
A pinned Tree-sitter CLI now executes the extension's actual highlight,
injection, indent, and outline queries against a curated modern Liquid fixture.
The test package downloads the exact grammar commit pinned in `extension.toml`,
and a Rust test prevents those pins from drifting.
The fixture covers front matter, LiquidDoc annotations, composition tags,
`content_for`, assignments, loops, conditional branches, HTML, bundled CSS and
JavaScript, and schema JSON. Tests assert semantic captures, embedded-language
boundaries, outline names, and complete paired-statement indent regions that
also provide Zed's folding structure. `npm test` runs both query and protocol
contracts.

### Embedded-server stress contract

The repeatable stress suite first applies 150 updates to a 64 KiB plain Liquid
document and verifies that embedded services remain unloaded. Its primary load
applies 300 unique full-document JavaScript updates and forces incremental
completion and definition work after each change. Before that load it verifies
that removed declarations disappear from definitions and become diagnostics,
that obsolete diagnostics are replaced, and that removing a JavaScript block
clears semantic providers. Afterward it verifies the latest diagnostics and
confirms that closing the document removes its state. A separate lifecycle case
forces idle TypeScript disposal and verifies successful lazy recreation.

The server still runs under its 128 MB V8 old-generation limit. On Linux and
macOS the test also samples child-process RSS, enforcing a default 384 MiB
ceiling and at most 128 MiB growth after completion warm-up. Plain Liquid churn
may grow RSS by at most 32 MiB, and TypeScript recreation may add at most 96 MiB
over its first warm state. Threshold overrides and the optimization plan are
documented in [`PERFORMANCE.md`](PERFORMANCE.md). Other platforms retain all
semantic and process-survival checks while skipping RSS assertions. A local run
averaged 0.6 ms for 150 plain 64 KiB updates and 5.6 ms for the JavaScript load,
with about 82 MiB idle RSS, 225 MiB after warm-up, and 324 MiB after the
deliberately unique-source workload. These measurements are development
observations rather than cross-platform guarantees.

### Reliability audit hardening — `0.24.0`

A repository-wide audit led to targeted correctness, lifecycle, supply-chain,
and release improvements:

- embedded ranges are now half-open, and TypeScript diagnostics, hover ranges,
  and completion edits cannot cross Liquid closing delimiters;
- inline-block setting completion requires a parsed Liquid expression context,
  preventing results in comments, LiquidDoc, and embedded-language strings;
- asynchronous completion and definition handlers reject cancelled or stale
  document results;
- CSS parse trees are cached, TypeScript completion items resolve documentation
  lazily, and TypeScript filesystem access is restricted to standard libraries
  and active workspace roots;
- embedded features require evidence of a Shopify theme root rather than only a
  directory named `sections`, `blocks`, or `snippets`;
- both Node servers terminate cleanly after truly uncaught failures so Zed can
  restart them, while validation failures clear stale diagnostics;
- language-server installation status now reaches an explicit success or failure
  state, and TypeScript installations are revalidated if files disappear;
- the direct Shopify server was updated to `2.22.1`, the development lockfile
  was refreshed to remove the `nanoid` advisory, and the unused grammar native
  binding is denied during test installation;
- grammar package metadata was corrected and the extension pin advanced to
  `0e228e6d080f1fc7b0e6a661479004c16c8d2514` without parser changes;
- CI now runs protocol, query, dependency, Rust, TOML, and WASI build checks,
  with a scheduled fresh resolution of the runtime npm dependency graph;
- regression coverage now includes malformed block boundaries, syntax-aware
  settings, stale requests, completion resolution, ranged Unicode edits,
  unrelated directories, and multiple large open documents.

The embedded server version reported to LSP clients is injected from the Rust
package version when Zed writes the runtime script. A manual Zed host gate is
recorded in [`RELEASE.md`](RELEASE.md) because no headless extension-host harness
is available to this repository.

### Maintainability and scale hardening — `0.25.0`

The embedded support server was split into focused document-analysis,
embedded-language, and theme-root modules that the Rust extension writes next
to the generated entry point. Theme evidence and configured roots are cached and
invalidated by watched-file and workspace-folder changes.

A deterministic differential suite now compares reused incremental Liquid
analysis with a clean parse across 500 randomized Unicode, CRLF, malformed-tag,
and delimiter edits. Its first run exposed that `TextDocument.update` mutates the
previous document in place; the server now snapshots the previous version before
using change ranges, and disables analysis reuse whenever parser recovery makes
its boundaries unreliable.

Embedded JavaScript and stylesheet semantics now degrade explicitly for Liquid
documents over 2 MiB or individual blocks over 512 KiB instead of risking a V8
heap failure. Informational diagnostics explain the limit, and TypeScript module
snapshots are separately bounded by file size and count. These defaults remain
overridable for stress and development workloads.

Repository contracts now validate release, runtime-package, npm, and grammar
pins from the checked-in manifests. CI derives fresh-install versions from those
pins, validates release tag/version agreement, retains both WASI artifacts for
tag builds, and receives scheduled dependency update proposals.

## Current architecture

### Extension host

`src/liquid.rs` installs pinned npm dependencies and generates two server entry
points plus the embedded server's focused support modules in Zed's extension
work directory:

1. **Shopify Theme Language Server** (`liquid`) — owns Liquid/HTML/schema/CSS/
   JSON completion, diagnostics, hover, links, navigation, HTML tag editing,
   and Theme Check behavior.
2. **Liquid Embedded Support** (`liquid-embedded-javascript`) — supplements
   inline section-block setting completion, paired-brace LiquidDoc parameter
   type completion, static file definitions, embedded range formatting, and
   local CSS/JavaScript definitions, and owns JavaScript completion, hover, and
   diagnostics inside bundled JavaScript tags.

The extension is currently version `0.25.0` and uses Zed extension API `0.7.0`.

### Tree-sitter

The pinned Shopify-focused grammar and `languages/liquid/*.scm` queries provide:

- parsing and error recovery;
- Liquid, HTML, CSS, JavaScript, JSON, YAML, comments, and LiquidDoc injections;
- highlighting;
- indentation and folding structure;
- outlines;
- bracket behavior.

Tree-sitter behavior and LSP behavior should not be conflated: queries cannot
provide semantic object completion, and language servers do not control syntax
capture colors or structural indentation.

### Formatting

`prettier_parser_name = "liquid-html"` delegates full-document formatting to
Prettier when the project has `@shopify/prettier-plugin-liquid` configured.
Shopify's plugin formats embedded stylesheet and JavaScript blocks. The embedded
support server separately provides range formatting when a selection intersects
those blocks. Tailwind formatting and completion remain user-configurable
because they depend on each theme's build
setup.

## Design decisions

- Follow [Shopify Theme Tools and its VS Code extension](https://github.com/Shopify/theme-tools)
  as the behavioral and architectural reference.
- Prefer official Shopify packages over reimplementing Liquid semantics.
- Do not duplicate completion, validation, or navigation providers already
  exposed by Shopify's language server; supplement only confirmed host or
  upstream gaps.
- Keep direct package and grammar versions pinned for compatible startup. Zed's
  `npm_install_package` API does not accept a lockfile, so Shopify's transitive
  semver ranges remain resolved by the host rather than being vendored into the
  extension.
- Maintain a small grammar fork only where upstream syntax support is missing.
- Prioritize Theme Blocks, `content_for`, modern schemas, bundled assets, and
  LiquidDoc.
- Do not add dedicated `.js.liquid` or `.css.liquid` modes. Those files can still
  be treated as Liquid for compatibility, but they are not a modern architecture
  priority.
- Preserve deterministic unit/corpus/protocol tests and use Zed itself as the
  final integration layer rather than the only test environment.
- Treat startup latency, completion latency, and memory as feature requirements,
  especially for any additional language server.

## Reference locations

- [Shopify Theme Tools and VS Code extension](https://github.com/Shopify/theme-tools)
- Shopify-focused grammar checkout: `grammars/liquid` (a separate Git repository)
- Extension fixtures: `tests/queries/fixtures` and `tests/language-server`
- Liquid language configuration and queries: `languages/liquid`
- Shopify server adapter: `src/liquid.rs`
- Embedded JavaScript server: `language-server/embedded-javascript-server.cjs`

See the [roadmap](../README.md#roadmap) for remaining work.
