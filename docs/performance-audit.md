# Performance and reliability audit (2026-10-26)

This audit covers the 0.21.x tree: the test suite, the offline ranking
benchmark, a live 30-query comparison and the new MCP path. It records the
failures as well as the wins.

## Test suite

```
npm run check
ℹ tests 668
ℹ pass 667
ℹ fail 0
ℹ skipped 1
```

The skipped case is an intentional platform-dependent test. The new route-memory
integration test drives a real `CONNECT` proxy, a target that always returns
`403`, and asserts that the second search goes straight to the working tunnel.
The MCP test spawns the stdio server, lists exactly four tools and fetches a
local page.

## Offline ranking benchmark

`node scripts/bench.mjs` replays 20 recorded queries over eight engines with no
network:

| Metric | Value |
| --- | ---: |
| Queries | 20 |
| P@8 | 0.4375 |
| R@8 | 0.7917 |
| MRR@8 | 0.8071 |
| Zero-hit queries | 0 |

This is a deterministic regression check, not evidence of live search quality.
The parameter sweep and per-query output stay in [rrf-ranking.md](rrf-ranking.md).

## Live 30-query comparison

The clean sweep (first run) answered every query:

| Provider | Answered | Mean latency | p95 latency | Mean unique domains |
| --- | ---: | ---: | ---: | ---: |
| dsh-web-search | 30/30 | 3008 ms | 5188 ms | 5.83 |
| Firecrawl keyless | 30/30 | 2396 ms | 3958 ms | 5.43 |
| Exa anonymous | 30/30 | 1001 ms | 1238 ms | 3.50 |

The plugin is 3× slower than Exa on mean and 4× slower on p95, because it fans
out to eight engines and waits for fusion. It returned the most distinct domains
and was the only arm that never depended on a single upstream index. Full
method, category breakdown, failures and raw JSON:
[docs/comparison.md](comparison.md).

The most important live measurement is the tail, not the mean: five Chinese
release queries logged `anysearch: still running at deadline`, and the search
returned at the 6 s `auto` soft deadline. The other engines still supplied eight
rows, so this was a latency failure, not an empty result. Lowering the deadline
or requiring one fewer contributor would cut the tail, but it would also change
which engines contribute to the fused ranking; that trade was not made silently
in this patch.

## Reliability fixes in this audit

### Firecrawl direct 403, then 429

From this network, a direct Firecrawl request is `403` and a tunnel request is
`200` in a clean sweep. Repeating the sweep immediately produced `429` for
14/30 then 30/30 queries. The plugin now remembers a working proxy route for ten
minutes (`EngineHealth.noteRouteSuccess` / `preferProxy`) and keeps the alternate
route as a fallback. A recorded Firecrawl fallback went from 1,874 ms (403 +
retry) to 1,017 ms on the second call. This does not create quota; it stops
paying the same 403 on every call.

### MCP protocol

Unknown notifications no longer receive a JSON-RPC response, `cancelled` is
ignored, and the server exposes four tools. A published `npx` smoke test returns
the expected `serverInfo` and tool list without a DSH context.

## Open issues

1. **AnySearch tail.** The five Chinese queries above; recorded, not hidden.
2. **One real official-source miss.** The Chinese Rust 1.90 query returned the
   Rust home page instead of the release blog in the clean sweep. Firecrawl and
   Exa found the release page.
3. **Firecrawl keyless quota.** Clean-sweep quality is good, but repeated sweeps
   exhaust the endpoint. It remains a fallback, not a primary.
4. **Running app needs one restart.** The npm package and the desktop profile are
   on 0.21.1; a process that started before the install still serves the old
   module until restarted.
5. **Catalog PR is pending review.** The awesome-dsh-plugin description is
   updated in PR #9456; `dsh-plugin-catalog` regenerates downstream.

## What was not changed

No ranking weights, RRF constant or relevance model were changed in this audit.
The changes are transport route memory, MCP packaging, tests and documentation.
That keeps the offline benchmark comparable with the previous release.
