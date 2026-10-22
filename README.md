# dsh-web-search-bing

A **key-free** search backend for the DeepSeek Harness `web_search` tool: it
fetches public result pages (DuckDuckGo, Bing, 360) and one anonymous JSON API
(AnySearch) locally, parses titles, links and snippets, and hands them to the
`ctx.web` seam. No provider API key, no credential, only ordinary outbound
network access.

- [中文说明](README.zh-CN.md)
- [Architecture](docs/architecture.md) · [Engines and their quirks](docs/engines.md) · [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)

> **Status: 0.7.0 is unreleased.** The rewrite lives in `src/*.ts` and is
> compiled to `lib/` (which `package.json` points `main` at). Build before
> mounting from a checkout — see [Install](#install).

## Why it is needed

The search provider the harness ships with (`deepseek-official`) has no local
retrieval step. It sends a Messages request to DeepSeek's Anthropic-compatible
endpoint and lets the **server-side** `web_search` tool
(`web_search_20250305` → `web_search_tool_result`) do the searching, then maps
the result blocks into a source list. So:

- without DeepSeek credentials `apiKey()` throws
  `WEB_PROVIDER_CREDENTIAL_MISSING` and `web_search` fails structurally;
- pointing the provider at a third-party relay does not help, because the search
  semantics live in the server-side tool, not in the request shape. Measured on
  a relay: `/v1/messages` accepted the `tools` declaration but never executed it
  — Claude-4.5-Sonnet stalled for 900 s, DeepSeek-V4.1-Flash returned only a
  thinking block saying it had no web-search tool — and the failure merely became
  `WEB_PROVIDER_ERROR: DeepSeek returned no web_search_tool_result blocks`.

This plugin moves retrieval back into the process: it requests public result
pages itself, parses them, and returns sources through the `ctx.web` provider
contract. `web_fetch` does not go through this plugin and is unchanged.

## Interface

`apply(ctx, config)` registers a provider with
`ctx.web.registerSearchProvider({ id, available, search })`:

- `id`: `bing`, selected by `web.searchProvider`;
- `available()`: synchronous, always `true`;
- `search(request, signal)`: returns `{ sources, truncated }`, where each source
  is `{ url, title?, snippet?, publishedAt? }`. Empty fields are omitted rather
  than written as `''`, and sources are deduplicated by URL. When every engine
  fails, it throws an `Error` whose message contains each engine's failure
  reason. A blank query is rejected, and caller cancellation surfaces as an
  error rather than an empty list.

## Install

Requirements: a DeepSeek Harness profile with the `web` service, and Node 22.18+
(the source uses native TypeScript type stripping; the reference runtime here is
Node 24). No API key is involved.

From a checkout, compile first — `main` points at `lib/index.js`, which does not
exist until the build has run:

```sh
npm run build
```

The bundle declares its patch in `cordis.patch.yml`:

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
```

Then select the provider on the profile's `web` row:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http
```

Editing `src/*.ts` requires **rebuilding and restarting DSH**: an ESM module is
evaluated once per process and a running host keeps the code it was loaded with.

## Engines

Each engine declares a tier, the query language side it leads, a weight and a
transport. `primary` engines run concurrently; `fallback` engines run only when
no primary produced a single source.

| id | tier | region | weight | transport | notes |
| --- | --- | --- | --- | --- | --- |
| `anysearch` | primary | both | 2 | direct first, JSON `POST` | `api.anysearch.com/v1/search`, anonymous. Most precise; leads ASCII **and** CJK queries; two slots per fusion round. Caps at 10 results per anonymous call. |
| `ddg-html` | primary | global | 1 | tunnel only (`viaProxy`) | `html.duckduckgo.com/html/`. Widest English original-document coverage. |
| `cn.bing` | primary | cn | 1 | direct first, tunnel on failure | `cn.bing.com/search`. Domestic workhorse for Chinese queries; direct URLs. |
| `so` | primary | cn | 1 | direct first, tunnel on failure | 360 (`www.so.com/s`). Good Chinese relevance; the real URL is in the anchor's `data-mdurl`. |
| `www.bing` | fallback | global | 1 | tunnel only (`viaProxy`) | Bing international (`setmkt=en-US`). **Demoted to a fallback**: measured on stopword-heavy English it matched a single token (see below). |
| `ddg-lite` | fallback | global | 1 | tunnel only (`viaProxy`) | `lite.duckduckgo.com/lite/`. Backup endpoint for `ddg-html`. |

Every engine that is not `viaProxy` is tried directly first, because that is both
faster and the path the site expects; only a direct failure is retried through
the tunnel. The three `viaProxy` engines take part only when a proxy is
available, so a machine without one still searches through `anysearch`,
`cn.bing` and `so`.

## Bilingual region policy

Engines whose region matches the query script — or are marked `both` — form the
leading group. It fills the caller's budget first; the other region only appends
when the leading group came up short. The policy exists so an English query is
not filled with dictionary pages from an engine that matched one word of it:

- `how does tokio schedule tasks` — the domestic result was a dictionary page
  for "does";
- `how to set up postgres logical replication` — Bing returned jigsaw-puzzle
  sites for "set".

| Query script | Leading region | Measured effect |
| --- | --- | --- |
| ASCII only | `global` + `both` | first 8 sources were 8/8 foreign, on-topic resources: PostgreSQL manuals, `tokio.rs`, `corrode.dev`, Kubernetes documentation |
| contains CJK | `cn` + `both` | first 8 sources were mostly Chinese resources, plus AnySearch's original documentation and translated books |

### A/B evidence: CJK queries need AnySearch too

Same queries, two runs: A with domestic engines only (`cn.bing` + 360), B with
AnySearch added.

| Query | A — domestic engines only | B — plus AnySearch |
| --- | --- | --- |
| `如何配置 postgres 逻辑复制` | Baidu Baike page for the word "如何", a 张悬 song-lyric analysis, an unrelated Zhihu thread ❌ | Cloud SQL documentation, a cnblogs walkthrough, the AWS specification guide, Azure documentation, Tencent Cloud, a Taobao database monthly ✅ |
| `Python GIL 是什么` | python.org home page, download page, a tutorial site — **not one explains the GIL** ❌ | Zhihu's "谈谈 python 的 GIL", a GIL explainer on `cenalulu.github.io`, CSDN's "什么是 GIL", JetBrains' Chinese blog, Wikipedia's 全域直譯器鎖 ✅ |
| `DeepSeek Harness 插件开发` | deepseek.com home page, Baidu Baike, App Store, a GitHub org page — all front-page noise ❌ | a Zhihu hands-on tutorial, `github.com/deepseek-ai/deepseek-harness`, the official harness page, a dev.to tutorial, a bilibili video ✅ |
| `Rust 所有权 借用检查` | rust-lang home page, a tutorial site, Baidu Baike | `colobu.com`'s Chinese *Effective Rust*, a Reddit thread, rustwiki's learn-Rust-by-counterexample, `rust-book.junmajinlong.com` ✅ |

The largest gap is exactly on **questions and stopword-heavy** Chinese queries,
where domestic engines treat "如何"/"是什么" as search terms and return dictionary
and encyclopedia pages. The price is visible: a Chinese query takes 1.4–2.3 s
instead of 0.2–0.7 s with domestic engines alone.

## Waiting policy (`wait`)

A tier releases on the first of: every engine settled, every engine of the
leading region settled (success or failure), enough sources from enough
contributors, or the soft deadline. Engines still running at the deadline are
aborted, and reported as `still running at deadline` (or `aborted once enough
results had arrived`).

| `wait` | Behaviour | Soft deadline | Measured |
| --- | --- | --- | --- |
| `auto` (default) | ASCII waits for the `global` side, CJK for the `cn` side | 6000 ms ASCII / 3500 ms CJK | 2.6–3.8 s English / 1.4–2.3 s Chinese |
| `fast` | return as soon as one engine has results | 3500 ms | fastest, least cross-engine merging |
| `all` | wait for **every** engine in the tier | 10000 ms | most complete, waits for the slowest engine |

Waiting the extra couple of seconds for an English query roughly doubles
document coverage — measured 16–30 sources across 12–21 distinct domains.

## Ranking

Answers are merged with **reciprocal rank fusion** (RRF). An engine exposes no
comparable score, only its own ordering, so the merge reads the rank each source
holds in every list that returned it. Weight cannot simply multiply that score:
at `rrfConstant = 60` the distance between rank 1 and rank 10 is `1/61` against
`1/70`, so a weight of 2 would beat every other engine at every rank and take the
whole list by itself — measured, that is exactly what happened before this rule
was fixed: on a CJK query AnySearch (weight 2) returned all 8 sources and no
Chinese engine appeared at all.

Weight therefore shapes **admission**, not score. The per-engine lists are walked
in a weighted round robin — a weight-2 engine takes two consecutive rows per
round, so it owns roughly twice the slots — and that interleaved order gives each
candidate its 1-based `position`. A source then scores

```
score(source) = votes / (rrfConstant + position)
```

where `votes` is the number of **distinct engines** that returned it, so
cross-engine agreement compounds while one engine's weight does not, and
`rrfConstant` flattens the position curve (default 60). Measured with weights
2/1/1 over lists of 10, 10 and 4 results at `limit: 8`, admission splits 4/2/2;
the old weight-as-multiplier rule produced 8/0/0. Two multipliers ride on top:

- **authority** — sources on an official documentation domain are multiplied by
  `1 + authorityBoost` (default 0.25). The built-in list covers PostgreSQL,
  Kubernetes, Rust, SQLite, Python, Node.js, MDN, AWS, Microsoft Learn, Google
  Cloud, W3C, RFC Editor, man7, Docker, Git, MySQL, Redis and nginx; extra
  domains can be added with `authorityDomains`.
- **freshness** — a result published `ageDays` ago is multiplied by
  `1 + freshnessBoost × (1 − ageDays / freshnessDays)` while it is younger than
  `freshnessDays` (defaults 0.2 and 30). An unparsable date is ignored, never
  penalised.

Ties are deterministic: earlier engine index, then earlier rank within it, then
the URL string. The bilingual region policy is applied before fusion, so the
losing region can never reorder the head of the list.

> No engine currently sets `publishedAt`: the scraped pages do not expose a
> stable date, so results carry none and the freshness boost is inactive until
> an engine supplies one.

## Caching

Successful, non-empty results are cached per logical request. The key is
`lead|wait|limit|sorted engine ids|normalised query` — the query is trimmed,
lowercased and has internal whitespace collapsed, and engine order never
matters. The engine ids are the set the run would use *before* the cooldown
filter, so an engine entering or leaving a cooldown cannot invalidate an entry
that is still fresh. Entries expire after `cacheTtlMs` (default 10 minutes) and the least
recently used entry is evicted beyond `cacheEntries` (default 100);
`cacheTtlMs: 0` disables the cache. Cached arrays are copied in and out, so a
caller cannot mutate the cache. A hit skips every request, so the failure list
contains only the cooldown notices gathered before the lookup.

## Cooldown

Scraping a public result page is not a supported interface, so an engine that
answered with a block page is rested instead of re-triggered on every search.
The failure is classified, and the code decides what happens next:

- `SEARCH_THROTTLED` (HTTP 429), `SEARCH_BLOCKED` (HTTP 403 or an echoed-query
  mismatch), `SEARCH_TIMEOUT` and `SEARCH_NETWORK` cool the engine down;
- `SEARCH_PARSE` (markup drift — retrying cannot help) and `SEARCH_ABORTED`
  (the caller cancelled) never do.

A cooldown lasts the service's own `Retry-After` when one was sent (delta
seconds or an HTTP date, read from the final redirect hop), otherwise
`baseCooldownMs` doubled per consecutive failure, capped at `maxCooldownMs` —
5 minutes to 30 minutes by default. A success resets the streak. Cooldowns never
empty the engine set: if every engine is cooling, the run uses them anyway. A
skipped engine appears in the failure list as
`cooling down for another 2m 10s after SEARCH_THROTTLED`.

