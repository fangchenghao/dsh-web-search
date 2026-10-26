# 30-query keyless comparison

This is a small, reproducible comparison, not a claim that one search plugin is
"best". It measures what can be measured without private relevance labels:
whether a provider answers at all, how long it takes, how many distinct domains
it returns, and whether a page on a known official domain appears in the top 8.
The failures are part of the result.

## Method

- **Corpus:** 30 queries in `bench/compare30/queries.json` — 13 release queries
  (8 English, 5 Chinese), 12 documentation queries, 3 package/repository
  queries, 1 arXiv query and 1 Stack Overflow query. Every query names one
  expected official host.
- **Budget:** top 8 results for each provider, one run per query, same machine
  and same network route (a local HTTP proxy at `127.0.0.1:7890` for providers
  that needed it).
- **Plugin arm:** `search()` with the current RRF ranker, no cache, 15 s
  timeout. It fuses eight engines and then truncates to 8.
- **Firecrawl arm:** keyless `POST https://api.firecrawl.dev/v1/search`; each
  request tries direct first, then the tunnel.
- **Exa arm:** the anonymous `web_search_exa` MCP endpoint with
  `Accept: application/json, text/event-stream`; direct first, then tunnel.
- **No API keys** were used. All raw responses are in
  [`results-2026-10-26-sweep1.json`](https://gist.githubusercontent.com/fangchenghao/3db9838fa98928435c1c2df38202c373/raw/results-2026-10-26-sweep1.json).

Metrics: `P@8`, `R@8` and `MRR@8` are **not** reported here. They need
human-labelled relevance; inventing labels would make the table look stronger
than the evidence. The 20-query offline benchmark in
[rrf-ranking.md](rrf-ranking.md) publishes those metrics separately.

## Clean sweep (first run, all providers answered)

| Provider | Answered | Official-domain hit | Mean unique domains | Mean ms | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `dsh-web-search` | 30/30 | 28/30 | 5.83 | 3008 | 2791 | 5188 |
| Firecrawl keyless | 30/30 | 29/30 | 5.43 | 2396 | 2219 | 3958 |
| Exa anonymous | 30/30 | 29/30 | 3.50 | 1001 | 964 | 1238 |

Raw official-domain counts use the corpus as first written. The single shared
Firecrawl/Exa "miss" and one of the plugin's two misses are the same fixture
error: Claude Code documentation moved from `docs.anthropic.com` to
`code.claude.com`; all three providers returned the new host. With that expected
host corrected, the counts would be **29/30, 30/30 and 30/30**. The remaining
real plugin miss is the Chinese Rust 1.90 query, which returned the Rust home
page rather than the release blog.

By category (first sweep; answered / official / mean ms):

| Category | n | dsh-web-search | Firecrawl | Exa |
| --- | ---: | --- | --- | --- |
| Release | 13 | 13 / 12 / 3123 | 13 / 13 / 2557 | 13 / 13 / 1031 |
| Docs | 12 | 12 / 11 / 2610 | 12 / 11 / 2383 | 12 / 11 / 1006 |
| Package | 3 | 3 / 3 / 4474 | 3 / 3 / 2105 | 3 / 3 / 916 |
| Research | 1 | 1 / 1 / 1977 | 1 / 1 / 1712 | 1 / 1 / 863 |
| Q&A | 1 | 1 / 1 / 2937 | 1 / 1 / 2002 | 1 / 1 / 941 |

## What the numbers say

- **Exa is the fastest by a wide margin.** About 1.0 s mean versus 3.0 s for
  this plugin, because Exa is one hosted index while this plugin fans out to
  eight engines and waits for fusion. If latency is the only criterion, use
  Exa; that is the honest result.
- **This plugin is competitive on availability and domain diversity, not on
  speed.** It answered all 30 and returned the most distinct domains on
  average (5.83), but its p95 was 5.2 s. The p95 comes from the 6 s `auto`
  soft deadline when AnySearch is slow.
- **Firecrawl's clean-sweep quality signal is good, but its keyless quota is
  fragile.** It answered 30/30 with 5.43 distinct domains in the first sweep,
  then 16/30 and 0/30 in two immediate repeats, with HTTP 429 on the tunnel
  after a direct 403. That is a distribution/reliability limitation, not a
  ranking difference. The repeat files are
  [`sweep2`](https://gist.githubusercontent.com/fangchenghao/3db9838fa98928435c1c2df38202c373/raw/results-2026-10-26-sweep2.json)
  and
  [`sweep3`](https://gist.githubusercontent.com/fangchenghao/3db9838fa98928435c1c2df38202c373/raw/results-2026-10-26-sweep3.json).
- **No provider "wins" relevance here.** One official-domain miss does not mean
  the answer is wrong, and an official domain is not always the best result.
  The corpus is small and imbalanced: 13 release queries, 12 docs, one research
  query and one Q&A query.

## Recorded failures

### This plugin

- `anysearch: still running at deadline` on the five Chinese release queries.
  The search still returned 8 rows from the other engines; the failure is
  recorded, not hidden. It is the main source of the 5–6 s tail.
- The Chinese Rust 1.90 query returned `rust-lang.org/zh-CN/` and other general
  pages instead of `blog.rust-lang.org`/`releases.rs`; both competitors found
  the release page.
- Firecrawl's direct 403 is not charged to the user's search latency when
  Firecrawl is not used (it is a fallback tier), but when it is used the first
  request pays for the 403 before the tunnel retry.

### Firecrawl keyless

- Direct request: HTTP 403 for every query from this network.
- Tunnel request: HTTP 200 in the first sweep; HTTP 429 for 14/30 queries in
  sweep 2 and 30/30 in sweep 3, after repeated sweeps from the same IP. This is
  exactly the kind of source the plugin's route memory and health panel are for,
  but a keyless public endpoint can still exhaust its quota.

### Exa anonymous

- No failures in this run. Direct requests returned HTTP 200 once the `Accept`
  header included both `application/json` and `text/event-stream`; without it,
  the endpoint answers `406 Not Acceptable`.
- Exa's result snippets are shorter, and its domain diversity is lower. That is
  a tradeoff, not a failure.

## Reproduce

```sh
DSH_WEB_SEARCH_PROXY=http://127.0.0.1:7890 \
COMPARE_SLEEP_MS=1500 \
node bench/compare30.mjs --out /tmp/compare30.json
```

The script writes a JSON file next to a Markdown report. The three raw files are also kept in
`bench/compare30/`; the public copy is the gist linked above. They were produced by the same command; sweeps 2 and 3 were run
immediately after sweep 1 to test repeatability, which is why Firecrawl's quota
failed. A single sweep is a snapshot, not a permanent ranking.

## Bottom line

Use Exa when latency dominates. Use Firecrawl only with a quota/health strategy;
its keyless endpoint is not a dependable primary. Use this plugin when you want
no key, multiple independent engines, vertical sources and one tool surface, and
can accept roughly 2–6 s per fused search. It is not the fastest, and this page
does not claim it is the most relevant.
