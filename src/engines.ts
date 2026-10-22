/**
 * The engine registry and the search orchestration.
 *
 * A run has three stages: every engine of the leading tier is asked
 * concurrently, the answers are fused by reciprocal rank fusion with the
 * bilingual region policy on top, and the result is memoised. The tier releases
 * on the first of: every engine settled, the engines that lead this query's
 * language all settled, enough sources from enough contributors, or the soft
 * deadline. Requiring more than one contributor is what keeps the fused list
 * cross-engine: the first engine to answer is usually fast but narrow.
 *
 * @module @fangchenghao/dsh-web-search/engines
 */
import type { EngineAnswer, HostSpec, RankOptions, Region, SearchOptions, SearchOutcome, TimeRange, WaitPolicy } from './types.ts';
import { SearchError } from './errors.ts';
import { filterByTimeRange, preferWindow } from './freshness.ts';
import { resolveProxy } from './proxy.ts';
import { parseAnySearch, parseBing, parseDdgHtml, parseDdgLite, parseSo } from './parsers.ts';
import { mergeRegions } from './rank.ts';
import { cacheKey } from './cache.ts';
import type { SearchCache } from './cache.ts';
import type { EngineHealth } from './health.ts';
import { searchHost } from './transport.ts';

/** How many rows to ask AnySearch for; the merge picks from them. */
// AnySearch caps max_results at 10: asking for more returns 10 with HTTP
// 200, so the constant matches the real ceiling instead of over-asking.
const ANYSEARCH_MAX_RESULTS = 10;

/**
 * Engines, in merge priority order.
 *
 * `region` decides which query language an engine leads (`both` leads either),
 * `weight` how many slots it takes per interleave round, and `tier` whether it
 * runs as a first choice or only when no primary answered.
 */
export const HOSTS: readonly HostSpec[] = [
  {
    id: 'anysearch',
    tier: 'primary',
    // Serves both languages: it answers Chinese queries with the original
    // documentation and book translations rather than SEO farms, so it leads a
    // CJK query as well as an ASCII one (A/B measured: the domestic-only run
    // answered "如何配置 postgres 逻辑复制" with a dictionary page).
    region: 'both',
    // A JSON API rather than a result page: it takes a POST body, answers with
    // its own envelope, and is reachable directly. Its precision is the highest
    // here, so it takes the most slots.
    weight: 2,
    method: 'POST',
    skipEcho: true,
    build: () => 'https://api.anysearch.com/v1/search',
    body: (query) => JSON.stringify({ query, max_results: ANYSEARCH_MAX_RESULTS }),
    parse: parseAnySearch,
  },
  {
    id: 'ddg-html',
    tier: 'primary',
    region: 'global',
    viaProxy: true,
    build: (query, timeRange) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${ddgWindow(timeRange)}`,
    parse: parseDdgHtml,
  },
  {
    id: 'www.bing',
    // A fallback rather than a primary: measured on stopword-heavy English
    // queries it matched a single token and answered with unrelated pages
    // ("how to set up postgres logical replication" returned jigsaw-puzzle
    // sites for "set"), while the engines above stayed on topic.
    tier: 'fallback',
    region: 'global',
    viaProxy: true,
    // No `filters` parameter: see the measurement note before `HOSTS`.
    build: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US&setlang=en&cc=US`,
    parse: parseBing,
  },
  {
    id: 'cn.bing',
    tier: 'primary',
    region: 'cn',
    // No `filters` parameter: see the measurement note before `HOSTS`.
    build: (query) => `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBing,
  },
  {
    id: 'so',
    tier: 'primary',
    region: 'cn',
    build: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: parseSo,
  },
  {
    id: 'ddg-lite',
    tier: 'fallback',
    region: 'global',
    viaProxy: true,
    build: (query, timeRange) =>
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}${ddgWindow(timeRange)}`,
    parse: parseDdgLite,
  },
];

/** Scripts that make a query CJK rather than ASCII. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/**
 * DuckDuckGo's own date filter, appended to a result-page URL.
 *
 * Measured live on both endpoints: adding `df=d`, `df=w` or `df=m` changed the
 * returned result set, so this is a real pushdown rather than a decorative
 * parameter. `off` (and the absent value) adds nothing.
 *
 * @param timeRange - active window, if any.
 * @returns `&df=x` for a supported window, otherwise an empty string.
 */
