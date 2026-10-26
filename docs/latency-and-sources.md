# Latency, Exa, and official sources

This note answers three questions from the public 30-query comparison:

1. Why is Exa around 1 s while this plugin was around 3 s?
2. Can the AnySearch tail and the Chinese Rust miss be fixed?
3. Does the fix require a vector database or a different retrieval model?

The short answer: Exa is a different architecture, not a faster RRF loop. This
plugin can borrow tail-tolerance and source-specific facts, but copying Exa's
semantic index would be a different product. The changes below improve the
interactive path without pretending that fan-out scraping is free.

## 1. Why Exa is fast

Exa describes its stack as a hosted semantic index, not a wrapper around a
search-engine results page:

- A query is embedded and matched against a web-scale vector database.
- Exa reports that it truncates 4096-dimensional embeddings to 256 dimensions
  with Matryoshka training (about 20x less memory), replaces 16-bit floats with
  1-bit document vectors (another 16x), and only searches the query's cluster
  plus nearby clusters instead of every vector. It reports roughly 1000x
  throughput from clustering, then reranks the shortlist with uncompressed
  vectors. Metadata filters use inverted indexes. This is deliberately unlike
  a global HNSW graph, which is harder to shard and filter:
  [engineering post](https://exa.ai/blog/building-web-scale-vector-db).
- Results come back from one API call. There is no per-query fan-out to several
  scraped HTML endpoints, and no client-side fusion of eight formats.
- Exa's low-latency mode is explicitly marketed as sub-200 ms in a
  us-west-1 datacenter, with about 50 ms network latency in their test. That is
  a vendor claim measured on their infrastructure, not an independent result.
  The same post notes that, with Exa 3.0, Lite is now the recommended
  low-latency search type: [Exa Instant](https://exa.ai/blog/exa-instant).

Our comparison used the anonymous Exa MCP endpoint, not Exa Instant. It measured
about 1.0 s end to end through a local tunnel. Even so, the structural difference
is real: **one indexed retrieval call versus a fan-out over independently hosted
and scraped engines.**

The fusion itself is cheap. The milliseconds are spent waiting for network
legs and parsing heterogeneous result pages, and the slowest leg sets the tail.

## 2. What was changed

### Tail-tolerant early release

`engines.ts` used to require contributors from the *leading region* before it
would release a tier. A Chinese query therefore waited for both AnySearch and
CN Bing even when a global primary had already supplied useful rows. It now
counts contributors across regions and releases when:

- the result budget is filled, and
- at least two independent engines contributed.

`wait: 'all'` still waits for every engine; `wait: 'fast'` still returns the
first answer. This follows the practical lesson from
[The Tail at Scale](https://dl.acm.org/doi/10.1145/2408776.2408794): for an
interactive request, do not make the response wait for every replica or
partition when a useful answer is already available. It is early termination,
not full hedged requests, and the distinction is deliberate: a second copy of a
scraped request would add load and may trigger more bot checks.

The interactive deadlines are now 5 s for Latin-script queries and 3 s for CJK
queries. That is a hard product decision: the plugin may return fewer rows on a
pathological query rather than let one slow engine define the tail.

### Official release facts

A generic search query is not a reliable way to find a version-specific release
announcement. `official-sources.ts` now starts a narrow lookup in parallel with
the ordinary fan-out:

- **PostgreSQL**: the official versioning page (existing path).
- **Rust**: the GitHub release endpoint gives the UTC publication date; the
  canonical official URL is then
  `https://blog.rust-lang.org/YYYY/MM/DD/Rust-X.Y.Z/`.
- **Scoped npm packages**: an explicitly `npm`-scoped query uses the existing
  npm vertical and puts the package page first.

The lookup is capped at 2.5 s and failure is contained: if the official source
is unavailable, the ordinary rows remain. The Rust GitHub endpoint is tried
directly first because measurement showed the direct request was much faster
than the tunnel for this API, with the tunnel kept as fallback.

For `Rust 1.90 发布说明`, the official row is now
`https://blog.rust-lang.org/2025/09/18/Rust-1.90.0/` at rank 1 rather than the
Rust home page or a third-party changelog.

### Firecrawl is still a fallback, not a primary

Nothing in a client can manufacture keyless Firecrawl quota. The honest fix is:

- keep Firecrawl in the fallback tier;
- let the existing health tracker cool it down after `429`/blocks;
- support an optional `firecrawlApiKey` / `FIRECRAWL_API_KEY` for users who
  need repeatable fallback behavior;
- record keyless quota failures in the public comparison instead of hiding
  them.

The keyless arm is suitable for a one-off check, not for a 30-query sweep
repeated three times.

## 3. Measurements

### Five Chinese release queries

The original clean sweep ran these at the 3.5 s auto deadline. All five reported
`anysearch: still running at deadline`; four hit the expected official domain.

A controlled rerun of the same five queries after this change:

| Query | Before | After | Official after |
| --- | ---: | ---: | --- |
| Node.js 24 发布说明 | 3502 ms | 3012 ms | yes |
| PostgreSQL 18 发布说明 | 3504 ms | 3002 ms | yes |
| React 19 发布说明 | 3503 ms | 3003 ms | yes |
| Python 3.14 发布说明 | 3506 ms | 2978 ms | yes |
| Rust 1.90 发布说明 | 3502 ms | 2565 ms | yes |

All five now hit the expected official host. AnySearch still appears as a
deadline failure on a few runs; that is the `wait` budget doing its job, not a
blocking wait. The user-visible tail is capped at about 3 s for these queries.

### Full 30-query follow-up

A plugin-only run with the official lookups enabled produced:

| Metric | Original clean sweep | Follow-up |
| --- | ---: | ---: |
| Answered | 30/30 | 30/30 |
| Official-domain hit | 28/30 | 29/30 |
| Mean unique domains | 5.83 | 5.67 |
| Mean latency | 3008 ms | 3768 ms |
| p50 | 2791 ms | 4000 ms |
| p95 | 5188 ms | 5003 ms |

The follow-up's **mean got worse**, not better. The run happened under more
variable upstream latency, and the new official lookup adds work to release
queries; the 5 s cap improves the p95 but does not make the average as fast as
the original clean network window. The remaining official miss is the arXiv
query, unrelated to the three issues above. Raw data:
[`results-2026-10-26-plugin-after.json`](../bench/compare30/results-2026-10-26-plugin-after.json).

The five-query table is the targeted result for the reported Chinese tail; the
30-query table is the honest full-run result, including the regression in mean.

## 4. Do we need a vector database?

No, not to fix these issues. A vector database would help exploratory semantic
queries, but it would add an indexing pipeline, embedding model, freshness
policy and a new hosting cost. It would also make the keyless promise harder:
the current project can run without an API key and without owning a crawl.

What is worth borrowing from the retrieval literature:

- **HNSW** shows how a graph index makes approximate nearest-neighbour search
  logarithmic in practice; it is one low-latency option Exa does not claim to
  use: [Malkov & Yashunin](https://doi.org/10.1109/TPAMI.2018.2889473).
- **ColBERT** shows that late interaction can preserve quality while reducing
  the amount of expensive query-document interaction:
  [Khattab & Zaharia](https://doi.org/10.1145/3397271.3401075).
- **Matryoshka representation learning** is directly relevant to Exa's
  truncated-embedding approach:
  [Kusupati et al.](https://arxiv.org/abs/2205.13147).
- **The Tail at Scale** is the basis for not waiting for every fan-out leg:
  [Dean & Barroso](https://dl.acm.org/doi/10.1145/2408776.2408794).

The plugin deliberately does **not** claim to be a semantic search engine. Its
advantage is keyless, multi-source coverage and explicit failure reporting; its
cost is that it cannot match a single-index provider's tail latency on every
query.

## 5. What remains

- AnySearch can still be the slow leg. The 3 s CJK budget bounds the damage,
  but a query may return fewer than eight rows from the remaining engines.
- Keyless Firecrawl can still return `429` immediately; use a key if you need
  repeatability, or treat it as a fallback only.
- Exa remains faster in the clean sweep. The public comparison should continue
  to say so.
