# Engines

What each engine is asked for, how its answer is parsed, and what was actually
measured on this network. The registry is `HOSTS` in `src/engines.ts`; the
parsers are in `src/parsers.ts`; the shared request path is
`src/transport.ts`.

- [Architecture](architecture.md)
- [Troubleshooting](troubleshooting.md)
- [README](../README.md) · [中文说明](../README.zh-CN.md)

## The shared request

Every engine gets the same base headers, built in `src/transport.ts`:

```
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15
accept-language: zh-CN,zh;q=0.9,en;q=0.8
accept: application/json            (JSON POST engines)
accept: text/html,application/xhtml+xml   (scraped pages)
content-type: application/json      (JSON POST engines only)
```

- **Route.** `anysearch`, `cn.bing` and `so` go direct first and are retried
  through the tunnel only if the direct attempt fails. `ddg-html`, `www.bing` and
  `ddg-lite` are `viaProxy`: they tunnel from the start, and they are filtered out
  of a run when no proxy is available rather than failing slowly.
- **Deadline.** `timeoutMs` per attempt (default 15 000 ms). Direct requests use
  `AbortSignal.timeout` combined with the caller's signal; tunnelled requests use
  the socket timeouts in `src/proxy.ts`.
- **Redirects.** Direct requests let `fetch` follow them; tunnelled requests
  follow up to four hops themselves.
- **Echo check.** Every scraped page must contain one query token of at least
  three characters (`echoesQuery`) or it is treated as a rate-limit page. JSON
  engines set `skipEcho` because their envelope validates itself.

## `anysearch` — anonymous JSON API

| | |
| --- | --- |
| Request | `POST https://api.anysearch.com/v1/search` |
| Body | `{"query":"<query>","max_results":20}` |
| Region / weight | `both` / 2 (two slots per fusion round) |
| Tier | primary |

The response is an envelope, not markup:

```json
{ "code": 0, "message": "success", "request_id": "…",
  "data": { "results": [{ "title": "…", "url": "…", "snippet": "…", "content": "…" }], "metadata": { } } }
```

`parseAnySearch` requires `code === 0` and an array at `data.results`; anything
else — a non-zero code, bad JSON, a missing array — yields `[]` rather than an
exception. Rows are dropped when `url` does not resolve to an absolute `http(s)`
URL, and empty `title`/`snippet` fields are omitted. The extra `content` field is
deliberately ignored: the seam wants a citable title/link/snippet, and the body
belongs to `web_fetch`.

A live capture (see [fixtures](../test/fixtures/README.md)) shows the envelope
and rows above, plus the service's error shape: an empty query is answered with
HTTP 400 and `{"code":-1,"message":"Query is required."}`.

The endpoint is metered: anonymous calls return at most 10 results, and the
provider's free tier with a key is documented upstream as 1 000 requests per day.
That is why the engine asks for 20 rows (`ANYSEARCH_MAX_RESULTS`) but the merge
sees at most what the service sends.

## `ddg-html` — DuckDuckGo HTML

| | |
| --- | --- |
| Request | `GET https://html.duckduckgo.com/html/?q=<urlencoded query>` |
| Region / weight | `global` / 1 |
| Tier / route | primary / tunnel only |

The richest English endpoint of the three DuckDuckGo faces here. `parseDdgHtml`
matches anchors whose `class` is `result__a` (single or double quotes, any
attribute order), takes the anchor text as the title, and looks for an element
with `class="result__snippet"` between this anchor and the next one as the
snippet. Hrefs may be direct or wrapped as `/l/?uddg=<percent-encoded>`, which
`resolveHref` unwraps.

Measured: the live capture on 2026-10-22 serves **direct** hrefs, not the `uddg`
wrapper that the original implementation was written against. The unwrapper is
kept because the wrapper still appears, and it is pinned by a synthetic fixture.

## `cn.bing` — Bing China

| | |
| --- | --- |
| Request | `GET https://cn.bing.com/search?q=<urlencoded query>` |
| Region / weight | `cn` / 1 |
| Tier / route | primary / direct first, tunnel retry |

The Chinese workhorse: the `cn` host targets the mainland index, mixed
Chinese/English queries work, and the result URLs are direct links. No market
parameters are sent.

## `www.bing` — Bing international (fallback)

| | |
| --- | --- |
| Request | `GET https://www.bing.com/search?q=<urlencoded>&setmkt=en-US&setlang=en&cc=US` |
| Region / weight | `global` / 1 |
| Tier / route | fallback / tunnel only |