function ddgWindow(timeRange: TimeRange | undefined): string {
  switch (timeRange) {
    case 'day':
      return '&df=d';
    case 'week':
      return '&df=w';
    case 'month':
      return '&df=m';
    case 'year':
      return '&df=y';
    case 'off':
    case undefined:
    default:
      return '';
  }
}

/*
 * Why Bing has no time parameter.
 *
 * Measured on `cn.bing.com` and `www.bing.com` (which redirects to `cn.bing`):
 * `filters=ex1:"ez1|ez2|ez3|ez5_…"` is accepted — the response marks the
 * matching entry as selected — but the ten returned URLs were byte-for-byte
 * identical to the unfiltered run for both a general and a news query. Bing's
 * filter is therefore not written into the request; the engine layer filters
 * Bing's parsed dates locally instead.
 */

/** Soft deadline per wait policy, in milliseconds. */
const SOFT_DEADLINE: Record<WaitPolicy, (ascii: boolean) => number> = {
  auto: (ascii) => (ascii ? 6000 : 3500),
  all: () => 10000,
  fast: () => 3500,
};

/** Whether an engine leads a query whose language belongs to `lead`. */
function leadsQuery(host: HostSpec, lead: Region): boolean {
  return host.region === 'both' || host.region === lead;
}

/** Tuning for one tier run. */
interface TierLimits {
  /** Caller budget. */
  limit: number;
  /** Soft deadline in milliseconds. */
  softMs: number;
  /** Contributors required before an early release. */
  needed: number;
  /** Region that leads, or `all` to count every engine. */
  lead: Region | 'all';
  /** Active publication window, pushed down to engines that support it. */
  timeRange: TimeRange;
}

/**
 * Run one tier concurrently and return the answers that arrived in time.
 * @param hosts - engines of this tier, in priority order.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param timeoutMs - per-engine deadline.
 * @param failures - collector for caller-facing failure strings.
 * @param proxy - tunnel URL, or `undefined`.
 * @param limits - release thresholds.
 * @param health - cooldown tracker to update, when one is configured.
 * @returns one answer per engine that produced sources.
 */
async function runTier(
  hosts: readonly HostSpec[],
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  failures: string[],
  proxy: string | undefined,
  limits: TierLimits,
  health: EngineHealth | undefined,
): Promise<EngineAnswer[]> {
  const counters = limits.lead === 'all' || !hosts.some((host) => leadsQuery(host, limits.lead as Region))
    ? () => true
    : (host: HostSpec) => leadsQuery(host, limits.lead as Region);
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });

  const outcomes: Array<EngineAnswer | SearchError | undefined> = new Array(hosts.length).fill(undefined);
  const answered = () => outcomes.filter((outcome) => outcome instanceof SearchError || outcome !== undefined);
  const available = () =>
    outcomes.reduce((total, outcome) => total + (outcome instanceof SearchError || outcome === undefined ? 0 : outcome.sources.length), 0);
  const contributors = () =>
    outcomes.filter((outcome, index) => counters(hosts[index] as HostSpec) && !(outcome instanceof SearchError) && outcome !== undefined && outcome.sources.length > 0).length;
  const leadTotal = hosts.filter(counters).length || hosts.length;
  const needed = Math.min(limits.needed, leadTotal);
  // Nothing more can arrive from the leading region once every one of its
  // engines settled, so a failed engine there must not hold the tier open until
  // the soft deadline.
  const leadSettled = () => outcomes.filter((outcome, index) => counters(hosts[index] as HostSpec) && outcome !== undefined).length >= leadTotal;
  const done = () =>
    answered().length === hosts.length || leadSettled() || (available() >= limits.limit && contributors() >= needed);

  let releasedEarly = false;
  let closed = false;
  let released: () => void = () => {};
  const enough = new Promise<void>((resolve) => {
    released = resolve;
  });
  const release = (early: boolean) => {
    if (closed) return;
    closed = true;
    releasedEarly = early;
    released();
  };

  const running = hosts.map((host, index) =>
    searchHost(host, query, controller.signal, timeoutMs, proxy, limits.timeRange).then(
      (outcome) => {
        if (outcome.ok) {
          outcomes[index] = { host, sources: outcome.sources };
          health?.noteSuccess(host.id);
        } else {
          outcomes[index] = outcome.error;
          health?.noteFailure(host.id, outcome.error);
        }
        if (done()) release(true);
      },
      (error: unknown) => {
        // An engine's own failure is a returned value, but cancellation comes
        // from the caller: propagate it instead of finishing a search nobody is
        // waiting for any more.
        if (signal?.aborted === true) throw error;
        const message = error instanceof Error ? error.message : String(error);
        outcomes[index] = new SearchError(`${host.id}: ${message}`, 'SEARCH_NETWORK', true);
        if (done()) release(true);
      },
    ),
  );

  const timer = setTimeout(() => release(false), limits.softMs);
  try {
    await Promise.race([Promise.all(running), enough]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', relayAbort);
  }

  const answers: EngineAnswer[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const host = hosts[index] as HostSpec;
    if (outcome === undefined) {
      failures.push(
        releasedEarly ? `${host.id}: aborted once enough results had arrived` : `${host.id}: still running at deadline`,
      );
    } else if (outcome instanceof SearchError) {
      failures.push(outcome.message);
    } else if (outcome.sources.length === 0) {
      failures.push(`${host.id}: no results`);
    } else {
      answers.push(outcome);
    }
  }
  return answers;
}

