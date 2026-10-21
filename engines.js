/**
 * Key-free search engines.
 *
 * No provider API key is involved: each engine fetches a public result page and
 * parses it. Engines are split into tiers so a blocked or slow engine can never
 * delay a search that another engine already answered:
 *
 * - `primary` engines run concurrently and their results are interleaved;
 * - `fallback` engines run only when every primary returned nothing;
 * - `proxyOnly` engines are reachable only through a tunnel, so they take part
 *   solely when a proxy is active rather than failing slowly on every search.
 *
 * Failures are returned as values, never thrown, so one dead engine degrades
 * into the next instead of failing the search.
 */
import { proxyGet, resolveProxy } from './proxy.js';

/**
 * Query URL plus parser for one engine.
 *
 * `region` decides the order of the merged list for a given query language:
 * `global` engines lead an ASCII query, `cn` engines lead a CJK one.
 */
export const HOSTS = [
  {
    id: 'anysearch',
    tier: 'primary',
    // Serves both languages: it answers Chinese queries with the original
    // Chinese documentation and book translations rather than SEO farms, so it
    // leads a CJK query as well as an ASCII one.
    region: 'both',
    // A JSON API rather than a result page: it takes a POST body, answers with
    // its own envelope, and is reachable directly (no tunnel needed). Its
    // precision is the highest of the engines here, so it takes the most slots.
    weight: 2,
    method: 'POST',
    skipEcho: true,
    build: () => 'https://api.anysearch.com/v1/search',
    body: (q) => JSON.stringify({ query: q, max_results: ANYSEARCH_MAX_RESULTS }),
    parse: parseAnySearch,
  },
  {
    id: 'ddg-html',
    tier: 'primary',
    region: 'global',
    viaProxy: true,
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: parseDdgHtml,
  },
  {
    id: 'www.bing',
    // Demoted to a fallback: measured on stopword-heavy English queries it
    // matched a single token and answered with unrelated pages ("how to set up
    // postgres logical replication" returned jigsaw-puzzle sites for "set"),
    // while the two engines above stayed on topic. It is worth reaching only
    // when nothing else answered.
    tier: 'fallback',
    region: 'global',
    viaProxy: true,
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setmkt=en-US&setlang=en&cc=US`,
    parse: parseBing,
  },
  {
    id: 'cn.bing',
    tier: 'primary',
    region: 'cn',
    build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`,
    parse: parseBing,
  },
  {
    id: 'so',
    tier: 'primary',
    region: 'cn',
    build: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
    parse: parseSo,
  },
  {
    id: 'ddg-lite',
    tier: 'fallback',
    region: 'global',
    viaProxy: true,
    build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: parseDdgLite,
  },
];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * Engines that just answered with a block page, and the time they may be tried
 * again. Scraping a public result page is not a supported interface, so an
 * engine that decided this client is a robot stays that way for a while; giving
 * it a rest keeps the failure list short instead of re-triggering it on every
 * search. A cooldown never empties the engine set entirely.
 */
const cooling = new Map();
const COOLDOWN_MS = 5 * 60_000;
const BLOCK_PAGE = /does not match the query|HTTP (?:403|429)\b|访问异常|punish|captcha/i;

/**
 * How many rows to ask AnySearch for. The merge picks from these, and the
 * caller slices to its own budget, so asking for more than one page needs is
 * what gives the interleave something to choose from.
 */
const ANYSEARCH_MAX_RESULTS = 20;

/** Named HTML entities that actually show up in result markup. */
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  laquo: '«',
  raquo: '»',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  frac12: '½',
  sup2: '²',
  sup3: '³',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  permil: '‰',
};

/**
 * Decode the HTML entities and strip tags from one fragment of result markup.
 * Highlight tags (`<em>`) are dropped, keeping only visible text.
 * @param value - raw markup.
 * @returns plain single-line text.
 */
