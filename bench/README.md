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

## Sweep the knobs

```sh
node scripts/sweep.mjs           # 81 configurations: rrf × authority × freshness × anysearch weight
node scripts/sweep.mjs --quick   # 27 configurations, rrf and freshness only
```

Each configuration runs the offline replay, so a full sweep takes about a minute and never touches the
network. The script prints the top five by MRR, the delta against the shipped defaults with a paired
bootstrap interval, and the marginal mean of every knob value.

### What the sweep actually says (0.13.7, 20 queries)

Marginal means across the grid:

| knob | value | MRR | P@8 | R@8 |
|---|---|---|---|---|
| `rrfConstant` | 40 | 0.7712 | 0.3500 | 0.7472 |
| | **60** (default) | 0.7604 | 0.3563 | 0.7417 |
| | 80 | 0.7456 | 0.3590 | 0.7417 |
| `authorityBoost` | 0.10 | 0.7733 | 0.3243 | 0.7472 |
| | **0.25** (default) | 0.7645 | 0.3611 | 0.7417 |
| | 0.40 | 0.7395 | 0.3799 | 0.7417 |
| `freshnessBoost` | 0.10 | 0.7681 | 0.3597 | 0.7444 |
| | **0.20** (default) | 0.7598 | 0.3597 | 0.7444 |
| | 0.35 | 0.7494 | 0.3458 | 0.7417 |

The best single configuration, `rrf=40 authority=0.1 freshness=0.1`, scores MRR 0.8042 against the
default 0.7600 — a delta of **+0.0442 with a 95% interval of [−0.0038, +0.1229]**. The interval spans
zero, and the gain comes from two queries. **The corpus cannot tell these configurations apart, so the
defaults stay put**; a knob is only worth changing once a larger corpus moves the interval clear of zero.

Two trade-offs are visible and stable enough to document:

- Lower `authorityBoost` raises MRR but lowers P@8: it stops promoting `docs.python.org` and
  `kubernetes.io` over equally relevant community pages.
- Lower `rrfConstant` rewards one engine's top hit; higher values flatten the blend and raise P@8 at the
  cost of MRR.

### Engine weights

`cn.bing` is the only sub-300 ms engine, and the live checks show why that speed is not free: for
`2026年10月 英伟达 人工智能 发布会` it returns 万年历/百科 entries, and for `PostgreSQL 逻辑复制 延迟 排查` it
returns the PostgreSQL home page and a tutorial index, while AnySearch and DuckDuckGo return the
logical-replication articles. Down-weighting it (`--weight cn.bing=0.25 --weight ddg-html=2`) raises MRR
from 0.7600 to 0.7708, but again inside the noise band, so the default weight of 1 is unchanged.

### Live timing

`search()` against the real engines, six queries, two rounds each, `limit: 8`, hot network:

| `wait` | median | p90 | results | distinct domains | engine failures |
|---|---|---|---|---|---|
| `fast` | 649 ms | 2 319 ms | 96 | 34 | 18 |
| **`auto`** (default) | 2 847 ms | 3 502 ms | 96 | 50 | 6 |
| `all` | 2 618 ms | 2 941 ms | 96 | 39 | 0 |

`fast` is three times quicker but loses a third of the domains and reports eighteen engine failures;
`all` has the tightest tail and no failures but returns fewer distinct domains than `auto`. The defaults
keep `auto`: diversity is what the ranking is for, and the tail is already under four seconds.