## Fetching pages from a restricted network

`web_search` and `web_fetch` are different jobs: search discovers a URL, fetch
reads it. The plugin ships a provider for both, because on a restricted network
the second half is the one that breaks. Measured here:

| Host | Direct | Through the local tunnel |
| --- | --- | --- |
| `github.com` | timeout | 200 in 3.5s |
| `html.duckduckgo.com` | timeout | 202 in 1.2s |
| `api.anysearch.com` | 200 (2.1s) | 200 (1.0s) |
| `cn.bing.com`, `www.so.com` | 200 | 200 |

So a search that returns a GitHub URL used to be a dead end: the agent could see
the result and could not read it. Point the `web` service at this provider and
the ladder takes over — direct first, then the tunnel, then AnySearch extraction
when a key is set:

```yaml
- id: web
  config:
    searchProvider: bing
    fetchProvider: http-proxy
```

## Configuration

The loader validates the config section against a schemastery schema before
`apply` runs, so a bad value fails loudly with its path (`$.timeoutMs expected
number >= 500 but got 10`) rather than silently falling back to a default.
Unknown keys are not rejected, so spell the names from the table below exactly.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hosts` | `string[]` | `[]` (all) | Restrict the run to these engine ids. |
| `timeoutMs` | integer ≥ 500 | `15000` | Per-engine request deadline. |
| `wait` | `auto`, `all`, `fast` | `auto` | How long a tier waits. |
| `proxy` | string | `''` (detect) | Explicit tunnel URL, e.g. `http://127.0.0.1:7890`. |
| `limit` | integer 1–20 | `8` | Upper bound on returned sources; the caller's `maxResults` wins when smaller. |
| `rrfConstant` | integer ≥ 1 | `60` | RRF constant; larger flattens the rank curve. |
| `authorityDomains` | `string[]` | `[]` | Extra domains earning the authority boost, on top of the built-in list. |
| `authorityBoost` | number 0–10 | `0.25` | Added multiplier for an authoritative domain: `× (1 + boost)`. |
| `freshnessBoost` | number 0–10 | `0.2` | Added multiplier for a result published today; fades linearly to zero. |
| `freshnessDays` | integer ≥ 1 | `30` | Age at which the freshness boost has faded out. |
| `anysearchApiKey` | string | `''` | Bearer token for `api.anysearch.com`; empty means anonymous. |
| `anysearchDomain` | string | `''` | AnySearch vertical index (`finance`, `academic`, `security`, `legal`, `code`); dotted values select a sub-domain. |
| `cacheTtlMs` | integer ≥ 0 | `600000` | Cache lifetime; `0` disables the cache. |
| `cacheEntries` | integer ≥ 0 | `100` | Cached queries before the least recently used is evicted. |
| `baseCooldownMs` | integer ≥ 0 | `300000` | Cooldown after a failure that carried no wait hint. |
| `maxCooldownMs` | integer ≥ 0 | `1800000` | Ceiling for the exponential cooldown. |

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    wait: auto
    limit: 8
    proxy: "http://127.0.0.1:7890"   # omit to auto-detect
    anysearchApiKey: ''       # keep it in the profile, not in the repository
    anysearchDomain: ''       # or finance / academic / security / legal / code
    cacheTtlMs: 600000