export function text(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      const numeric = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN;
      if (Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff) return String.fromCodePoint(numeric);
      // An unrecognized named entity is spacing or decoration, never content:
      // drop it rather than leaking the raw "&name;" into a snippet.
      return /^[a-z][a-z0-9]*$/.test(key) ? ' ' : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an anchor target to an absolute http(s) URL, undoing the Bing
 * click-tracker wrapper (`/ck/a?...&u=a1<base64url>`) when present.
 * @param href - the raw `href` attribute.
 * @param base - the page the anchor came from.
 * @returns the absolute URL, or `undefined` when there is none.
 */
export function resolveHref(href, base) {
  if (typeof href !== 'string' || href.length === 0) return undefined;
  // Attribute values are HTML-escaped, so a Bing click tracker arrives as
  // `...&amp;u=a1<base64url>`; decode before looking for the payload.
  let candidate = href.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&');
  const wrapped = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(candidate);
  if (wrapped) {
    try {
      candidate = Buffer.from(wrapped[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  } else {
    // DuckDuckGo wraps outbound links as `/l/?uddg=<percent-encoded>`.
    const uddg = /[?&]uddg=([^&]+)/.exec(candidate);
    if (uddg) {
      try {
        candidate = decodeURIComponent(uddg[1]);
      } catch {
        return undefined;
      }
    }
  }
  try {
    const url = new URL(candidate, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Parse a 360 (so.com) results page. Real URLs live in `data-mdurl`. */
function parseSo(html, base) {
  const sources = [];
  for (const chunk of html.split(/class="res-list"/).slice(1)) {
    const item = chunk.slice(0, 12000);
    // The heading class carries a trailing space in the served markup, and the
    // result wrapper is a `<li>` for ordinary results but a `<div>` for rich
    // ones — so match on the class value rather than the element or its exact
    // attribute text.
    const heading = /<h3[^>]*class="res-title[^"]*"[^>]*>/.exec(item);
    if (!heading) continue;
    const anchor = /<a\s([^>]{0,4000})>([\s\S]*?)<\/a>/.exec(item.slice(heading.index + heading[0].length));
    if (!anchor) continue;
    // Without `data-mdurl` the only target is a 360 click tracker, which is not
    // a citable source; skip it rather than emit a redirect as the result URL.
    const direct = /data-mdurl="([^"]+)"/.exec(anchor[1]);
    if (direct === null) continue;
    const url = resolveHref(direct[1], base);
    if (url === undefined) continue;
    const title = text(anchor[2]);
    const summary = /<span[^>]*class="res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(item);
    const snippet = summary ? text(summary[1]) : '';
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/** Parse a Bing results page. */
function parseBing(html, base) {
  const sources = [];
  for (const chunk of html.split(/<li class="b_algo"/).slice(1)) {
    const item = chunk.slice(0, 8000);
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(item);
    if (!anchor) continue;
    const url = resolveHref(anchor[1], base);
    if (url === undefined) continue;
    const title = text(anchor[2]);
    const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(item);
    const snippet = paragraph ? text(paragraph[1]) : '';
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/**
 * Parse a DuckDuckGo lite page.
 *
 * Its attributes are single-quoted (`class='result-link'`), unlike Bing's, so
 * the patterns here accept either quote style. The snippet lives in a sibling
 * row (`class='result-snippet'`) that follows the anchor, so each hit is
 * examined up to the next hit.
 */
function parseDdgLite(html, base) {
  const sources = [];
  const anchors = [...html.matchAll(/<a\s[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [index, match] of anchors.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < anchors.length ? anchors[index + 1].index : html.length;
    const url = resolveHref(/href=['"]([^'"]+)['"]/.exec(match[0])?.[1], base);
    if (url === undefined) continue;
    const title = text(match[1]);
    const snippet = text(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(html.slice(start, end))?.[1] ?? '');
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/**
 * Parse a DuckDuckGo HTML page.
 *
 * The endpoint used to be richer than the lite one and carries a snippet per
 * hit (`result__snippet`), which the lite page also has but with different
 * markup. Outbound links are wrapped as `/l/?uddg=<percent-encoded>`, which
 * `resolveHref` unwraps. Attribute order and quoting vary, so both are matched
 * loosely.
 */
function parseDdgHtml(html, base) {
  const sources = [];
  const anchors = [...html.matchAll(/<a\s[^>]*class=['"]result__a['"][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [index, match] of anchors.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < anchors.length ? anchors[index + 1].index : html.length;
    const url = resolveHref(/href=['"]([^'"]+)['"]/.exec(match[0])?.[1], base);
    if (url === undefined) continue;
    const title = text(match[1]);
    const snippet = text(
      /<[a-z]+[^>]*class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html.slice(start, end))?.[1] ?? '',
    );
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/**
 * Parse an AnySearch JSON envelope.
 *
 * The endpoint is a documented API rather than scraped markup, so it needs no
 * echo check: the envelope either carries `data.results` or reports a business
 * code. Rows without a usable URL are dropped — the seam requires a citable
 * URL, and inventing one would be a lie.
 */
function parseAnySearch(payload) {
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof body !== 'object' || body === null || body.code !== 0) return [];
  const rows = body.data?.results;
  if (!Array.isArray(rows)) return [];
  const sources = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const url = resolveHref(typeof row.url === 'string' ? row.url : undefined, 'https://api.anysearch.com');
    if (url === undefined) continue;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : '';
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/**
 * Check that a page actually belongs to the query.
 *
 * Every engine echoes the query in its search box, so a genuine result page
 * contains it. A rate-limited reply does not: Bing answers repeated rapid
 * requests with a "trending" feed whose entries belong to somebody else's
 * search, and those results were previously attributed to the user's query.
 * Accepted when the query has no token long enough to be distinctive.
 */
function echoesQuery(html, query) {
  const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3);
  if (tokens.length === 0) return true;
  const lower = html.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

/**
 * Fetch and parse one engine, once, over the chosen route.
 * @returns the parsed sources or a failure reason; never throws for a normal
 *   network or parse failure, but rethrows cancellation.
 */
async function attempt(host, url, signal, timeoutMs, proxy, query) {
  const post = host.method === 'POST';
  const headers = {
    'user-agent': USER_AGENT,
    accept: post ? 'application/json' : 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(post ? { 'content-type': 'application/json' } : {}),
  };
  const body = typeof host.body === 'function' ? host.body(query) : undefined;
  let status;
  let html;
  try {
    if (proxy === undefined) {
      const timer = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? timer : AbortSignal.any([signal, timer]);
      const response = await fetch(url, {
        signal: combined,
        redirect: 'follow',
        headers,
        ...(post ? { method: 'POST', body } : {}),
      });
      status = response.status;
      html = response.ok ? await response.text() : '';
    } else {
      const response = await proxyGet(url, { proxy, headers, timeoutMs, signal, ...(post ? { method: 'POST', body } : {}) });
      status = response.status;
      html = response.text;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: `${host.id}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (status < 200 || status >= 300) return { ok: false, reason: `${host.id}: HTTP ${status}` };
  // A JSON API validates itself through its envelope, so the echoed-query check
  // (which exists to catch rate-limit pages) does not apply to it.
  if (host.skipEcho !== true && !echoesQuery(html, query)) {
    return { ok: false, reason: `${host.id}: page does not match the query (possibly rate limited)` };
  }
  let sources;
  try {
    sources = host.parse(html, url);
  } catch (error) {
    // Markup drift upstream must degrade to the next engine, not fail the search.
    return { ok: false, reason: `${host.id}: parse failed (${error instanceof Error ? error.message : String(error)})` };
  }
  return { ok: true, sources: dedupe(sources) };
}

/**
 * Fetch and parse one engine.
 *
 * A domestic engine goes direct first, because that is both faster and the path
 * its site expects; only if that fails is it retried through the tunnel, so a
 * network that blocks it directly still works. An engine marked `viaProxy` is
 * tunnelled from the start.
 *
 * @param host - one entry of {@link HOSTS}.
 * @param query - the user query.
 * @param signal - cancellation signal.
 * @param timeoutMs - per-engine deadline.
 * @param proxy - proxy URL, or `undefined` to go direct.
 * @returns the parsed sources, or a failure reason; never throws for a normal
 *   network or parse failure, but rethrows cancellation.
 */
export async function searchHost(host, query, signal, timeoutMs = 15000, proxy) {
  const url = host.build(query);
  const route = host.viaProxy === true ? proxy : undefined;
  const first = await attempt(host, url, signal, timeoutMs, route, query);
  if (first.ok || route !== undefined || proxy === undefined || signal?.aborted) return first;
  const retry = await attempt(host, url, signal, timeoutMs, proxy, query);
  return retry.ok ? retry : first;
}

/** Deduplicate by URL, preserving first-seen order. */
function dedupe(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    // `www.` and a trailing slash are the same document served twice, and the
    // scraped engines disagree about both.
    const key = source.url.replace(/\/$/, '').replace(/^(https?:\/\/)www\./, '$1');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

/**
 * Interleave per-engine result lists so no single engine fills every slot.
 *
 * A list's weight decides how many of its entries each round takes, so a
 * high-precision engine can hold more of the merged list without silencing the
 * others entirely.
 *
 * @param lists - one list per engine, in engine priority order.
 * @param weights - optional per-list weight, defaulting to 1.
 * @returns the merged list.
 */
function interleave(lists, weights = []) {
  const merged = [];
  const depth = Math.max(0, ...lists.map((list) => list.length));
  for (let round = 0; round < depth; round += 1) {
    for (const [index, list] of lists.entries()) {
      const weight = weights[index] ?? 1;
      for (let slot = 0; slot < weight; slot += 1) {
        const item = list[round * weight + slot];
        if (item !== undefined) merged.push(item);
      }
    }
  }
  return dedupe(merged);
}

/**
 * Run one tier concurrently and merge whatever answered in time.
 *
 * A tier finishes when every engine settled, when enough sources have arrived
 * from `needed` engines, or when the soft deadline passes. Requiring more than
 * one contributor is what keeps the merged list cross-engine: the first engine
 * to answer is usually fast but narrow, and returning on its reply alone would
 * silently drop the other engines. Stragglers are aborted rather than awaited,
 * so one slow engine cannot delay a search that is already answered.
 */
async function runTier(hosts, query, signal, timeoutMs, failures, proxy, limits) {
  // The release condition counts the engines that lead this query's language,
  // so a fast domestic engine cannot end an English run before the English
  // engines have answered, and an engine marked `both` counts for either.
  // Falls back to counting every engine when no engine leads (for example with
  // no proxy, where tunnel-only engines are filtered out).
  const counters = limits.lead === 'all' || !hosts.some((host) => leadsQuery(host, limits.lead)) ? () => true : (host) => leadsQuery(host, limits.lead);
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  const results = new Array(hosts.length);
  const available = () =>
    results.reduce((total, outcome, index) => total + (counters(hosts[index]) && outcome?.ok === true ? outcome.sources.length : 0), 0);
  const contributors = () =>
    results.filter((outcome, index) => counters(hosts[index]) && outcome?.ok === true && outcome.sources.length > 0).length;
  const needed = Math.min(limits.needed ?? 2, hosts.filter(counters).length || hosts.length);
  const leadTotal = hosts.filter(counters).length || hosts.length;
  // Nothing more can arrive from the leading region once every one of its
  // engines settled, so a failed engine there must not hold the tier open until
  // the soft deadline.
  const leadSettled = () => results.filter((outcome, index) => counters(hosts[index]) && outcome !== undefined).length >= leadTotal;
  const done = () =>
    results.filter((outcome) => outcome !== undefined).length === hosts.length ||
    leadSettled() ||
    (available() >= limits.limit && contributors() >= needed);
  let released;
  let releaseReason = 'deadline';
  let closed = false;
  const release = (reason) => {
    if (closed) return;
    closed = true;
    releaseReason = reason;
    released();
  };
  const enough = new Promise((resolve) => {
    released = resolve;
  });
  const running = hosts.map((host, index) =>
    searchHost(host, query, controller.signal, timeoutMs, proxy).then(
      (outcome) => {
        results[index] = outcome;
        if (done()) release('enough');
      },
      (error) => {
        // An engine's own failure is a returned value, but cancellation comes
        // from the caller: propagate it instead of finishing a search nobody
        // is waiting for any more.
        if (signal?.aborted) throw error;
        results[index] = { ok: false, reason: `${host.id}: ${error instanceof Error ? error.message : String(error)}` };
        if (done()) release('enough');
      },
    ),
  );
  const timer = setTimeout(() => release('deadline'), limits.softMs);
  try {
    await Promise.race([Promise.all(running), enough]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', relayAbort);
  }
  const lists = [];
  for (const [index, outcome] of results.entries()) {
    if (outcome === undefined) {
      failures.push(
        releaseReason === 'enough' ? `${hosts[index].id}: aborted once enough results had arrived` : `${hosts[index].id}: still running at deadline`,
      );
    } else if (!outcome.ok) {
      failures.push(outcome.reason);
      if (BLOCK_PAGE.test(outcome.reason)) cooling.set(hosts[index].id, Date.now() + COOLDOWN_MS);
    } else if (outcome.sources.length === 0) failures.push(`${hosts[index].id}: no results`);
    else lists.push({ host: hosts[index], sources: outcome.sources });
  }
  return lists;
}

/** Which side of the query-language split an engine belongs to. */
function regionOf(host) {
  if (host.region === 'both') return 'both';
  return host.region === 'global' ? 'global' : 'cn';
}

/** Whether an engine leads a query whose language belongs to `lead`. */
function leadsQuery(host, lead) {
  const region = regionOf(host);
  return region === 'both' || region === lead;
}

/**
 * Merge per-engine lists, leading with the region the query language belongs to.
 *
 * The leading region fills the caller's budget; the other region only appends
 * when the leading one did not answer enough, so an English query cannot be
 * half-filled with dictionary entries from a domestic engine that matched one
 * word of it.
 */
function mergeRegions(entries, lead, limit) {
  const head = entries.filter((entry) => leadsQuery(entry.host, lead));
  const tail = entries.filter((entry) => !leadsQuery(entry.host, lead));
  const weighted = (list) => interleave(list.map((entry) => entry.sources), list.map((entry) => entry.host.weight ?? 1));
  const preferred = weighted(head);
  if (preferred.length >= limit) return preferred;
  return dedupe([...preferred, ...weighted(tail)]);
}

/**
 * Search with tiered engines and return deduplicated sources.
 *
 * @param query - the user query.
 * @param signal - cancellation signal.
 * @param options - `hostIds` restricts the engines; `timeoutMs` bounds each;
 *   `limit` is the caller's result budget; `softMs` caps the wait per tier;
 *   `wait` is `auto` (default) | `all` | `fast`; `proxy` overrides proxy
 *   resolution; `useProxy: false` forces a direct request.
 * @returns `{ sources, failures, proxy }`; `sources` may be empty.
 */
export async function search(query, signal, options = {}) {
  const allow = Array.isArray(options.hostIds) && options.hostIds.length > 0 ? new Set(options.hostIds) : undefined;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
  // A CJK query is best served by the domestic engines, which answer in a few
  // hundred milliseconds; an ASCII query wants the wider English index reached
  // through the tunnel, which costs a few seconds. Each run waits for its own
  // region's engines and leads with them, so the merged list is not filled by
  // the wrong region.
  const ascii = !/[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(query);
  const proxy = options.useProxy === false ? undefined : await resolveProxy(options.proxy);
  const hosts = (allow === undefined ? HOSTS : HOSTS.filter((host) => allow.has(host.id))).filter(
    (host) => host.viaProxy !== true || proxy !== undefined,
  );
  // Skip engines that recently served a block page, but never end up with no
  // engine at all: a throttled engine is still better than no search.
  const now = Date.now();
  const rested = hosts.filter((host) => (cooling.get(host.id) ?? 0) <= now);
  const failures = rested.length > 0 ? hosts.filter((host) => !rested.includes(host)).map((host) => `${host.id}: cooling down after a block page`) : [];
  const usable = rested.length > 0 ? rested : hosts;
  // Lead with the region the query language belongs to, keeping the configured
  // order inside each region. An engine marked `both` leads either way.
  const lead = ascii ? 'global' : 'cn';
  const ordered = [...usable.filter((host) => leadsQuery(host, lead)), ...usable.filter((host) => !leadsQuery(host, lead))];
  const wanted = usable.filter((host) => leadsQuery(host, lead)).length;
  const wait = options.wait === 'all' || options.wait === 'fast' ? options.wait : 'auto';
  const defaults = { all: 10000, fast: 3500, auto: ascii ? 6000 : 3500 };
  const softMs = Number.isFinite(options.softMs) && options.softMs > 0 ? options.softMs : defaults[wait];
  const needed = wait === 'all' ? usable.length : wait === 'fast' ? 1 : wanted > 0 ? wanted : Math.min(2, usable.length);
  const limits = { limit, softMs, needed, lead: wait === 'all' ? 'all' : lead };
  const primary = ordered.filter((host) => host.tier === 'primary');
  const fallback = ordered.filter((host) => host.tier === 'fallback');
  const run = async (tier) => mergeRegions(await runTier(tier, query, signal, timeoutMs, failures, proxy, limits), lead, limit);
  let sources = await run(primary);
  if (sources.length === 0 && fallback.length > 0) sources = await run(fallback);
  if (signal?.aborted) throw new Error('web search was cancelled');
  return { sources, failures, proxy };
}
