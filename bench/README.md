# Retrieval benchmark

A reproducible check for ranking changes: 20 committed queries (10 Chinese, 10 English, five each for `docs`, `release`, `package`, `news`), each annotated with 1–4 expected domains.

## Metrics

- **P@8** = matched result rows in the top 8 / **8** (fixed denominator; a short or empty list is not excused).
- **R@8** = distinct annotated domains found in the top 8 / annotated domains.
- **MRR@8** = mean of `1 / rank of first match` over queries; a query with no match contributes 0.
- A domain matches itself and its subdomains, one way only: `docs.python.org` matches expected `python.org`; expected `docs.python.org` does **not** match `python.org`. `www.` and trailing dots are ignored.
- **Contributed** = top-8 rows an engine returned (a row backed by two engines counts once for each); **consensus votes** = sum of distinct-engine votes over the top 8.

## Record (network, one time)

```sh
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
node scripts/bench.mjs --record
```

Each query runs through the plugin's `search()` with `limit: 8`, one query every 1.5 s, one retry on failure. Results land in `bench/fixtures/<id>.json`; a query that still fails is written as `{ "ok": false, "error": ... }`, never with invented sources. Evaluation treats that as a missing fixture. `--max-snippet <n>` optionally clips stored snippets to stay under the 400 KiB budget; it does not change ranking, which uses URLs and dates.

## Evaluate (offline, CI)

```sh
node scripts/bench.mjs
node scripts/bench.mjs --json --out bench/results/0.12.0.json
```

Fixtures are read only; evaluation re-runs the current `mergeRegions`/`preferWindow` at each fixture's `recordedAt` (so freshness cannot drift) and never touches the network or cache. Missing/failed fixtures are excluded and printed as `MISSING`, so the evaluated count is always visible.

## Compare versions

```sh
node scripts/bench.mjs --out bench/results/0.13.0.json
node scripts/bench.mjs --compare bench/results/0.12.0.json
```

Pin a single knob for a controlled experiment without editing source: `--rrf 40`, `--weight anysearch=1` (repeatable), `--authority-boost 0`. Scores are macro averages over evaluated queries.

Tests for the scoring functions: `node --test test/bench-metrics.test.ts`.
