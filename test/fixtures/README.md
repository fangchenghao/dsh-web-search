# Parser fixtures

Captured on **2026-10-22** (Asia/Shanghai) from the endpoints used by
`src/parsers.ts`. Every parser must degrade to `[]` rather than throw, so these
files are the regression net for markup that used to be parsed by hand.

Live captures were made with the tunnel in front of the request and the same
user agent the plugin sends:

```sh
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
HTTPS_PROXY=http://127.0.0.1:7890 curl -sS --max-time 30 -A "$UA" '<url>' -o test/fixtures/<name>
```

Domestic endpoints were fetched directly; AnySearch is a JSON API and needs no
tunnel.

| File | Kind | Query | Size |
| --- | --- | --- | --- |
| `ddg-html.html` | live | `postgres logical replication` | 31 876 B |
| `ddg-lite.html` | live | `postgres logical replication` | 24 645 B |
| `bing-global.html` | live | `postgres logical replication` | 121 415 B |
| `so.html` | live, trimmed | `如何配置 postgres 逻辑复制` | 395 259 B |
| `anysearch.json` | live | `postgres logical replication` (`max_results: 10`) | 4 884 B |
| `anysearch-error.json` | live | empty query (HTTP 400) | 94 B |
| `ddg-uddg-synthetic.html` | synthetic | — | 2 277 B |
| `bing-ratelimit-synthetic.html` | synthetic | — | 882 B |

## Exact sources

- `ddg-html.html` — `https://html.duckduckgo.com/html/?q=postgres+logical+replication`
- `ddg-lite.html` — `https://lite.duckduckgo.com/lite/?q=postgres+logical+replication`
- `bing-global.html` — `https://www.bing.com/search?q=postgres+logical+replication&setmkt=en-US&setlang=en&cc=US`
- `so.html` — `https://www.so.com/s?q=%E5%A6%82%E4%BD%95%E9%85%8D%E7%BD%AE+postgres+%E9%80%BB%E8%BE%91%E5%A4%8D%E5%88%B6`
  (trimmed to 395 259 B at a `</li>` boundary; the first four `res-list`
  results are intact, the trailing page furniture is not part of the test)
- `anysearch.json` — `POST https://api.anysearch.com/v1/search` with
  `{"query":"postgres logical replication","max_results":10}` and
  `content-type: application/json`
- `anysearch-error.json` — same POST with `{"query":""}`, which the service
  answers with HTTP 400 and `{"code":-1,"message":"Query is required."}`

## Synthetic fixtures (no live capture available)

- **`ddg-uddg-synthetic.html`** — DuckDuckGo used to wrap every outbound link as
  `/l/?uddg=<percent-encoded>`. Both live captures above now serve direct
  `href`s, so this excerpt reproduces the wrapper shape described in
  `engines.js` (including an encoded `&` inside the target query string).
  Regression test: "DuckDuckGo /l/?uddg=<urlencoded> unwraps to the target".
- **`bing-ratelimit-synthetic.html`** — Bing's rate-limited reply is a
  "trending" feed for someone else's search. No block page could be provoked on
  demand through the tunnel, so this file reproduces that shape (a jigsaw/sudoku
  feed tagged HTTP 429 and captcha text). Regression test: "echoesQuery rejects
  a rate-limit/captcha payload for a different query".

Do not hand-edit the live files: their value is that the parser saw exactly what
the service sent, including truncated attributes, odd quoting and tracker
wrappers.