`parseBing` splits the page on `<li class="b_algo"`, takes the first
`<h2><a href>` pair as title and URL, and the first `<p>` as the snippet.

Links are frequently Bing click trackers — `/ck/a?...&u=a1<base64url>` — where
the `&` arrives HTML-escaped as `&amp;`. `resolveHref` decodes `&amp;`/`&#38;`
first, base64url-decodes the payload, and rejects the tracker if no real target
comes out.

**Why it is only a fallback.** Measured on stopword-heavy English queries it
matched a single token and answered with unrelated pages: `how to set up postgres
logical replication` returned jigsaw-puzzle sites for "set", while the engines
above stayed on topic. It is worth reaching only when nothing else answered.

## `so` — 360 search

| | |
| --- | --- |
| Request | `GET https://www.so.com/s?q=<urlencoded query>` |
| Region / weight | `cn` / 1 |
| Tier / route | primary / direct first, tunnel retry |

`parseSo` splits on `class="res-list"`, finds the heading `<h3 class="res-title…">`
(the served class value carries a trailing space, and the wrapper is a `<li>` for
ordinary results and a `<div>` for rich ones, so the element name is not matched),
then reads the **`data-mdurl`** attribute of the first anchor after it. The
`href` is a 360 click tracker, which is not a citable source: a result without
`data-mdurl` is skipped. The snippet comes from `class="res-list-summary"`.

## `ddg-lite` — DuckDuckGo Lite (fallback)

| | |
| --- | --- |
| Request | `GET https://lite.duckduckgo.com/lite/?q=<urlencoded query>` |
| Region / weight | `global` / 1 |
| Tier / route | fallback / tunnel only |

`parseDdgLite` accepts single- or double-quoted attributes, because this page
serves `class='result-link'` where Bing serves double quotes. Each hit is
examined up to the next hit, which is where its sibling
`<td class='result-snippet'>` lives.

## Parser regressions

Six failures were paid for once and are now pinned by tests and fixtures:

1. a Bing `&amp;u=a1<base64url>` tracker must decode to the real target, not a
   `bing.com/ck/a` URL;
2. a DuckDuckGo `/l/?uddg=<urlencoded>` wrapper must unwrap to the target;
3. a single-quoted `class='result-link'` must still be parsed;
4. 360's `data-mdurl` must be used, not the click tracker;
5. an AnySearch envelope with `code !== 0` must yield `[]`;
6. `echoesQuery` must reject a rate-limit/captcha page served for a different
   query.

Fixtures: [test/fixtures/README.md](../test/fixtures/README.md) lists every file,
the exact URL it came from, the query and the capture date (2026-10-22). Two
files are synthetic and marked as such: the `uddg` wrapper and Bing's
rate-limited reply, whose block page could not be provoked on demand.

## What was measured

Timings on this network, with a tunnel on:

| Situation | Time |
| --- | --- |
| CJK query, `auto` | 1.4–2.3 s |
| CJK query, domestic engines only (no AnySearch) | 0.2–0.7 s |
| ASCII query, `auto` | 2.6–3.8 s |

Coverage for an English query: 16–30 sources across 12–21 distinct domains, and
the first 8 slots are 8/8 on-topic foreign documentation. The A/B evidence for
leading CJK queries with AnySearch is in the [README](../README.md#ab-evidence-cjk-queries-need-anysearch-too).

Admission is weighted, scoring is not: with weights 2/1/1 over lists of 10, 10
and 4 results at `limit: 8`, the 8 slots split 4/2/2 between the engines. The
previous rule multiplied every row of an engine by its weight, which let
AnySearch fill all 8 slots and starved the Chinese engines completely (8/0/0).

Block pages seen in practice:

- 360 served its `访问异常页面` with a captcha under rapid unattended requests;
- another domestic engine (Shenma, not part of this registry) served an `x5sec`
  punish page during the same measurements;
- Bing answered repeated rapid requests with a "trending" feed belonging to
  somebody else's search — HTTP 200, so only the echoed-query check catches it.

That evidence is why block pages and echoed-query mismatches cool an engine down
instead of being retried on every search.

## What could not be made to work

- **Google.** A tunnelled `www.google.com/search` returns a JavaScript shell
  (94 KB, 1–3 links); headless Chrome is redirected to `google.com.hk` and gets a
  reCAPTCHA page. `gbv=1`, a consent cookie and a mobile user agent all failed.
- **Public SearXNG instances.** Eight were tried; all answered 429, 403 or
  something that was not JSON.