```

## Proxy

Node's global `fetch` reads neither the macOS system proxy settings nor
`HTTPS_PROXY`: undici honours them only when the process is started with
`NODE_USE_ENV_PROXY=1`, and that cannot be enabled from inside a running
process; `undici.ProxyAgent` is not reachable either. So when a proxy is needed
this plugin speaks to it directly: it opens an HTTP `CONNECT` tunnel, upgrades it
with TLS for `https:` targets, writes the request itself and decodes
`Content-Length`, chunked, gzip, deflate and brotli bodies, following up to four
redirects hop by hop. `307`/`308` keep the method and body; any other `3xx`
downgrades a `POST` to a bodyless `GET`. Proxying is scoped to this plugin — the
rest of the app keeps its ordinary network path.

Resolution order: explicit `proxy` config → the environment
(`DSH_WEB_SEARCH_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `HTTP_PROXY`, both casings)
→ the macOS system proxy from `scutil --proxy`, which is only adopted when its
port accepts a TCP connection (400 ms probe). The decision is cached for 60
seconds. So with a tunnel running and set as the system proxy, no configuration
is needed; with the tunnel off the port refuses and the run degrades to direct
requests instead of failing. Under TUN/enhanced mode the kernel takes over TCP
transparently and this module behaves like a direct request. Only HTTP proxies
are supported — `socks5://` must be replaced with the client's HTTP/mixed port.

