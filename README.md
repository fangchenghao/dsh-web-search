# dsh-web-search-bing

**Gives DeepSeek Harness a pair of hands for the web: the model can search, then open a page and read it, without you pasting links.**

- [中文说明](README.zh-CN.md)
- [Changelog](CHANGELOG.md) · [Why a plugin's settings go missing: the four-layer chain](docs/plugin-settings-form.md)

> Version 0.9.1. What follows starts with what this means for you; the technical detail is collected in the last section.

## In one sentence

With this plugin installed, you can ask something like "how do I configure the version released last week?" and the model can call `web_search` against public search engines by itself, then work from a ranked list of titles, links and snippets. When a snippet is not enough, it can call `web_fetch` on one of those links and pull the page text into the conversation.

Two things change for you:

- When a question involves "search for", "latest", "official docs" or "the docs", the model has a real chance to look it up instead of answering "my knowledge has a cutoff date".
- You do not need a search API key, and you do not pay for search separately.

Under the hood it is one sentence too: the plugin registers two providers with the harness's `web` service — `bing` for search and `http-proxy` for fetching pages. Both names come up again below.

## The problem it solves

### A very ordinary situation

You upgraded a library. A config field was renamed. You ask the model:

> "Did `timeout` become `timeoutMs` in v1.2? Check the official docs for me."

**Without this plugin**, the model does one of three things:

1. Answers from the old docs it memorised during training — sometimes right, sometimes confidently wrong;
2. Says it cannot access the internet and suggests you check the docs yourself;
3. Fails outright: the search backend the harness ships with (`deepseek-official`) needs a DeepSeek credential, and without one `web_search` errors out.

**With this plugin**:

1. The model calls `web_search`. The plugin queries several engines at once, drops duplicate URLs, re-ranks what is left by cross-engine agreement, official-documentation status and freshness, and returns roughly eight candidates;
2. It notices that one result is on `kubernetes.io`, calls `web_fetch`, and reads that page;
3. It answers from the page text and can hand you the link.

### Side by side

| Situation | Without it | With it |
| --- | --- | --- |
| A question about something released weeks ago | Memory only; often stale | Searched and read now, with sources |
| You paste a link and say "read this" | A direct request that times out (`github.com`, for example) is the end of it | Direct first, then the local proxy, then AnySearch extraction |
| Where results come from | One backend, depending on credentials | Up to six sources, cross-checked and de-duplicated |
| A question in Chinese | Dictionary and encyclopedia pages creep in | Chinese sources lead, without losing English documentation |
| An engine starts throttling | Every call fails and retries | That engine rests for 5–30 minutes; the others carry on |

### What it does not do

It does not make the model smarter, and it does not make judgements for you. It connects two abilities — looking things up and reading pages. What it finds can still be wrong or out of date, and the model can still misread it. That is no different from searching the web yourself.

## Concepts, in plain language

Every term used later, in a few lines each, with an analogy. No technical background assumed.

### Large language models, and why they "don't know"

A large language model — the kind of program behind ChatGPT or DeepSeek — is trained on an enormous amount of text until it can predict the most likely next word. What it remembers stops at the moment training ended; that moment is called the **knowledge cutoff**.

It is not connected to the internet. Ask about yesterday and it does not "search and fail to find"; it has **no route to that information at all**. Analogy: a scholar who has read the whole library but moved to the mountains three years ago and stopped accepting parcels. Ask about three years ago and you get a solid answer. Ask about last week's news and you get inference dressed as fact.

### Agents, and why they need tools

An agent is an AI that decides what to do next. A plain chatbot answers one question at a time. An agent thinks "should I look this up?", picks a tool, looks at the result, and then decides what to do after that.

A **tool** is a fixed capability handed to the agent: search, read a page, run a command. The model cannot browse on its own, but it can ask the harness to run `web_search` with certain arguments. The harness runs it, puts the result back into the conversation, and the model continues. Analogy: you do not send the chef to the market; you give the chef a phone and let them call the buyer.

### web_search versus web_fetch

This is the pair people mix up most. They solve different problems:

- **`web_search` finds URLs.** Give it keywords; it returns a list with titles, links and a line or two of snippet.
- **`web_fetch` reads a page.** Give it one URL; it brings back that page's content.

| | `web_search` | `web_fetch` |
| --- | --- | --- |
| You give it | A few keywords | One URL (`http://` or `https://`) |
| It gives you | Around eight candidates: title, link, snippet | The page body (HTML or plain text) |
| Can it answer the question | Only from snippets, often not enough | Yes — the text is right there |
| When to use it | You don't know where to look, or want several sources | You know which page to read |
| Which provider | `bing` (this plugin) | `http-proxy` (this plugin) |
| Typical time | 1.4–3.8 s (near-instant on a cache hit) | Depends on the site; up to 5 s direct, then another route |

In everyday terms:

> **Search is the librarian handing you a reading list**: titles, shelf numbers, a one-line summary — thirty seconds and you have it. But a list is not a book, and the summary can be misleading.
>
> **Fetch is taking the book off the shelf and opening it**: you get the whole text, but the book may be checked out (the site refuses), behind a members-only desk (a paywall), or the shelf number may be wrong (a 404).

You need both. Search without fetch leaves the model reading blurbs forever. Fetch without search requires a URL — and the model usually does not have one.

### DeepSeek messages and sessions

The model has no memory of its own. On every request, the harness resends the **whole sequence of messages**: the system prompt, what you said earlier, what the model answered, and the results of tools. That sequence is the messages array; one continuous conversation is stored in a **session**.

A tool round trip looks like this:

1. The model says "call `web_search` with this query" — an assistant message carrying a tool call;
2. The harness actually searches, then appends the result as a **tool result message**;
3. On the next request the model sees the question, its own request, and the search results together, and answers from that.

Analogy: ordering food. You order, the waiter takes the ticket to the kitchen, and the finished dish comes back as a new plate on the table. The model always sees every plate currently on the table, not just the last one. That also explains a common effect: long search results take up room, because they occupy the model's context — the size of the table.

### Providers

The harness has a `web` **service** that does not search by itself. It forwards requests to a **provider** — the thing that actually does the work.

Analogy: the `web` service is the wall socket; a provider is the plug. Swap the plug and the wall and the appliance stay put. This plugin supplies two plugs:

- the search plug, id `bing`, selected by `searchProvider: bing`;
- the fetch plug, id `http-proxy`, selected by `fetchProvider: http-proxy`.

What does swapping it change? Point it back at the shipped `deepseek-official` and `web_search` needs a DeepSeek credential again. Point fetching at another implementation and the timeout and proxy behaviour change with it. The tool name stays the same; the craft behind it changes.

### Plugins and bundles

A plugin is code installed into the harness. A **bundle** is how it ships: an npm package that carries the code plus a `cordis.patch.yml` telling the harness "insert this row of config when you start".

Where does it live? In the dependency set of the **profile** you are running. A profile is one self-contained harness configuration — this machine has `desktop`, `web` and `headless`. The plugin code, plus whatever you write in that profile's `cordis.patch.yml`, decide how it behaves.

Why does a code change need a restart? Because Node.js evaluates a module once per process, and a running harness holds the code it loaded at startup. Analogy: changing a bulb means switching the light off and on again; hot-swapping does not light it. **Saving values on the Settings page does not need a restart** (with one cache caveat below), but editing `src/*.ts` always means rebuild and restart.

### A few more words you will meet

- **Engine**: one specific search source — Bing China, 360, DuckDuckGo. It returns a web page, not a documented API.
- **Scraping and parsing**: downloading that page and pulling titles, links and snippets out of the HTML. When the upstream page changes shape, the extraction can break.
- **Proxy / tunnel**: routing requests through a local program (Clash, for example) before they leave the machine. Some sites only answer that way.
- **Cache**: remembering a result for ten minutes. Ask the same thing again and the plugin answers from the note instead of bothering the engines.
- **Rate limiting and cooldown**: engines dislike bursts of automated requests and answer with a verification page. The plugin lets that engine rest — five minutes by default, up to thirty.
- **RRF ranking**: reciprocal rank fusion, a way of merging several ranked lists by voting. A result near the top of several lists rises; a result only one engine liked has weaker evidence.
- **API key**: a token proving you may use a service. Not needed here by default; the AnySearch key is optional and only raises limits.

## What it can do

Each line is the plain version first, the technical note second. The technical note is safe to skip.

1. **Ask several search engines at once.**
   Four primaries run together (AnySearch, DuckDuckGo HTML, Bing China, 360). If none of them returns anything, Bing International and DuckDuckGo Lite step in. Six sources in total.
   *Technical: `tier: primary` and `tier: fallback` in `HOSTS`; the three `viaProxy` engines (`ddg-html`, `www.bing`, `ddg-lite`) only join when a proxy is detected.*

2. **No API key at all.**
   AnySearch answers anonymously; the domestic engines and DuckDuckGo are scraped from public result pages. No sign-up needed.
   *Technical: AnySearch is `POST https://api.anysearch.com/v1/search` with `max_results` fixed at 10; scraped engines must echo part of the query in the page or the response is rejected as a throttle page.*

3. **Duplicate URLs are collapsed.**
   If three engines return the same page, it appears once, and it ranks higher for it.
   *Technical: de-duplication normalises `www.` and a trailing slash; in the fusion, `votes` counts the distinct engines that returned a URL.*

4. **Ranking looks beyond position — at official status and freshness.**
   Domains such as `kubernetes.io`, `developer.mozilla.org` and `rfc-editor.org` get a boost, as does anything published within 30 days.
   *Technical: `score = votes / (rrfConstant + position)`, then `× (1 + authorityBoost)` and a freshness factor; defaults `rrfConstant: 60`, `authorityBoost: 0.25`, `freshnessBoost: 0.2`, `freshnessDays: 30`.*

5. **Chinese and English are handled separately.**
   English queries lead with global sources, Chinese queries with Chinese sources, so "how to …" is not answered with a dictionary page for the word `how`.
   *Technical: `lead = cn` when the query contains CJK characters, `lead = global` for plain ASCII; the other region only appends when the leading one comes up short.*

6. **You choose speed or completeness.**
   `auto` waits up to 6 s for English and 3.5 s for Chinese; `fast` takes whoever answers first; `all` waits for everyone, up to 10 s.
   *Technical: the three `wait` values with soft deadlines of 6000/3500 ms (`auto`), 3500 ms (`fast`), 10000 ms (`all`); the per-engine hard deadline is `timeoutMs: 15000`.*

7. **Repeating a question does not repeat the work.**
   The same query within ten minutes is answered from the previous run, almost instantly.
   *Technical: TTL + LRU cache, `cacheTtlMs: 600000` (ten minutes) and `cacheEntries: 100`; the key is `lead|wait|limit|sorted engine ids|normalised query`.*

8. **A throttled engine takes a rest.**
   If one engine serves a verification page, it is skipped for a few minutes while the rest keep working.
   *Technical: `baseCooldownMs: 300000`, doubling per consecutive failure up to `maxCooldownMs: 1800000`; the service's own `Retry-After` wins; parse failures and cancellations never cool an engine down.*

9. **It can read the page, not just the snippet.**
   Search returns links; `web_fetch` returns text, and reroutes when a direct request fails.
   *Technical: a three-rung ladder — direct (5 s cap) → local tunnel → AnySearch extraction (needs a key); each page keeps at most 1 MiB (`1048576` bytes), with the rest truncated and flagged.*

10. **It works on a restricted network.**
     With a tunnel running and set as the system proxy, nothing needs configuring. With the tunnel off, it falls back to direct requests instead of failing.
     *Technical: proxy sources in order — the `proxy` setting, then `DSH_WEB_SEARCH_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`, then macOS `scutil --proxy`; HTTP proxies only (`CONNECT`), not `socks5://`.*

11. **Every setting is editable in the UI.**
     Sixteen controls in three groups; a save takes effect on the next search.
     *Technical: all sixteen fields carry `.volatile()`, so the Host commits them in place instead of remounting the plugin.*

12. **Failures are explained, not silently empty.**
     When nothing succeeds, the error lists which engines were tried and why each one failed.
     *Technical: failures are classified `SEARCH_THROTTLED`, `SEARCH_BLOCKED`, `SEARCH_TIMEOUT`, `SEARCH_NETWORK`, `SEARCH_PARSE`, `SEARCH_ABORTED`; they are return values, not exceptions — only caller cancellation throws.*

## Installing and enabling it

### What you need

- A DeepSeek Harness profile with the `web` service;
- Node 22.18 or newer (the source uses Node's native TypeScript type stripping; CI runs Node 24);
- Ordinary outbound network access. A tunnel is not required — you just get fewer engines without one.

### Step 1: build

`main` points at `lib/index.js`, which does not exist until you build:

```sh
cd ~/.dsh/plugins/dsh-web-search-bing
npm run build
```

### Step 2: check the bundle patch

The package ships its own `cordis.patch.yml`, and it is one insert:

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
```

If you installed the package into a profile with `pnpm install` or a `link:`, that row arrives automatically. The copy in this repository also carries an empty `config: {}`; its job is to keep the row discoverable so Settings renders a card instead of "this deployment does not provide settings for this plugin".

If the bundle is not in the profile yet, add it as a dependency of that profile's `package.json` and install:

```json
"dependencies": {
  "dsh-web-search-bing": "link:/Users/dp/.dsh/plugins/dsh-web-search-bing"
}
```

```sh
cd ~/.dsh/profiles/desktop
pnpm install
```

Adjust the path to wherever the checkout lives on your machine. Profiles on this machine use pnpm; use whatever your own setup uses.

### Step 3: select the providers in your profile

Open the `cordis.patch.yml` of the profile you run. On this machine that is:

```
~/.dsh/profiles/desktop/cordis.patch.yml
```

On another machine, replace `desktop` with your profile name (`web`, `headless`, and so on). Add:

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http-proxy
```

Both ids belong to this plugin. If you want the new search backend but not the new fetch ladder, write `fetchProvider: http` — the harness's own direct implementation.

Optionally, add a config row:

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    limit: 8
    wait: auto
    proxy: ""            # empty means auto-detect
    anysearchApiKey: ""  # empty means anonymous access
    anysearchDomain: ""  # or finance / academic / security / legal / code
```

**Where the key goes**: into the profile's `cordis.patch.yml`, never into the repository. The bundle's default config is empty so that publishing it cannot carry your credential along.

### Step 4: restart completely

After changing code or profile config, **quit DSH entirely and open it again** (on macOS, quit from the menu or press `Cmd+Q`; closing the window is not enough). Modules are evaluated once per process, and a running process never sees a file you edited underneath it.

Values saved from the Settings page do not need a restart; see the next section.

### Step 5: confirm it works

Any one of these:

1. **Look at Settings**: Settings → "Web search (Bing)" should show three groups of controls. That means the plugin loaded and the Host accepted its schema.
2. **Look at the log**: no warning such as `1 entry did not activate`.
3. **Just try it**: ask something that obviously needs the network, such as "search for a DSH plugin tutorial and give me the links". Watch whether `web_search` is called and whether the links are real.

If the Settings card appears but search still fails, start with [docs/troubleshooting.md](docs/troubleshooting.md).

## Using the Settings page

Open Settings → "Web search (Bing)". Sixteen controls, arranged in three groups. Each group owns one kind of decision:

| Group | Controls | What it decides |
| --- | --- | --- |
| Engines and transport | 6 | Which engines run, how long to wait, whether to use a proxy, AnySearch credentials and vertical domain |
| Results and ranking | 6 | How many results, how they merge and sort, how much official docs and fresh content count |
| Cache and cooldowns | 4 | How long results are remembered, how many, and how long a throttled engine rests |

### Engines and transport (6)

| Control | Key | Default | Plain meaning |
| --- | --- | --- | --- |
| Engine allow-list | `hosts` | empty (all) | Only these engines may run; comma-separated, e.g. `anysearch, cn.bing` |
| Wait policy | `wait` | `auto` | `auto` follows the query language; `all` waits for everyone; `fast` takes the first answer |
| Timeout (ms) | `timeoutMs` | `15000` | Per-engine deadline, at least 500 |
| Proxy URL | `proxy` | empty (detect) | e.g. `http://127.0.0.1:7890`; empty reads the environment, then the system proxy |
| AnySearch API key | `anysearchApiKey` | empty (anonymous) | Optional. Sent only to `api.anysearch.com`; raises limits and unlocks page extraction |
| AnySearch domain | `anysearchDomain` | empty (general) | `finance` / `academic` / `security` / `legal` / `code`; a dotted value such as `finance.us_stock` selects a sub-domain |

> If the last two controls show a raw key such as `field.anysearchApiKey` as their title, this version is missing two translation lines. The controls still work.

### Results and ranking (6)

| Control | Key | Default | Plain meaning |
| --- | --- | --- | --- |
| Result budget | `limit` | `8` | How many results at most, 1–20; a smaller caller budget still wins |
| RRF constant | `rrfConstant` | `60` | Larger flattens the curve; smaller favours each engine's own top results |
| Authority domains | `authorityDomains` | empty (built-in list) | Extra domains to boost, on top of the built-in official-docs list |
| Authority boost | `authorityBoost` | `0.25` | Multiplies an authoritative result by `1 + this`, 0–10 |
| Freshness boost | `freshnessBoost` | `0.2` | Boost for newly published content, 0–10, fading linearly to zero |
| Freshness window (days) | `freshnessDays` | `30` | Age beyond which the freshness boost is gone |

### Cache and cooldowns (4)

| Control | Key | Default | Plain meaning |
| --- | --- | --- | --- |
| Cache TTL (ms) | `cacheTtlMs` | `600000` | Ten minutes; `0` disables the cache |
| Cache entries | `cacheEntries` | `100` | How many queries to remember; the least recently used goes first |
| Base cooldown (ms) | `baseCooldownMs` | `300000` | First rest after throttling, five minutes |
| Max cooldown (ms) | `maxCooldownMs` | `1800000` | Ceiling for the doubling backoff, thirty minutes |

### My advice

**For normal use: leave all sixteen alone. The defaults are the tuned values.**

Only two situations are worth changing:

- **Your proxy is not detected**: put the local proxy address in `proxy`, for example `http://127.0.0.1:7890`. HTTP proxies only — swap `socks5://` for the client's HTTP/mixed port.
- **You want AnySearch's higher limits or page extraction**: fill in `anysearchApiKey`, and add `anysearchDomain` if you want one vertical index.

Two things to keep in mind:

- A save is immediate and applies to the next search, no restart.
- **Ranking changes can be hidden by the cache**: the cache key holds `lead|wait|limit|engine set|query`, not the ranking knobs. Ask the same question within ten minutes and you get the old order. Rephrase it, or wait ten minutes.

## FAQ

### Do I need an API key?

No. Search runs entirely over public routes: AnySearch anonymously, Bing and 360 by scraping result pages, DuckDuckGo by scraping HTML. `anysearchApiKey` is optional; with a key you get higher limits, and `web_fetch` gains a third rung — server-side extraction — when both direct and tunnel fail.

### Will it cost me money?

The plugin is MIT-licensed and free. It calls no paid search API and contains no purchase flow. Two things involve money, and neither is charged by the plugin:

- An AnySearch key you add yourself is metered and billed under AnySearch's terms, on your account;
- The network traffic is yours.

### Does it send my searches to anyone?

Yes — to the engines taking part in that search, which is what searching means. Concretely: `api.anysearch.com`, `cn.bing.com`, `www.so.com`, plus DuckDuckGo and Bing International when a proxy is in play. With a key configured, a page that fails to fetch may be sent to `api.anysearch.com`'s extraction endpoint. The plugin has no server of its own and contains no usage-reporting code.

### Why can't it fetch a particular site?

Four usual causes:

1. **The site refuses automated access**: a 403 or a verification page. If direct and tunnel both fail, only an AnySearch key enables server-side extraction.
2. **The content is rendered by JavaScript**: what comes back is an empty shell.
3. **It needs a login or a subscription**: fetching carries no session of yours.
4. **Direct requests time out**: 5 seconds direct, then the tunnel; if neither works and no key is configured you get an error, and with a key there is one more rung, server-side extraction. The message names each rung's failure.

### Why do the results differ from what I get searching by hand?

Because it is not the same operation:

- It scrapes **result pages from several engines**, not one engine's official API, and their orderings already disagree;
- It de-duplicates by URL, then re-ranks by cross-engine votes, official-docs status and freshness;
- It leads with sources in the query's language, so a Chinese question looks at Chinese sites first;
- It may serve a ten-minute-old cache, and an engine may be sitting out a cooldown;
- It knows nothing about your account, location or browsing history, so there is no personalisation.

### I changed a setting, why did nothing happen?

Three cases:

- **Changed on the Settings page**: saved immediately and read on the next search. But if you ask the same question again within ten minutes you may hit the cache and see no difference — try rephrasing.
- **Changed the profile's `cordis.patch.yml`**: requires a full restart of the harness.
- **Changed `src/*.ts`**: requires `npm run build` and then a restart. Source edits without a build still run the old code in `lib/`.

### Will it slow the model down?

A little, and it is usually worth it:

- A measured search takes 1.4–3.8 s (English waits a bit longer, Chinese is faster); a cache hit is nearly instant.
- The model is waiting for a tool result during that time, not hanging; if the deadline arrives, it gets whatever has already come in.
- The real cost is context: search results and page text both consume the model's input, so longer pages make the turn more expensive and leave less room for everything else. That is why search returns eight results by default and a page is capped at 1 MiB.

### Why does the model sometimes not search at all?

Whether to search is the model's decision; the plugin only does its job when called. It may believe it knows the answer, judge that the question needs no network, or already have enough from an earlier turn. You can say "search first, then answer" — that usually triggers it.

## Technical notes (appendix)

For people changing code or debugging. Skippable for normal use.

### The pipeline of one search

```
web_search call
  → read config (re-read per call, so Settings edits apply immediately)
  → resolve the proxy (config → environment → system proxy)
  → filter by the hosts allow-list; drop viaProxy engines when no proxy exists
  → skip engines in cooldown (but never end up with none)
  → decide the leading region from the query script (ASCII → global, CJK → cn)
  → look up the cache (key: lead|wait|limit|sorted engine ids|normalised query)
  → run the primary tier concurrently, release on the first satisfied condition
  → if nothing came back, run the fallback tier
  → fuse per region, rank with RRF, slice to limit
  → store in the cache, return { sources, failures, proxy }
```

A tier releases on whichever comes first: every engine settled; every engine of the leading region settled (success or failure); enough sources from enough contributors; the soft deadline. Engines still running are aborted and reported as `still running at deadline` or `aborted once enough results had arrived`.

One engine's failure is classified into a `SearchError` and returned, not thrown — a dead engine must not take the whole search with it.

### The ranking formula

```
score(source) = votes / (rrfConstant + position)
                × (authoritative domain ? 1 + authorityBoost : 1)
                × freshness factor
```

- `position`: the 1-based slot the source gets after the per-engine lists are walked in a weighted round robin. A weight-2 engine takes two consecutive slots per round (AnySearch is 2, the rest are 1).
- `votes`: the number of **distinct engines** that returned the source. Two engines agreeing doubles the score; one engine's weight never does.
- Weight shapes admission, not score. This was a measured correction: an earlier version multiplied the score by weight, and at `rrfConstant = 60` a weight of 2 beat every other engine at every rank — a CJK query returned eight AnySearch results and nothing Chinese. Today, weights 2/1/1 over lists of 10/10/4 at `limit: 8` split the slots 4/2/2.
- Freshness factor: `1 + freshnessBoost × (1 − ageDays / freshnessDays)`, and exactly 1 outside the window. An unparsable date also counts as 1 — it is not penalised.
- Ties break on engine order → rank within that engine → URL string, so identical input always produces an identical order.

**The current gap**: no engine emits `publishedAt` (result pages expose no stable date field), so the freshness boost is effectively idle. It will start working once an engine can supply a date.

### Cache and cooldowns

**The cache** is TTL + LRU. Entries expire after `cacheTtlMs` (default `600000`, ten minutes); beyond `cacheEntries` (default `100`) the least recently used entry is evicted; `cacheTtlMs: 0` disables it. Arrays and every object are copied in and out, so a caller cannot mutate the cache. The key's engine set is the one the run *would* use, **before** the cooldown filter, so an engine entering or leaving a cooldown cannot invalidate a fresh entry.

**Cooldowns** exist because scraping public result pages is not a supported interface. `SEARCH_THROTTLED` (429), `SEARCH_BLOCKED` (403, other 4xx, a failed echoed-query check), `SEARCH_TIMEOUT` and `SEARCH_NETWORK` put an engine to rest. `SEARCH_PARSE` (upstream markup drift — retrying cannot help) and `SEARCH_ABORTED` (the caller cancelled) never do. The duration prefers the service's own `Retry-After` (delta seconds or an HTTP date, read from the final redirect hop); otherwise `baseCooldownMs × 2^(consecutive failures − 1)`, capped at `maxCooldownMs`. One success clears the streak. If every engine is cooling, the run still uses them, so the engine set is never empty.

### The three-rung web_fetch ladder

The `http-proxy` fetch provider tries three routes in order, each only after the previous one failed:

| Rung | What it does | Deadline | When it helps |
| --- | --- | --- | --- |
| 1. Direct | Requests the target URL itself | 5 s at most (`DIRECT_DEADLINE_MS = 5000`) | Fastest on an open network, and costs no tunnel round trip |
| 2. Local tunnel | Requests through an HTTP `CONNECT` proxy | `timeoutMs`, default 15 s | Hosts like `github.com` and `html.duckduckgo.com` that time out directly |
| 3. AnySearch extraction | `POST https://api.anysearch.com/v1/extract`; content rendered server-side | Same, default 15 s | Needs a key. Rescues a page that answers 403 to a bare request |

The direct deadline is deliberately shorter than the tunnel's: a blocked host usually fails by timing out, and spending the whole budget on a route that cannot work leaves the route that can with nothing.

Other details: only `http(s)` URLs are accepted; each page keeps at most `1 MiB` (`1048576` bytes), the rest truncated and flagged `truncated`; a non-2xx response is a **result**, not a failure, and comes back with its status code and body; only when all three rungs fail does the provider throw, and the message names each rung's reason.

### Proxy

Node's global `fetch` reads neither the macOS system proxy nor `HTTPS_PROXY` — unless the process started with `NODE_USE_ENV_PROXY=1`, which cannot be switched on from inside a running process. So when a proxy is needed, the plugin speaks to it directly: send `CONNECT`, upgrade with TLS for `https:` targets, write the request by hand, and decode `Content-Length`, chunked, gzip, deflate and brotli, following up to four redirects. `307`/`308` keep the method and body; any other `3xx` downgrades a `POST` to a bodyless `GET`.

Resolution order: the `proxy` setting → the environment (`DSH_WEB_SEARCH_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `HTTP_PROXY`, either casing) → macOS `scutil --proxy`, adopted only if a 400 ms TCP probe connects, and cached for 60 seconds. HTTP proxies only; replace `socks5://` with the client's HTTP/mixed port. Proxying is scoped to this plugin — the rest of the app keeps its ordinary network path.

### Known limitations

- **Relevance is capped by upstream result pages** and is below a commercial search API. Key-free scraping gets throttled in return: measured, 360 served `访问异常页面` with a captcha and another domestic engine a `x5sec` punish page. Cooldowns and multiple engines cover for it, not all of it.
- **Google is unreachable from this network.** A tunnelled `www.google.com/search` returns a JavaScript shell (94 KB, 1–3 links); headless Chrome is redirected to `google.com.hk` with a reCAPTCHA. `gbv=1`, a consent cookie and a mobile user agent all failed. Eight public SearXNG instances were unusable too (429/403/not JSON).
- **It depends on upstream HTML structure.** A redesign breaks a parser; that engine records a reason and yields to the next one rather than silently returning nothing.
- **Titles, links and snippets only** — no page text. That is `web_fetch`'s job.
- **No publication date is produced today**, so the freshness boost sits idle.
- **Anonymous AnySearch caps at 10 results per call.**
- **HTTP proxies only** — no `socks5://`.
- **`limit` is capped at 20.**

### Defaults at a glance

| Item | Value |
| --- | --- |
| Result budget `limit` | `8` (1–20) |
| Cache TTL `cacheTtlMs` | `600000` ms = 600 s |
| Cache entries `cacheEntries` | `100` |
| Per-engine timeout `timeoutMs` | `15000` ms |
| `web_fetch` direct deadline | `5000` ms |
| Bytes kept per page | `1048576` (1 MiB) |
| RRF constant `rrfConstant` | `60` |
| Base cooldown `baseCooldownMs` | `300000` ms = 5 min |
| Max cooldown `maxCooldownMs` | `1800000` ms = 30 min |

### Development and tests

```sh
node --test test/*.test.ts     # the whole suite
node --test test/proxy.test.ts # one file
npm run typecheck              # tsc --noEmit
npm run build                  # compile src/ to lib/
npm run check                  # typecheck + tests
```

The suite runs offline: parser tests replay captured fixtures from `test/fixtures/`, transport tests open no sockets, and proxy tests cover `parseProxy`, `proxyFromEnv` and the pure response framer.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build` on Node 24 for Ubuntu and macOS, then checks that the build emitted `lib/index.js` and `lib/index.d.ts` and that both `apply` and `Config` import.

After editing `src/*.ts`, build and restart — otherwise you are still running the old code in `lib/`.

## Related documents

- [docs/plugin-settings-form.md](docs/plugin-settings-form.md): the four conditions a plugin config must satisfy to appear in Settings, plus one real debugging session end to end.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version, with the measurements behind it.
- [docs/architecture.md](docs/architecture.md): the module map and the data flow from the `web` service to a source list.
- [docs/engines.md](docs/engines.md): each engine's request shape, parser quirks and measured results.
- [docs/troubleshooting.md](docs/troubleshooting.md): no results, proxy not detected, provider not selected, cooldown stuck.
- [README.zh-CN.md](README.zh-CN.md): the Chinese guide, section for section.

MIT © 2026 fangchenghao. See [LICENSE](LICENSE).
