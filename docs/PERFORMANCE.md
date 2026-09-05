# Performance Plan

Performance work is limited to the extension-owned embedded support server.
Shopify Theme Language Server performance remains upstream-owned; the extension
keeps Shopify's diagnostic preload and check-frequency settings configurable
rather than forking its implementation.

## Budgets

The repeatable protocol workloads enforce these default budgets:

- plain Liquid editing must not load CSS or TypeScript services and may grow RSS
  by at most 32 MiB across 150 updates of a 64 KiB document;
- the JavaScript workload remains under 384 MiB RSS and grows by at most 128 MiB
  after completion warm-up;
- 12 simultaneously open 256 KiB Liquid documents with bundled JavaScript also
  remain under the same 384 MiB process budget;
- disposing and recreating TypeScript may add at most 96 MiB over the first warm
  state;
- the small-file warm incremental JavaScript workload should remain comfortably
  below a 15 ms average locally, while tests report timings instead of imposing a
  hardware-sensitive latency assertion;
- V8's old-generation heap remains capped at 128 MiB;
- documents over 2 × 1024² UTF-16 code units skip Liquid parsing and all
  supplemental providers, returning an informational diagnostic; individual
  embedded blocks over 512 × 1024 code units disable that block's semantics;
- imported workspace modules are limited to 128 files of at most 1 Mi code units each;
- saved schema locale data is cached for at most 16 theme roots, with a 1 MiB
  file-size limit and bounded reads; missing or oversized locales omit translated
  documentation without disabling completion.

The resource limits can be overridden with
`LIQUID_MAX_EMBEDDED_DOCUMENT_CODE_UNITS`,
`LIQUID_MAX_EMBEDDED_BLOCK_CODE_UNITS`,
`LIQUID_MAX_IMPORTED_FILE_CODE_UNITS`, and `LIQUID_MAX_IMPORTED_FILES`.
The RSS limits can be adjusted for constrained or unusual hosts with
`LIQUID_STRESS_RSS_LIMIT_MIB`, `LIQUID_STRESS_RSS_GROWTH_LIMIT_MIB`, and
`LIQUID_STRESS_RESTART_GROWTH_LIMIT_MIB`.

## Implemented optimizations

1. Share one incremental TypeScript language service across open Liquid files.
2. Load TypeScript and CSS services only on the first relevant request.
3. Debounce TypeScript diagnostics while preserving immediate completions.
4. Cache standard-library and per-document script snapshots while bounding
   imported workspace snapshots by size and count.
5. Preserve and offset parsed Liquid analysis for safe ranged edits outside
   semantic regions, avoiding a full parser pass; invalidate TypeScript only
   when a JavaScript range or source offset changes.
6. Compare incremental embedded changes against their affected ranges before
   scanning complete CSS/JavaScript bodies; unchanged virtual documents are
   reused for edits outside embedded regions.
7. Materialize full-length JavaScript and CSS virtual documents only when a
   service requests them, then reuse unchanged sources, CSS documents, and
   parsed CSS stylesheets.
8. Restrict TypeScript filesystem access to its standard libraries and current
   workspace roots, preventing imports from expanding analysis outside the
   active project. Imported workspace snapshots are invalidated by watched
   JavaScript/TypeScript file changes and carry independent script versions.
9. Dispose TypeScript programs, document registries, and library snapshots 30
   seconds after the final JavaScript document becomes inactive. Reopening a
   JavaScript document recreates the service lazily.
10. Cache LiquidDoc tags, inline-block setting items, and theme-root lookups;
    theme-root caches use bounded LRU-style eviction and invalidate when
    watched files or workspace folders change.
11. Keep the server under `--max-old-space-size=128`.
12. Analyze each document-open event once. For edits within parser-verified
    JavaScript/stylesheet bodies, update ranges and splice cached virtual sources
    instead of reparsing the surrounding HTML/Liquid. Existing or newly assembled
    Liquid tag delimiters force a clean parse. Mask non-newline runs rather than
    individual characters when a virtual source must be rebuilt.
13. Track resolved module dependencies, including transitive imports. Watched
    module changes revalidate only their active consumers. File creation also
    refreshes unresolved imports; package metadata and workspace changes retain
    conservative resolution invalidation.
14. Resolve localized inline-block setting documentation lazily without loading
    TypeScript; invalidate locale caches on saved schema-locale, theme-root, and
    workspace changes.

## Regression workloads

`npm run test:stress` covers five independent cases:

1. repeated large Liquid updates without embedded assets;
2. 12 simultaneously open 256 KiB Liquid documents with JavaScript semantics;
3. 300 unique JavaScript updates with completion, definition, diagnostics, and
   stale-state assertions;
4. TypeScript idle disposal followed by successful lazy recreation;
5. 100 ranged JavaScript edits in a roughly 219 KiB markup-dense Liquid document,
   verifying one initial parse, subsequent analysis reuse, correct definitions,
   completion, and the 384 MiB RSS ceiling. Mean and p95 latency are reported.

A local Node 24 run of the dense workload averaged 28.6 ms with a 31.9 ms p95
and approximately 256 MiB maximum sampled RSS. These are development measurements,
not cross-platform guarantees.

Protocol and unit contracts additionally cover graceful oversized-document
handling (including a markup-dense document exceeding the default limit),
keyword-only tag repairs, workspace-root cache invalidation, targeted and
unresolved imported-module refresh, change-aware embedded-range comparison, and 500 deterministic differential
incremental edits compared with clean parser results.

RSS is sampled on Linux and macOS. Other platforms run the semantic, lifecycle,
and process-survival contracts without RSS assertions. RSS is expected to
plateau rather than immediately return to the operating system because V8 can
retain released pages for reuse.

Future optimization should begin with a repeatable workload and should only be
kept when it improves a measured budget without changing protocol results.
