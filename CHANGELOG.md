# Changelog

All notable changes to `dsh-web-search-bing` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version dates were not recorded in this repository's history, so the entries
below are ordered but undated; only the ordering is authoritative.

## 0.7.0 (unreleased)

The TypeScript rewrite. Behaviour is meant to be unchanged where it was
measured, and stricter where it was previously guesswork.

### Added

- **Reciprocal rank fusion** (`src/rank.ts`): weight shapes *admission*, not
  score. The per-engine lists are walked in a weighted round robin (weight 2
  takes two consecutive rows per round, so it owns roughly twice the slots), and
  the merged walk gives each candidate a 1-based `position`; a source then scores
  `votes / (rrfConstant + position)`, where `votes` is the number of distinct
  engines that returned it, so agreement compounds while one engine's weight does
  not. Authority (`authorityDomains`, `authorityBoost`) and freshness
  (`freshnessBoost`, `freshnessDays`) multiply that score. Ties break
  deterministically on engine index, rank, then URL. Measured with weights 2/1/1
  over lists of 10/10/4 at `limit: 8`, admission splits 4/2/2.
- **TTL + LRU result cache** (`src/cache.ts`): entries expire after
  `cacheTtlMs` (default 10 minutes) and the least recently used entry is evicted
  past `cacheEntries` (default 100). Keys normalise case and whitespace, and are
  sensitive to `limit`, `wait`, lead region and the participating engine set.
- **Retry-After aware cooldown** (`src/health.ts`): the service's own wait hint
  wins over the guessed duration; otherwise the cooldown doubles per consecutive
  failure from `baseCooldownMs` up to `maxCooldownMs`. `SEARCH_PARSE` and
  `SEARCH_ABORTED` never cool an engine down.
- **Typed configuration schema** (`src/config.ts`, schemastery): the loader
  validates the mounted config before `apply` runs, so a bad value fails loudly
  with its path instead of silently using a default.
- **Fixture-based parser tests** (`test/fixtures/`, `test/parsers.test.ts`):
  captured responses for DuckDuckGo HTML, Bing, 360 and AnySearch, plus the six
  parser regressions (Bing `u=a1` tracker, DuckDuckGo `uddg`, single-quoted
  `class` attribute, 360 `data-mdurl`, AnySearch `code !== 0`, echoed-query
  check).
- **CI** (`.github/workflows/ci.yml`): Node 24 on Ubuntu and macOS, running
  `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and a check that the
  build really emits the declared `lib/index.js` entry point.
- **Proxy transport ported to TypeScript** (`src/proxy.ts`) with tests for
  `parseProxy`, `proxyFromEnv`, the `NO_PROXY` decision and the pure response
  framer (status/headers/body, chunked, gzip, deflate, brotli). `ProxyResponse`
  now carries the final hop's headers so the caller can read `Retry-After`.

### Changed

- All implementation moved from `index.js`/`engines.js`/`proxy.js` to
  `src/*.ts`, compiled to `lib/` by `npm run build`; `package.json` now points
  `main` and `types` at `lib/`.
- The merge is RRF in every case, replacing the fixed round-robin interleave.
  The bilingual region policy still runs first: the region the query language
  belongs to (`global` for ASCII, `cn` for CJK, `both` for either) fills the
  budget, and the other region only appends when it came up short.
- Cooldown durations are configurable instead of the previous hardcoded five
  minutes, and the failure list says how long an engine will rest and why.

### Fixed

- Weight no longer multiplies every row of an engine. The previous rule let
  AnySearch (weight 2) outscore every other engine at every rank, so a CJK query
  returned 8/8 AnySearch sources and no Chinese results at all; the measured
  split is now 4/2/2 for weights 2/1/1.
- A `POST` that meets a `3xx` other than `307`/`308` is downgraded to a bodyless
  `GET`; `307`/`308` preserve the method and body (AnySearch needs both paths).
- A tunnelled response's `Retry-After` is read from the final hop instead of
  being discarded.

## 0.6.0

### Changed

- AnySearch now leads CJK queries too (`region: both`), not only ASCII ones.
  A/B measured on the same query set: with domestic engines alone,
  `如何配置 postgres 逻辑复制` was answered with a Baidu Baike page for the
  dictionary word "如何" and a song-lyric page; adding AnySearch returned Cloud
  SQL documentation, a cnblogs walkthrough, the AWS specification guide, Azure
  documentation and a Tencent Cloud article. `Python GIL 是什么` went from
  python.org's home page, its download page and a tutorial site — none of which
  mention the GIL — to explanations of the GIL. `DeepSeek Harness 插件开发` went
  from front pages and an App Store listing to hands-on tutorials.
- The cost of that is visible: a Chinese query now takes 1.4–2.3 s instead of
  0.2–0.7 s with domestic engines alone.

## 0.5.0

### Added

- **AnySearch anonymous JSON API engine** (`POST api.anysearch.com/v1/search`
  with `{ query, max_results }`, parsed from its `{ code, data: { results } }`
  envelope). It is reachable without a tunnel and is the most precise engine, so
  it takes a weight of 2.
- Weighted interleave for merging per-engine lists, so a high-precision engine
  holds more slots without silencing the others.
- `www.`-aware dedupe: `http(s)://www.` and a trailing `/` are the same
  document.

### Changed

- Bing global demoted from primary to fallback. Measured on stopword-heavy
  English queries it matched a single token: `how to set up postgres logical
  replication` returned jigsaw-puzzle sites for "set", while the other engines
  stayed on topic. It is worth reaching only when nothing else answered.

## 0.4.0

### Added

- **Bilingual region policy**: engines declare `global`, `cn` or `both`; the
  region matching the query script leads the merged list and the other region
  only fills gaps.
- **`wait` policy**: `auto` (wait for the leading region), `all` (wait for every
  engine) and `fast` (return on the first answer), each with a soft deadline.
- **Per-engine cooldown** after a block page, so a site that has decided this
  client is a robot is not re-triggered on every search.
- **Echoed-query check**: a result page must contain one query token of at least
  three characters, otherwise it is a rate-limit or "trending" page belonging to
  somebody else's search and is rejected.
- DuckDuckGo HTML parser with per-result snippets, alongside the lite endpoint.

## 0.3.0

### Fixed

- 360 result URLs: the real target lives in the anchor's `data-mdurl`, not in
  the click-tracker `href`; entries without it are skipped instead of emitting a
  redirect as a source.
- Single-quoted attributes (`class='result-link'`) are parsed, not only double
  quoted ones.

## 0.2.0

### Fixed

- Bing click-tracker links (`/ck/a?...&u=a1<base64url>`) are decoded to the real
  target. The `&` arrives HTML-escaped as `&amp;`, so the value is unescaped
  before the payload is looked for.
- DuckDuckGo outbound links (`/l/?uddg=<percent-encoded>`) are unwrapped.
- HTML entities in titles and snippets are decoded, and numeric entities outside
  the known table are dropped rather than leaked into a snippet.

## 0.1.0

### Added

- Initial provider: scraped 360 and Bing result pages, registered with the
  `ctx.web` seam as provider id `bing`, returning `{ url, title, snippet }` with
  no API key and no credential.

