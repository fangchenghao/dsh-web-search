# Architecture

How a `web_search` call becomes a list of sources, and which module owns which
decision. Everything described here exists in `src/*.ts`; the compiled output in
`lib/` is what `package.json` points at.

- [Engines and their quirks](engines.md)
- [Troubleshooting](troubleshooting.md)
- [README](../README.md) · [中文说明](../README.zh-CN.md)

## Module map

| Module | Owns | Exports worth knowing |
| --- | --- | --- |
| `src/types.ts` | Every contract: `Source`, `HostSpec`, `EngineAnswer`, `SearchOptions`, `SearchOutcome`, `RankOptions`, `CacheOptions`, `HealthOptions`, `SearchErrorCode` | types only, no runtime code |
| `src/errors.ts` | The one error class and the `Retry-After` parser | `SearchError`, `parseRetryAfter` |
| `src/config.ts` | The schemastery schema, the defaults and their normalisation | `Config`, `resolveConfig`, `PluginConfig`, `ResolvedConfig` |
| `src/index.ts` | The plugin entry: `apply` registers the provider with the `web` seam and owns one cache and one health tracker per mount | `apply`, `name`, `inject`, `PROVIDER_ID` |
| `src/engines.ts` | The engine registry, the region policy, tier scheduling and the cache/cooldown integration | `HOSTS`, `search` |
| `src/transport.ts` | One engine request, direct or tunnelled, classified into a `SearchError` | `searchHost` |
| `src/proxy.ts` | Proxy detection and the hand-written `CONNECT`/TLS transport | `parseProxy`, `proxyFromEnv`, `proxyFromSystem`, `resolveProxy`, `proxyGet`, `readResponse` |
| `src/parsers.ts` | The five payload parsers plus the URL, entity and echoed-query helpers | `resolveHref`, `parseDdgHtml`, `parseDdgLite`, `parseBing`, `parseSo`, `parseAnySearch`, `echoesQuery`, `text` |
| `src/rank.ts` | Dedupe, weighted interleave, weight-as-admission RRF (votes over merged position), region merge | `dedupe`, `interleave`, `fuse`, `mergeRegions`, `RRF_CONSTANT`, `DEFAULT_AUTHORITY_DOMAINS` |
| `src/cache.ts` | TTL + LRU result cache with an injectable clock | `cacheKey`, `SearchCache` |
| `src/health.ts` | Per-engine cooldown, exponential backoff, `Retry-After` override | `EngineHealth` |

Dependency direction is one-way and acyclic: `index → engines → {transport,
rank, cache, health, parsers, proxy}`, every module → `types`, and `proxy` /
`transport` / `engines` → `errors`. `parsers`, `rank`, `cache` and `health` never
touch the network; `proxy` never parses a result page.

## Data flow

1. **Seam call.** The harness calls the provider registered by `apply`
   (`src/index.ts`) with `(request, signal)`. `request.query` must be a non-empty
   string; `request.maxResults`, when a positive integer, caps the budget.
2. **Config.** The loader has already validated the config section against
   `Config`; `resolveConfig` turns it into the engine layer's shape. `limit`
   becomes `min(maxResults ?? config.limit, config.limit)`.
3. **Search.** `search(query, signal, options)` in `src/engines.ts`:
   - resolve the proxy (`useProxy: false` forces direct; otherwise
     `resolveProxy(config.proxy)`);
   - filter `HOSTS` by `hostIds`, and drop `viaProxy` engines when no proxy is
     available;
   - split engines into usable / cooling, but never end up with zero engines —
     if everything is cooling, everything is used;
   - compute the leading region from the query script (`global` for ASCII, `cn`
     for CJK);
   - look up the cache with a key built from the normalised query, the budget,
     the wait policy, the lead region and the sorted engine ids.
4. **Tier run.** Engines of the leading region first, then the rest, split into
   `primary` and `fallback`. `runTier` asks every engine of a tier concurrently
   through `searchHost` and releases on the first of:
   - every engine settled;
   - every engine of the leading region settled (success *or* failure), so a
     failed engine cannot hold the tier open until the deadline;
   - `available() >= limit` sources from at least `needed` contributors;
   - the soft deadline (`auto`: 6 s ASCII / 3.5 s CJK, `fast`: 3.5 s, `all`: 10 s).

   Engines still running at release are aborted and reported as
   `aborted once enough results had arrived` or `still running at deadline`.
5. **Per engine.** `searchHost` (`src/transport.ts`) builds the URL from
   `host.build(query)` and picks a route: a domestic engine goes direct first
   and is retried through the tunnel only if that fails; a `viaProxy` engine
   tunnels immediately. Direct requests use global `fetch` with
   `AbortSignal.timeout` combined with the caller's signal; tunnelled requests
   use `proxyGet`.
6. **Classify.** A non-2xx status becomes `SEARCH_THROTTLED` (429),
   `SEARCH_BLOCKED` (403 and everything else in the 4xx range),
   `SEARCH_NETWORK` (5xx and transport failures) or `SEARCH_TIMEOUT` (a deadline
   that expired). A JSON API validates itself; every scraped page must pass
   `echoesQuery` or it is `SEARCH_BLOCKED`. A parser that throws is
   `SEARCH_PARSE` and is **not** retryable. Cancellation is rethrown, never
   returned.
7. **Parse.** `host.parse(payload, url)` returns `Source[]` with absolute
   `http(s)` URLs and no empty fields.
