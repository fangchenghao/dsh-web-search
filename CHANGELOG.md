# Changelog

## 0.9.0

### Added
- **The settings form works.** All sixteen fields are live-editable from
  Settings, because each one is marked `.volatile()` and the plugin reads the
  current value out of the holder the schema hands it.

### Fixed
- **`resolveConfig` validated an already-parsed config.** The Loader validates
  a row's config once and hands `apply` the parsed result, in which every
  volatile field is a `{ get }` holder. Running that parsed value back through
  `Config()` re-validated the holders as values and threw
  `$.timeoutMs expected number but got [object Object]`, so the plugin died
  inside `apply` — which the Host reports as "1 entry did not activate". The
  previous three attempts all failed on this same line, which is why marking
  fields, attaching `Config` to the runtime and re-installing each looked
  plausible and each changed nothing.
- Search re-reads the configuration on every call, so a volatile-only change
  from Settings takes effect without remounting the plugin.

All notable changes to `dsh-web-search-bing` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version dates were not recorded in this repository's history, so the entries
below are ordered but undated; only the ordering is authoritative.

## 0.8.0 (unreleased)

The fetch half, and AnySearch's paid-tier capabilities.

### Added

- **A fetch provider (`http-proxy`), so `web_fetch` works on a restricted
  network.** Measured here: a direct request to `github.com` or
  `html.duckduckgo.com` times out while the same URL answers through the local
  tunnel. The provider tries a direct request first, falls back to the tunnel
  the search side already resolves, and finally — when an AnySearch key is
  configured — to AnySearch's extraction endpoint, which renders the page
  server-side and so also rescues a page that answers 403 to a bare request.
  Select it with `fetchProvider: http-proxy` in the `web` service config.
- `anysearchApiKey`: sent as a Bearer token to `api.anysearch.com` only. It
  raises the rate limit and unlocks extraction; empty keeps anonymous access.
  Keep it in the profile, not in the bundle: the shipped default is empty.
- `anysearchDomain`: route the AnySearch engine at one of its vertical indexes
  (`finance`, `academic`, `security`, `legal`, `code`). A dotted value such as
  `finance.us_stock` selects the sub-domain.
- 9 tests for the fetch ladder and for the credential/domain resolution.

### Fixed

- **The settings page rendered nothing: the Host never saw the schema.**
  `dsh-settings` reads a plugin's schema from `entry.fiber.runtime.Config`, and
  for a function-style plugin the runtime *is* the `apply` function, so a named
  `Config` export was unreachable: the settings document dropped the row before
  it looked at the schema at all. The module now exports the plugin as
  `Object.assign(apply, { Config })`, which is what object-style plugins get from
  `static Config`. `test/plugin-entry.test.ts` pins the shape.
- **The settings page rendered nothing: the configuration was not marked
  live-editable.** `dsh-settings` keeps a namespace only when
  `volatileForm(schema)` yields a form, and that helper keeps a namespace when a
  field carries `meta.volatile`. None of the sixteen fields did, so the Host
  dropped the row before the client ever asked for it — the plugin was loaded,
  its schema was valid, and Settings still had nothing to show. Every field now
  ends in `.volatile()`; `test/config-live.test.ts` restates the Host's filter
  and fails if the mark is dropped again.
- **The settings page rendered nothing.** Two layers were wrong. The client
  declared `slots` and `locale` but not `configForms`, so Cordis never injected
  the service; and even with the service present, the page read its form once at
  mount, while the Host projects a row's settings namespace asynchronously. The
  page now subscribes to the settings mirror, derives the namespace from the
  projection the Host actually serves (patch id, entry id, package name, then a
  suffix match), and reads the controller for that namespace. When the service
  is present but no served namespace matches, the page names the namespaces it
  does see instead of showing a dead end.

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

- The `wait` setting now reaches the engine run. It was documented, validated and
  offered by the settings card, but `resolveConfig` never carried it into
  `search`, so every call silently used `auto`.
- A partially specified config no longer throws on activation: `resolveConfig`
  runs its input through the schema first, so a row written as `config: {}` (or
  edited by hand into a fragment) resolves to the documented defaults instead of
  dereferencing an absent key.
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