/** Options for {@link search}: the seam's budget plus the plugin's runtime. */
export interface EngineRunOptions extends SearchOptions {
  /** AnySearch Bearer token; empty or absent means anonymous access. */
  anysearchApiKey?: string;
  /** AnySearch vertical domain, such as `finance` or `finance.us_stock`. */
  anysearchDomain?: string;
  /** Ranking knobs, falling back to the documented defaults. */
  rank?: RankOptions;
  /** Result cache to consult and fill, when one is configured. */
  cache?: SearchCache;
  /** Cooldown tracker, when one is configured. */
  health?: EngineHealth;
}

/**
 * Search the web with every configured engine and fuse the answers.
 * @param query - the user query.
 * @param signal - caller cancellation.
 * @param options - budget, policy and runtime dependencies.
 * @returns fused sources plus the failures worth reporting; throws on cancellation.
 */
/**
 * Apply per-run configuration to an engine definition.
 *
 * Only AnySearch is configurable today: it authenticates with a Bearer token and
 * can be pointed at one of its vertical domains. Returning a copy keeps the
 * exported `HOSTS` catalogue static, so a stale credential can never leak into
 * the next run through a mutated descriptor.
 * @param host - the engine definition from `HOSTS`.
 * @param options - the run options carrying the credential and domain.
 * @returns the engine definition to use for this run.
 */
export function resolveHost(host: HostSpec, options: Pick<EngineRunOptions, 'anysearchApiKey' | 'anysearchDomain'>): HostSpec {
  if (host.id !== 'anysearch') return host;
  const key = (options.anysearchApiKey ?? '').trim();
  const domain = (options.anysearchDomain ?? '').trim();
  if (key.length === 0 && domain.length === 0) return host;
  const headers = key.length === 0 ? undefined : { authorization: `Bearer ${key}` };
  const body = (query: string): string => {
    const payload: Record<string, unknown> = { query, max_results: ANYSEARCH_MAX_RESULTS };
    if (domain.length > 0) {
      const dot = domain.indexOf('.');
      if (dot > 0) {
        payload['domain'] = domain.slice(0, dot);
        payload['sub_domain'] = domain;
      } else {
        payload['domain'] = domain;
      }
    }
    return JSON.stringify(payload);
  };
  return { ...host, body, ...(headers === undefined ? {} : { headers }) };
}