See [docs/troubleshooting.md](docs/troubleshooting.md) when detection does not
pick your proxy.

## Development

```sh
node --test test/*.test.ts     # the whole suite
node --test test/proxy.test.ts # one file
npm run typecheck              # tsc --noEmit over src/**/*.ts
npm run build                  # compile src/ to lib/
npm run check                  # typecheck + tests
```

The suite is offline: parser tests replay captured fixtures from
`test/fixtures/`, transport tests never open a socket, and proxy tests exercise
`parseProxy`, `proxyFromEnv` and the pure response framer.

CI (`.github/workflows/ci.yml`) runs the same steps on Node 24 for Ubuntu and
macOS: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and a check
that the build emitted the declared `lib/index.js` entry point.

## Known limitations

- Relevance depends on upstream result pages, so it is below a commercial search
  API; key-free scraping is rate limited in return (measured: 360 served its
  `访问异常页面` with a captcha, another domestic engine a `x5sec` punish page).
  Cooldowns and multiple engines cover for that.
- **Google is unreachable from this network.** A tunnelled
  `www.google.com/search` returns a JavaScript shell (94 KB, 1–3 links), and
  headless Chrome is redirected to `google.com.hk` with a reCAPTCHA page;
  `gbv=1`, a consent cookie and a mobile user agent all failed. Eight public
  SearXNG instances were also unusable (429/403/not JSON).
- Upstream markup changes break a parser. That degrades to a failure reason and
  the next engine; `web_search` reports which engines were tried and why each
  failed rather than returning a silently empty list.
- Titles, links and snippets only — no page text. Use `web_fetch` for that.
- No `publishedAt` is produced today (see [Ranking](#ranking)).
- Anonymous AnySearch caps at 10 results per call.
- Only HTTP proxies are supported (see [Proxy](#proxy)).

## Documentation

- [docs/architecture.md](docs/architecture.md) — module map and the data flow
  from the `web` seam to a source list.
- [docs/engines.md](docs/engines.md) — each engine's request shape, parser
  quirks and what was measured.
- [docs/troubleshooting.md](docs/troubleshooting.md) — no results, proxy not
  detected, provider not selected, cooldown stuck.
- [README.zh-CN.md](README.zh-CN.md) — the Chinese guide.

## Licence

MIT © 2026 fangchenghao. See [LICENSE](LICENSE).
