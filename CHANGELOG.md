# Changelog

## 0.13.11

### Fixed
- **`web_fetch` failed on every request more than 25 s after a restart**
  ("no time left in the fetch budget" from the direct, tunnel and extract
  rungs). The 25 s ladder budget was captured in the provider factory, which
  runs once when the plugin mounts, so the deadline had already passed for any
  later request. The budget now starts inside each `fetch()` call; a regression
  test builds a provider, waits 1.2 s, and fetches twice.
- The budget test that was supposed to prove the ladder cap had `useProxy:
  false`, so it never reached the tunnel rung. It now asserts the rung after the
  first timeout refuses to start.

## 0.13.10

### Security
- The macOS system-proxy probe now spawns `/usr/sbin/scutil` by absolute path
  instead of resolving `scutil` through `PATH`, so a hijacked `PATH` entry cannot
  receive that spawn. This also makes the process list in `SECURITY.md` exact.

## 0.13.9

### Fixed
- **`SECURITY.md` wrongly claimed the plugin spawns nothing.** It does: on macOS
  the system-proxy probe runs `scutil --proxy`. The page now lists that single
  process, the renderer's headless browser, and the `shell` return field that
  the store's scanner had flagged as a shell-mode call site.
- **The proxy probe had no deadline.** A wedged `scutil` could hold a search
  open; it is now capped at 2 s and the child is killed on expiry.
- **The store's fixed-source scanner read an internal field name as a
  capability.** `RenderReport.shell` (a boolean: "this page needs rendering") is
  now `shellPage`, so `shell: true` no longer matches the scanner's shell-mode
  pattern. Behaviour is unchanged; the store's capability list should now
  contain only real signals.

## 0.13.8

### Fixed
- **DSH STORE could not scan the runtime artifacts.** `lib/` was gitignored, so
  the fixed commit's tree contained no `lib/index.js` and no `lib/index.d.ts`;
  the store blocked the catalog entry with "runtime artifact is missing from the
  distributable surface" and "fixed-source scan is incomplete". The compiled
  output is now committed (40 files, 468 KiB) and stays inside the `files`
  surface, so the tree the store scans is the tree that runs.
- **Compatibility was not declared.** `package.json` now states the ranges it
  was actually exercised on — `engines.node: ">=22.18.0"` and
  `engines.dsh: ">=0.2.1-rc.2 <0.3.0"` — plus an exact
  `dsh.compatibility.dshReleases` record for `0.2.1-rc.2`. Only that version is
  declared, because only that version was run: the other two releases in the
  current latest-three window stay `unknown` instead of being claimed.

### Added
- `SECURITY.md`: dependencies, every network destination, credentials, the one
  file the plugin writes and its bounds, the time and size limits, and what the
  plugin deliberately never does.
- `docs/store-evidence.md`: the disposable-profile install / uninstall /
  rollback transcript and the live-host mount evidence behind the declared
  `dshOperations`.

## 0.13.7

### Fixed
- **A blank query burned seven seconds and six requests.** `search('')` and
  `search('   ')` reached every engine, each failed on its own, and the caller
  got an empty list. Validation now rejects it in under a millisecond with
  `SEARCH_INVALID`.
- **A PDF arrived as binary noise.** `kindOf()` treated every non-HTML response
  as text, so `application/pdf` came back as 20 000 characters of PDF stream and
  looked like a successful fetch. Binary content types now fail with
  `SEARCH_UNSUPPORTED` and name the type.
- **A JavaScript shell was a silent success.** `https://github.com/` and
  `https://excalidraw.com/` returned HTTP 200 with zero readable characters, so
  the caller saw an empty page with no explanation. A 200 with no text now
  fails with `SEARCH_EMPTY` and states why, including "no renderer installed".
  Non-2xx responses keep their old behaviour: the status line plus the body.
- **A layout `<main>` could throw away the article.** Extraction trusted any
  non-empty landmark, so a page whose `<main>` held a breadcrumb produced four
  characters while the prose sat in a sibling container. A landmark now has to
  keep a real share of the page's text, and the body is the last resort.
- **The fetch ladder stacked deadlines.** Direct (5 s) + tunnel (15 s) + render
  + extraction meant a dead host could hold a caller for half a minute. The
  whole ladder now shares a 25-second budget and later rungs get only the
  remainder.

### Added
- `scripts/sweep.mjs` sweeps the ranking knobs over the recorded corpus and
  prints a paired-bootstrap interval against the defaults. `bench/README.md`
  records the result: the best configuration beats the defaults by +0.044 MRR
  with an interval of [−0.004, +0.123], so **the defaults are unchanged**. The
  same page documents live `wait`-policy timings (`auto` keeps the most distinct
  domains).

## 0.13.6

### Fixed
- **The browser half registered under the old nickname.** The Host matches a
  client bundle by package name, so `__ModuleLoader__.load({ id:
  'dsh-web-search-bing' })` was rejected with "loaded without registering
  @fffangchenghao/dsh-web-search via __ModuleLoader__.load" and the Settings
  page never appeared. The id is the package name now, and a test evaluates the
  bundle against a stub loader and fails if the two ever diverge.