export async function search(query: string, signal: AbortSignal | undefined, options: EngineRunOptions): Promise<SearchOutcome> {
  const limit = Math.max(1, Math.min(options.limit, 20));
  const timeoutMs = options.timeoutMs ?? 15000;
  const wait: WaitPolicy = options.wait ?? 'auto';
  const timeRange: TimeRange = options.timeRange ?? 'off';
  const proxy = options.useProxy === false ? undefined : await resolveProxy(options.proxy);

  const allow = options.hostIds !== undefined && options.hostIds.length > 0 ? new Set(options.hostIds) : undefined;
  const hosts = HOSTS.filter((host) => allow === undefined || allow.has(host.id))
    .filter((host) => host.viaProxy !== true || proxy !== undefined)
    .map((host) => resolveHost(host, options));

  // Skip engines that are cooling down, but never end up with no engine at all:
  // a throttled engine is still better than no search.
  const now = Date.now();
  const failures: string[] = [];
  const rested = hosts.filter((host) => options.health?.isCooling(host.id, now) !== true);
  if (rested.length > 0 && options.health !== undefined) {
    for (const host of hosts) {
      if (rested.includes(host)) continue;
      const reason = options.health.skipped(host.id, now);
      failures.push(`${host.id}: ${reason ?? 'cooling down'}`);
    }
  }
  const usable = rested.length > 0 ? rested : hosts;

  const ascii = !CJK.test(query);
  const lead: Region = ascii ? 'global' : 'cn';
  const wanted = usable.filter((host) => leadsQuery(host, lead)).length;
  const softMs = options.softMs ?? SOFT_DEADLINE[wait](ascii);
  const needed = wait === 'all' ? usable.length : wait === 'fast' ? 1 : wanted > 0 ? wanted : Math.min(2, usable.length);
  const limits: TierLimits = { limit, softMs, needed, lead: wait === 'all' ? 'all' : lead, timeRange };
  // Ranking does not drop rows; the engine layer does. `timeRange` is passed
  // into the rank options only so undated rows are scored lower while a window
  // is active. Keeping it out of the configured `rank` object preserves the
  // documented shape of `ResolvedConfig.rank`.
  const rank: RankOptions = {
    ...(options.rank ?? {}),
    ...(timeRange === 'off' ? {} : { timeRange }),
  };

  /**
   * Drop results whose parsed date is outside the window.
   *
   * Undated results survive on purpose: most documentation pages publish no
   * date, and discarding them would empty the list for a library query. They
   * are down-weighted during fusion instead, so a dated in-window page wins a
   * close comparison without erasing the undated long tail.
   */
  const applyWindow = (answers: EngineAnswer[]): EngineAnswer[] =>
    timeRange === 'off'
      ? answers
      : answers.map((answer) => ({ host: answer.host, sources: filterByTimeRange(answer.sources, timeRange) }));

  // The key names the engines the run *would* use, not the ones that survived
  // the cooldown filter: an engine entering or leaving a cooldown must not
  // invalidate an entry that is still fresh, or every throttle would turn the
  // next identical query into a cache miss.
  const key = options.cache === undefined ? undefined : cacheKey({ query, limit, wait, lead, engines: hosts.map((host) => host.id), timeRange });
  const cached = key === undefined ? undefined : options.cache?.get(key);
  if (cached !== undefined) return { sources: cached, failures, ...(proxy === undefined ? {} : { proxy }) };

  const ordered = [...usable.filter((host) => leadsQuery(host, lead)), ...usable.filter((host) => !leadsQuery(host, lead))];
  const primary = ordered.filter((host) => host.tier === 'primary');
  const fallback = ordered.filter((host) => host.tier === 'fallback');

  let answers = applyWindow(await runTier(primary, query, signal, timeoutMs, failures, proxy, limits, options.health));
  let sources = answers.length === 0 ? [] : preferWindow(mergeRegions(answers, lead, limit, rank), timeRange);
  if (sources.length === 0 && fallback.length > 0) {
    answers = applyWindow(await runTier(fallback, query, signal, timeoutMs, failures, proxy, limits, options.health));
    sources = answers.length === 0 ? [] : preferWindow(mergeRegions(answers, lead, limit, rank), timeRange);
  }

  if (signal?.aborted === true) throw new SearchError('web search was cancelled', 'SEARCH_ABORTED', false);
  if (key !== undefined && sources.length > 0) options.cache?.set(key, sources);
  return { sources, failures, ...(proxy === undefined ? {} : { proxy }) };
}
