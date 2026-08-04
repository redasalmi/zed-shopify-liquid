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
- Retained an existing usable server when an update fails.
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
The extension does not attach a supplemental server to every JSON document or
reimplement semantics that Shopify's language server does not expose.

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
- Restricted results and diagnostics to JavaScript block ranges.
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
provider offers the four primitive LiquidDoc types plus every Shopify Liquid
object type, reading Shopify's updated documentation cache with the pinned
package data as an offline fallback. It remains limited to LiquidDoc-capable
snippet and Theme Block files and does not load TypeScript.

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
`{% liquid %}`, and infers the nearest root from standard theme directories so
nested themes do not resolve references from an unrelated parent theme.

## Current architecture

### Extension host

`src/liquid.rs` installs pinned npm dependencies and generates two server entry
points in Zed's extension work directory:

1. **Shopify Theme Language Server** (`liquid`) — owns Liquid/HTML/schema/CSS
   completion, diagnostics, hover, links, navigation, and Theme Check behavior.
2. **Liquid Embedded Support** (`liquid-embedded-javascript`) — supplements
   inline section-block setting completion, paired-brace LiquidDoc parameter
   type completion, and static file definitions, and owns JavaScript completion,
   hover, and diagnostics inside bundled JavaScript tags.

The extension is currently version `0.15.0` and uses Zed extension API `0.7.0`.

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

`prettier_parser_name = "liquid-html"` delegates formatting to Prettier when the
project has `@shopify/prettier-plugin-liquid` configured. Shopify's plugin
formats embedded stylesheet and JavaScript blocks. Tailwind formatting and
completion remain user-configurable because they depend on each theme's build
setup.

## Design decisions

- Follow Shopify Theme Tools and Shopify's VS Code extension as behavioral and
  architectural references.
- Prefer official Shopify packages over reimplementing Liquid semantics.
- Do not duplicate completion, validation, or navigation providers already
  exposed by Shopify's language server; supplement only confirmed host or
  upstream gaps.
- Keep versions pinned for reproducible startup and compatibility.
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

Paths relative to this repository:

- Shopify Theme Tools: `../theme-tools`
- Grammar checkout: `grammars/liquid`
- Representative theme: `../../moen-theme`
- Liquid language configuration and queries: `languages/liquid`
- Shopify server adapter: `src/liquid.rs`
- Embedded JavaScript server: `language-server/embedded-javascript-server.cjs`

See the [roadmap](../README.md#roadmap) for remaining work.