## 0.13.5

### Documentation
- The READMEs no longer repeat an exact test count, for the same reason they no
  longer repeat a version number: every added test made the sentence false.

## 0.13.4

### Fixed
- **The bundle overlay could not be parsed, so the plugin never loaded.** YAML
  reserves a leading `@`, and the overlay named the package as
  `name: @fffangchenghao/dsh-web-search` without quotes; the Host reported
  "bad indentation of a mapping entry" and dropped the entry. Every release from
  0.11.0 through 0.13.3 carried it. The name is quoted now, the README snippets
  are corrected, and a test fails if a bare scoped name returns — a copy-pasted
  snippet would break in exactly the same way.

## 0.13.3

### Documentation
- Both READMEs no longer claim that `fetchFormat` and `fetchMaxLength` need a
  restart. They are resolved per request; only `cachePersist`, `cacheFile`,
  `proxy` and `timeoutMs` are fixed when the plugin mounts.

## 0.13.2

### Documentation
- The READMEs point at npm for the current version instead of repeating a number
  that goes stale the moment a release is cut.

## 0.13.1

### Documentation
- `read_page`'s page cache is keyed by URL, output format and the fetch settings
  that shape the result — including the AnySearch key. The READMEs now say so,
  and the test count matches what the suite actually reports.

## 0.13.0

### Added
- **Optional JS rendering.** A page whose HTML is an empty shell can be rendered
  by a real browser — but only if `playwright` or `playwright-core` is already
  installed. Nothing is bundled, nothing is imported at load time, and a missing
  module is a silent fallback, not an error. `renderJs` picks `auto` (render only
  suspected shells), `always` or `off`; `renderTimeoutMs` bounds the attempt. A
  render that fails, times out or is aborted returns the earlier rung's result.
- **`read_page`, for pages longer than one answer.** The host fetch request
  carries only a url, so `web_fetch` can truncate but never continue. This tool
  takes `offset` and returns `nextOffset`, and consecutive chunks concatenate to
  exactly the full converted page — verified live against a long documentation
  page. Pages are fetched once and sliced, so continuing does not download again.
- **A retrieval quality benchmark.** Twenty queries (ten Chinese, ten English)
  across documentation, releases, packages and news, each with expected domains.
  `scripts/bench.mjs` records real engine output once, then replays it offline so
  a ranking change is a number, not an opinion. Metrics: precision@8, recall@8,
  MRR@8, per-engine contribution and consensus. Baseline 0.3625 / 0.7417 / 0.7600.

### Fixed
- An anti-bot page served with HTTP 200 was parsed as "zero results", which
  removed an engine silently while keeping its slot reserved and never engaging
  its cooldown. Such pages now report `SEARCH_BLOCKED`, and 360 — walled from
  this network through both the direct and tunnel paths — moved to the fallback
  tier so it no longer slows every search.

### Measured, not assumed
- `rrfConstant` 40 scores a higher MRR (0.7767) than the default 60 (0.7600) and
  a lower precision@8 (0.3500 vs 0.3625); `rrfConstant` 120 flips that trade in
  the other direction. Twenty queries and one-to-four-hit gaps are not enough to
  justify changing a default, so 60 stays and the numbers are in `bench/`.
- Dropping authority weighting costs 0.08 precision@8 and breaks Chinese
  results, which is why it remains on by default.

## 0.13.0

### Added
- **Optional JS rendering.** A page whose HTML is an empty shell can be rendered
  by a real browser — but only if `playwright` or `playwright-core` is already
  installed. Nothing is bundled, nothing is imported at load time, and a missing
  module is a silent fallback, not an error. `renderJs` picks `auto` (render only
  suspected shells), `always` or `off`; `renderTimeoutMs` bounds the attempt. A
  render that fails, times out or is aborted returns the earlier rung's result.
- **A retrieval quality benchmark.** Twenty queries (ten Chinese, ten English)
  across documentation, releases, packages and news, each with expected domains.
  `scripts/bench.mjs` records real engine output once, then replays it offline so
  a ranking change is a number, not an opinion. Metrics: precision@8, recall@8,
  MRR@8, per-engine contribution and consensus. Baseline 0.3625 / 0.7417 / 0.7600.

### Fixed
- An anti-bot page served with HTTP 200 was parsed as "zero results", which
  removed an engine silently while keeping its slot reserved and never engaging
  its cooldown. Such pages now report `SEARCH_BLOCKED`, and 360 — walled from
  this network through both the direct and tunnel paths — moved to the fallback
  tier so it no longer slows every search.

## 0.12.0

### Added
- **Fetched pages come back as article Markdown**, not raw markup. Extraction
  picks the article root, prunes page furniture, renders headings, lists, code
  fences, tables, entities and absolute links, and cuts at `fetchMaxLength` with
  a notice naming the original length. `fetchFormat` can return plain text.