8. **Health.** Each settled engine updates the tracker: success clears its
   streak, failure may start or extend a cooldown.
9. **Fuse.** `mergeRegions(answers, lead, limit, rank)` fuses the leading group
   with RRF and fills the budget; the other region is fused separately and only
   appended (deduped against the head) when the head came up short. If the
   primary tier produced nothing, the fallback tier runs and the same merge is
   applied. Weight is an *admission* share, not a score multiplier: each engine's
   list is walked in a weighted round robin to give every candidate a 1-based
   position, and the score is `votes / (rrfConstant + position)`, with `votes`
   counting the distinct engines that returned the source.
10. **Return.** A non-empty result is cached, then returned as
    `{ sources, failures, proxy }`. `index.ts` re-slices to the budget and sets
    `truncated`, or throws an `Error` that lists every engine's failure reason.

## Frames and invariants

- **Failures are values.** One dead engine degrades into the next one; only
  cancellation escapes as a rejection.
- **Parsers never throw on markup drift.** They return `[]`, and the transport
  records a parse failure.
- **Empty fields are omitted, not emptied.** A source never carries `title: ''`.
- **Determinism.** Fusion ties resolve on engine index, then rank, then URL, so
  the same answers always produce the same order.
- **No credentials.** Nothing in the flow reads or sends an API key.

## Failure codes

| Code | Produced by | Cools the engine down |
| --- | --- | --- |
| `SEARCH_THROTTLED` | HTTP 429 | yes |
| `SEARCH_BLOCKED` | HTTP 403, other 4xx, echoed-query mismatch | yes |
| `SEARCH_NETWORK` | HTTP 5xx, transport error | yes |
| `SEARCH_TIMEOUT` | a request that hit its deadline | yes |
| `SEARCH_PARSE` | a parser that threw | no — retrying markup cannot help |
| `SEARCH_ABORTED` | the caller cancelled | no |

The cooldown length comes from `Retry-After` when the service sent one (delta
seconds or an HTTP date, read from the final redirect hop), otherwise
`baseCooldownMs × 2^(failures−1)`, capped at `maxCooldownMs`.

## Cache key

`cacheKey` builds `lead|wait|limit|sorted engine ids|normalised query`. The query
is trimmed, lowercased and has internal whitespace collapsed; engine order never
matters because the ids are sorted. The engine ids are the ones the run would use
*before* the cooldown filter, so an engine entering or leaving a cooldown does not
invalidate an entry: otherwise every throttle would turn the next identical query
into a cache miss. Only successful, non-empty results are stored. A hit returns a copy and skips every request. `ttlMs: 0` disables the
cache entirely; past `maxEntries`, the least recently used entry is evicted.

## Proxy transport

`proxyGet` opens an HTTP `CONNECT` tunnel to the target host and port, upgrades
the socket with TLS when the target is `https:`, writes the request itself
(`accept-encoding: identity`, `connection: close`) and decodes the response:
`Transfer-Encoding: chunked`, `Content-Length`, `gzip`, `deflate` and `br`.
Redirects are followed hop by hop, re-opening the tunnel each time, up to four
hops. `307`/`308` preserve the method and body; any other `3xx` downgrades a
`POST` to a bodyless `GET`. The final hop's status, headers (lowercased), body
and URL are returned, which is how the caller can read `Retry-After`.

Proxy selection is explicit config → environment (`DSH_WEB_SEARCH_PROXY`,
`HTTPS_PROXY`, `ALL_PROXY`, `HTTP_PROXY`, both casings) → macOS `scutil --proxy`
gated by a 400 ms TCP probe, cached for 60 seconds. Only `http://` proxies are
dialled from detection, because the tunnel itself is a plain `CONNECT`; an
`https://` value elsewhere in the environment is skipped rather than selected.

## Build and runtime layout

- `src/**/*.ts` is the source of truth; `npm run build` compiles it to `lib/`
  (`tsconfig.json`, `rootDir: src`, `outDir: lib`).
- `package.json` points `main` and `types` at `lib/index.js` /
  `lib/index.d.ts`, so a checkout must be built before it can be mounted.
- Relative imports carry the `.ts` extension and `rewriteRelativeImportExtensions`
  rewrites them on emit; the source is also runnable directly by Node's type
  stripping, which is how the tests run (`node --test test/*.test.ts`).
- `types.ts` is types only, so it emits nothing; every other module emits a
  normal ES module.
- `index.js`, `engines.js` and `proxy.js` are the pre-rewrite JavaScript
  implementation. They are not imported by `src/` and are not part of the
  TypeScript build.

## Route memory and engine health

`EngineHealth` does two jobs. It keeps the failure cooldown (an engine that
returned a retryable block rests for 5–30 minutes) and, since 0.21.0, a
ten-minute route preference. A direct request that ends in `403`/`429` and then
succeeds through the tunnel records `proxy` for that engine; the next request
tries the tunnel first, and the direct route stays as a fallback. A later direct
success clears the preference. The transport test drives this through a real
HTTP `CONNECT` proxy rather than mocking `proxyGet`.

## MCP runner

`mcp/server.mjs` is a dependency-free stdio JSON-RPC process. It imports the
same `lib/engines.js`, `lib/fetch.js`, `lib/research.js` and
`lib/verticals.js` as the DSH plugin, exposes four tools (`search`, `fetch`,
`research`, `domain_search`), wraps every output in the untrusted-content
boundary and never reads a DSH profile. It is not a second search
implementation; a ranking or transport fix reaches both runtimes after
`npm run build`.
