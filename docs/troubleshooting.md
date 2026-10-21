# Troubleshooting

Symptom first, cause second, fix third. Every command below is meant to be run
from the repository root.

- [Architecture](architecture.md)
- [Engines](engines.md)
- [README](../README.md) · [中文说明](../README.zh-CN.md)

## `web_search` fails with "no search engine returned results"

That message is the provider's own, and the interesting part is in the
parentheses: one `id: reason` entry per engine that was tried. Read it before
changing anything.

```
no search engine returned results for "…" (anysearch: HTTP 429; cn.bing: page does not match the query (possibly rate limited); …)
```

| Reason in the list | Meaning | What to do |
| --- | --- | --- |
| `no results` | the engine answered 2xx and parsed to zero sources | markup may have changed; check that engine's parser against a fresh capture |
| `page does not match the query (possibly rate limited)` | the echoed-query check failed: a block/trending page for someone else's query | let the cooldown pass, or search a different query |
| `HTTP 403` / `HTTP 429` | the engine decided this client is a robot or is throttling it | cooldown applies; slow down |
| `still running at deadline` | the soft deadline released the tier first | `wait: all`, a larger `timeoutMs`, or accept it |
| `aborted once enough results had arrived` | the tier had enough and stopped waiting | not an error |
| an `ECONNRESET`/`ENOTFOUND` style message | transport failure | check the tunnel, see below |

If *every* reason mentions the tunnel or a timeout, and the `global` engines are
missing from the list entirely, the run had no proxy: `viaProxy` engines
(`ddg-html`, `www.bing`, `ddg-lite`) are filtered out rather than failing slowly.
See [proxy not detected](#proxy-is-not-detected).

To narrow a failure down, restrict the run to one engine and watch the reason
change:

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    hosts: [anysearch]
```

## The provider is not selected

`web_search` still behaves like the built-in provider → `web.searchProvider` is
not `bing`. The provider id is fixed (`PROVIDER_ID = 'bing'`) and `available()`
returns `true` unconditionally, so selection is purely configuration — there is
no credential or health gate to blame.

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http
```

Check that the plugin is actually mounted and registers itself. This snippet
loads the built entry, calls `apply` with a stub context and prints the provider
id — no network access:

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE -e "
import('file://$HOME/.dsh/plugins/dsh-web-search-bing/lib/index.js').then((m) => {
  let p; m.apply({ web: { registerSearchProvider: (x) => { p = x } } }, m.Config({}));
  console.log(p.id, p.available());
});"
```

Expected output: `bing true`. If the import fails with `ERR_MODULE_NOT_FOUND`,
`lib/` has not been built — see [below](#lib-is-missing).

## `lib/` is missing

`package.json` points `main` and `types` at `lib/`, which a fresh checkout does
not contain. Build it:

```sh
npm run build
```

`lib/` is gitignored; rebuilding is part of using a checkout, and `prepublishOnly`
runs the same build for a published package.

## Code changes have no effect

Two separate reasons, usually both:

1. ESM modules are evaluated once per process, so a running DSH keeps the code it
   loaded. Restart the host.
2. The host loads `lib/`, not `src/`. Rebuild before restarting.

```sh
npm run build
```

## Proxy is not detected

Resolution order is: explicit `proxy` config → environment → macOS system proxy
→ direct. The decision is cached for 60 seconds, so a change can take up to a
minute (or a restart) to be honoured.

1. Is a proxy configured at all?

   ```sh
   env | grep -i proxy
   ```

   `DSH_WEB_SEARCH_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `HTTP_PROXY` are read
   in both casings. A value counts only if it parses as an **`http://`** proxy;
   `socks5://` and `https://` values are skipped (the tunnel is a plain
   `CONNECT`, so an `https://` proxy would be dialled in cleartext).
   `socks5://` users must point at the client's HTTP/mixed port instead.

2. Is the macOS system proxy set, and is that port actually listening?

   ```sh
   scutil --proxy
   nc -z -G 1 127.0.0.1 7890 && echo reachable || echo refused
   ```

   The system proxy is only adopted when the port accepts a TCP connection,
   within 400 ms. A stale `HTTPSEnable : 1` with nothing listening is ignored on
   purpose, so the search degrades to a direct request instead of stalling.

3. Is `NO_PROXY` in the way?

   A loopback-only list (`localhost,127.0.0.1`, a common shell default) is
   skipped: it cannot cover a public search host and must not be read as "no
   proxy". A wildcard (`NO_PROXY=*`) is honoured and disables proxying.

4. Fix it explicitly instead of relying on detection:

   ```yaml
   - id: web-search-bing
     name: dsh-web-search-bing
     config:
       proxy: "http://127.0.0.1:7890"
   ```

Under TUN/enhanced mode the kernel takes over TCP transparently; this module is
not involved and the behaviour matches a direct request, so a working TUN setup
needs no proxy configuration at all.

## An engine is always skipped with "cooling down"

The failure list says both how long and why:
`cooling down for another 2m 10s after SEARCH_THROTTLED`. Durations are
`Retry-After` when the service sent one, otherwise `baseCooldownMs` doubled per
consecutive failure, capped at `maxCooldownMs` (5 min → 30 min by default).

- `SEARCH_THROTTLED`, `SEARCH_BLOCKED`, `SEARCH_TIMEOUT`, `SEARCH_NETWORK` cool
  the engine down.
- `SEARCH_PARSE` and `SEARCH_ABORTED` never do: markup drift and caller
  cancellation cannot be fixed by waiting.

Check what the service actually said (a 429 with `Retry-After` explains a long
rest):

```sh
curl -sSI --max-time 10 'https://www.so.com/s?q=test' | head -20
```

A cooldown never empties the engine set: if every engine is resting, the run
uses them anyway. To clear the state early, restart the host — the cache and the
health tracker are per mount, so a restart starts from a clean slate.

## Results do not change after editing the config

The result cache answers identical logical requests for `cacheTtlMs` (default
10 minutes). The key includes the lead region, the `wait` policy, the budget, the
participating engine ids and the normalised query, so most config changes do
produce a new key — but a query repeat within the TTL is served from memory. Set
`cacheTtlMs: 0` while experimenting.

## Results have no `publishedAt`

Not a bug. No engine currently supplies a date: the scraped pages do not expose
one in a stable field, and AnySearch's rows carry `title`, `url`, `snippet` and
`content` but no date. Sources therefore omit `publishedAt`, and the freshness
boost in the ranker stays inactive until an engine starts providing it.

## Google never shows up

Expected, and not configurable. Google is unreachable from this network: a
tunnelled `www.google.com/search` returns a JavaScript shell (94 KB, 1–3 links),
and headless Chrome is redirected to `google.com.hk` with a reCAPTCHA page.
`gbv=1`, a consent cookie and a mobile user agent were all tried. See
[engines.md](engines.md#what-could-not-be-made-to-work).

## Typecheck fails after an edit

Node strips types instead of transforming them, so the source must remain
erasable:

- no `enum`, no `namespace`, no constructor parameter properties;
- relative imports carry the `.ts` extension (`from './types.ts'`);
- type-only imports use `import type`.

```sh
npm run typecheck   # tsc --noEmit over src/**/*.ts
npm run check       # typecheck + the whole test suite
```