- **`search_many`** answers one to five queries in a single call with a
  concurrency cap of three and per-query error isolation.
- **The cache survives a restart.** A versioned snapshot keeps summaries only,
  is written atomically, caps itself at 4 MiB with LRU eviction, and treats a
  corrupt or unreadable file as an empty cache. `cachePersist` and `cacheFile`
  control it.

### Fixed
- `cacheTtlMs`, `cacheEntries`, `cachePersist` and `cacheFile` are read live, so
  a Settings edit takes effect without a remount, like every other volatile
  field.

- `fetchFormat` / `fetchMaxLength` are resolved per request, so the Settings page
  no longer needs a reload for them either; only the cache file path and the
  persist switch are read at mount.

### Known limits
- The host fetch request carries only a url, so a page cannot be resumed at an
  offset: raise `fetchMaxLength` or fetch a narrower page.
- Two processes writing the same cache file is last-writer-wins.

## 0.11.0

### Added
- **`domain_search`, a second tool for the sources a web search cannot reach.**
  Eight keyless adapters — GitHub, npm, PyPI, arXiv, Wikipedia, Hacker News,
  Stack Exchange, crates.io — each with its own timeout, each failing alone:
  one dead source never empties the answer, and its name comes back in
  `failures`.
- **`timeRange`, and publication dates behind it.** Parsers now read dates from
  Bing, 360, the DuckDuckGo timestamp and the AnySearch content trailer;
  DuckDuckGo receives the window as `df=`, the rest are filtered locally, and
  `freshnessBoost` / `freshnessDays` finally score something real instead of
  sitting on a missing field.

### Changed
- Undated results no longer survive a time window by default. A window keeps the
  dated rows inside it; only when nothing dated falls inside does the undated
  list come back, so "the last day" is not answered with pages of unknown age.
- The Settings card has twenty controls in four groups, including a new
  dedicated-search group.

### Known limits
- PyPI publishes no search API, so its source matches the exact package name
  taken from the first word of the query.
- Wikipedia answers in one language: Chinese/Japanese/Korean questions use zh,
  everything else en.
- Bing and 360 accept time-filter parameters that the pages display as selected
  while returning the same results, so those two are filtered locally.

## Unreleased

### Added
- **`domain_search`: key-free vertical search for packages, papers, code, Q&A
  and reference material.** Eight credential-free adapters — GitHub
  repositories, npm, PyPI (exact package name, since PyPI has no public search
  API), arXiv, Wikipedia (zh for CJK queries, en otherwise), Hacker News,
  Stack Exchange and crates.io — run concurrently, interleave by rank and merge
  into the same `{ url, title, snippet, publishedAt }` shape `web_search`
  returns. One source failing, timing out or answering HTTP 500 is reported as
  a failure line and never blocks the others; every request carries a
  User-Agent and its own deadline.
- Three settings fields, all `.volatile()`: `domainSources` (enabled adapters),
  `domainLimit` (results per source, default 5) and `domainTimeoutMs` (per-source
  deadline, default 8000 ms). The dedicated-sources group is editable from the
  Settings page.
- The tool registers through the host's real `ToolRuntime.register(definition)`
  API, read with `ctx.get('tools')` rather than `inject` so a deployment without
  a tool registry still mounts the plugin and keeps `web_search`. If another
  plugin owns `domain_search`, it registers as `web_domain_search`.
- `scripts/verify-tool-registration.mjs` proves the definition against a real
  `ToolRuntime`; `scripts/smoke-verticals.mjs` is the live, non-CI smoke.
- Offline fixtures and tests for all eight parsers: normal and empty payloads,
  HTTP 500, timeout on an injected fetch, and single-source failure isolation.

## 0.10.0

### Added
- **Both READMEs are rewritten for people, not for compilers.** A worked
  before/after scene, a concepts section (what a model knows, what an agent is,
  `web_search` versus `web_fetch` with a library analogy, messages and sessions,
  providers, bundles), twelve capability lines, eight FAQ entries, and the
  technical material moved into an appendix.
- Every Settings control carries a plain-language label and a one-line hint; the
  hint line existed in the card but no dictionary entry ever filled it, and the
  AnySearch fields had no label at all.

### Fixed
- The two array fields no longer claim to be read-only: they are editable from
  the card as comma separated values.

## 0.9.1

### Fixed
- **The AnySearch fields were missing from the card.** The client renders the
  controls it knows about from its own field list, and `anysearchApiKey` /
  `anysearchDomain` were never added there, so the API key had no entry — the
  form showed 14 controls where the schema has 16.
- `max_results` asked AnySearch for 20 while the service caps it at 10 and
  silently returns 10, so the constant now states the real ceiling.

### Changed
- Every configuration description is in Chinese, and the API key field says what
  an empty value means: anonymous access at a lower rate limit.
- New [docs/plugin-settings-form.md](docs/plugin-settings-form.md): the four-layer
  chain that decides whether a plugin's configuration reaches Settings, with
  file:line evidence and the four wrong diagnoses this plugin went through.

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

