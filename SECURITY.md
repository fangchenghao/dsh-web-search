# Security and permissions

This page states what the plugin can reach, what it runs, what it writes, and
where it fails. It is written for a reviewer deciding whether to install it, and
for anyone auditing the fixed commit that DSH STORE scans.

## Dependencies

| dependency | why | note |
|---|---|---|
| `@deepseek-ai/schemastery` | defines the 26 configuration fields and validates them | the same schema library the Harness itself uses; no transitive dependencies of its own |

There are no other runtime or optional runtime dependencies. Playwright is
**not** a dependency: rendering turns on only when the user has already installed
`playwright` or `playwright-core` in the profile, and the plugin never installs,
downloads, or upgrades anything at runtime.

There are no lifecycle scripts (`preinstall`, `install`, `postinstall`,
`prepare`). `npm run build` is the only build step and runs `tsc` locally;
`prepublishOnly` runs that build before publishing.

## Network

Outbound TCP/HTTPS only, plus one local system query described below.

| host | purpose |
|---|---|
| `cn.bing.com`, `www.bing.com` | key-free HTML search |
| `html.duckduckgo.com` | key-free HTML search |
| `www.so.com` | key-free HTML search, fallback tier, usually bot-walled |
| `mcp.exa.ai` | key-free semantic search (anonymous MCP endpoint), primary tier |
| `api.firecrawl.dev` | key-free search API, fallback tier |
| `api.github.com`, `registry.npmjs.org`, `pypi.org`, `export.arxiv.org`, `*.wikipedia.org`, `hn.algolia.com`, `api.stackexchange.com`, `crates.io` | the eight default `domain_search` sources |
| `gitlab.com`, `codeberg.org`, `hub.docker.com`, `search.maven.org`, `azuresearch-usnc.nuget.org`, `rubygems.org`, `packagist.org`, `pub.dev`, `huggingface.co`, `open-vsx.org`, `registry.terraform.io`, `api.wordpress.org`, `plugins.jetbrains.com`, `api.openalex.org`, `api.crossref.org`, `www.ebi.ac.uk`, `rest.uniprot.org`, `clinicaltrials.gov`, `services.nvd.nist.gov`, `api.coingecko.com`, `archive.org`, `www.wikidata.org`, `nominatim.openstreetmap.org` | the 26 opt-in `domain_search` sources; contacted only when named in `sources` or `domainSources` |
| `api.anysearch.com` | optional: search and page extraction, **only when an AnySearch key is configured** |
| your configured proxy | HTTP `CONNECT` tunnel for the hosts above |

`web_fetch` and `read_page` reach **any** HTTP(S) URL the model asks for; that is
their purpose. With `useProxy` enabled they speak to the configured proxy
(default `127.0.0.1:7890`, auto-detected) using HTTP `CONNECT`; a 400 ms TCP
connect first checks that the proxy port is listening so a stale setting cannot
stall a search. The plugin never contacts an analytics, telemetry, or update
endpoint.

What leaves the machine: the query text goes to each enabled search engine; a
URL goes to AnySearch extraction only when a key is configured and the earlier
rungs failed. Nothing else is transmitted.

## Processes

The plugin spawns exactly one helper process:

- `/usr/sbin/scutil --proxy` — macOS only, when `useProxy` is on, no explicit
  proxy is configured, and the system proxy has to be discovered. The argv is
  fixed (no shell, no interpolation, no model- or user-controlled arguments),
  stdout is parsed locally with fixed regexes, stderr is discarded, and the
  probe is capped at 2 s before the child is killed. It reads nothing but the
  system proxy settings.

The optional renderer is a **library**, not a command: when the user installed
`playwright` or `playwright-core` and enabled `renderJs`, the plugin imports it
dynamically and calls `chromium.launch({ headless: true })`, which starts a
headless browser process. That browser is the only third-party code the plugin
executes, and only under those two user choices. No shell command is ever
constructed from fetched content or model output.

## Credentials

The only credential is an optional AnySearch key. It lives where you put it —
the profile's `cordis.patch.yml` — is read at mount time, is sent only to
`api.anysearch.com` as a `Bearer` token, and is never logged; failure messages
redact it. The plugin does not read the keychain, environment tokens, or session
credentials, and it writes no credential anywhere.

## Files

| path | what | bounds |
|---|---|---|
| `$DSH_HOME/cache/dsh-web-search/cache.json` | search result snapshot so a restart does not lose the cache | 4 MiB, versioned, atomic replace, pruned by TTL and entry count |
| nothing else | settings live in the profile patch; there is no plugin-owned config file | — |

The cache holds queries and result rows only — no page bodies, no headers, no
cookies.

## Failure bounds

| operation | bound |
|---|---|
| one search engine request | 15 s deadline (configurable), soft deadline per `wait` policy |
| all engines | run concurrently; `fast`/`auto`/`all` decide how long to wait |
| one fetch | 25 s for the whole ladder (direct 5 s, tunnel, render, extraction share it) |
| response body | 2 MiB read cap before decoding, 20 000 characters returned by default |
| `read_page` | 2 000 000 characters per page, 8-page LRU, chunked reads |
| cache | TTL and entry count are bounded and both configurable, `0` disables |
| system proxy probe | 2 s, then the child is killed |

Failures are reported as structured codes (`SEARCH_THROTTLED`, `SEARCH_BLOCKED`,
`SEARCH_TIMEOUT`, `SEARCH_NETWORK`, `SEARCH_PARSE`, `SEARCH_EMPTY`,
`SEARCH_UNSUPPORTED`, `SEARCH_INVALID`, `SEARCH_ABORTED`) instead of silently
returning empty results. A binary document is refused by content type rather
than returned as noise; an empty 200 response is an error, not a success.

## What this plugin deliberately does not do

- No telemetry, no analytics, no update check, no remote configuration.
- No reading of the user's files, browser profile, cookies, or session logs.
- No modification of the Harness, its shipped plugins, or other plugins' entries.
  It registers one search provider, one fetch provider, and three tools
  (`read_page`, `search_many`, `domain_search`) through public seams.
- No hidden network destinations: the table above is exhaustive.

## Reporting

Open an issue at <https://github.com/fangchenghao/dsh-web-search/issues> for a
security question. There is no bounty programme.
