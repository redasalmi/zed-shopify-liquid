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
- disposing and recreating TypeScript may add at most 96 MiB over the first warm
  state;
- warm incremental JavaScript requests should remain comfortably below a 15 ms
  average locally, while tests report timings instead of imposing a
  hardware-sensitive latency assertion;
- V8's old-generation heap remains capped at 128 MiB.

The RSS limits can be adjusted for constrained or unusual hosts with
`LIQUID_STRESS_RSS_LIMIT_MIB`, `LIQUID_STRESS_RSS_GROWTH_LIMIT_MIB`, and
`LIQUID_STRESS_RESTART_GROWTH_LIMIT_MIB`.

## Implemented optimizations

1. Share one incremental TypeScript language service across open Liquid files.
2. Load TypeScript and CSS services only on the first relevant request.
3. Debounce TypeScript diagnostics while preserving immediate completions.
4. Cache standard-library and per-document script snapshots.
5. Compare compact, exact embedded-source structure before invalidating the
   TypeScript project.
6. Materialize full-length JavaScript and CSS virtual documents only when a
   service requests them, then reuse unchanged sources and CSS documents.
7. Dispose TypeScript programs, document registries, and library snapshots 30
   seconds after the final JavaScript document becomes inactive. Reopening a
   JavaScript document recreates the service lazily.
8. Keep the server under `--max-old-space-size=128`.

## Regression workloads

`npm run test:stress` covers three independent cases:

1. repeated large Liquid updates without embedded assets;
2. 300 unique JavaScript updates with completion, definition, diagnostics, and
   stale-state assertions;
3. TypeScript idle disposal followed by successful lazy recreation.

RSS is sampled on Linux and macOS. Other platforms run the semantic, lifecycle,
and process-survival contracts without RSS assertions. RSS is expected to
plateau rather than immediately return to the operating system because V8 can
retain released pages for reuse.

Future optimization should begin with a repeatable workload and should only be
kept when it improves a measured budget without changing protocol results.
