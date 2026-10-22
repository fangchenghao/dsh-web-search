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
 * @module dsh-web-search-bing/engines
 */
import type { EngineAnswer, HostSpec, RankOptions, Region, SearchOptions, SearchOutcome, WaitPolicy } from './types.ts';
import { SearchError } from './errors.ts';
import { resolveProxy } from './proxy.ts';
import { parseAnySearch, parseBing, parseDdgHtml, parseDdgLite, parseSo } from './parsers.ts';
import { mergeRegions } from './rank.ts';
import { cacheKey } from './cache.ts';
import type { SearchCache } from './cache.ts';
import type { EngineHealth } from './health.ts';
import { searchHost } from './transport.ts';

/** How many rows to ask AnySearch for; the merge picks from them. */
const ANYSEARCH_MAX_RESULTS = 20;

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
    build: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
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
    build: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US&setlang=en&cc=US`,
    parse: parseBing,
  },
  {
    id: 'cn.bing',
    tier: 'primary',
    region: 'cn',
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
    build: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    parse: parseDdgLite,
  },
];

/** Scripts that make a query CJK rather than ASCII. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

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
    searchHost(host, query, controller.signal, timeoutMs, proxy).then(
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
  const limits: TierLimits = { limit, softMs, needed, lead: wait === 'all' ? 'all' : lead };
  const rank = options.rank ?? {};

  // The key names the engines the run *would* use, not the ones that survived
  // the cooldown filter: an engine entering or leaving a cooldown must not
  // invalidate an entry that is still fresh, or every throttle would turn the
  // next identical query into a cache miss.
  const key = options.cache === undefined ? undefined : cacheKey({ query, limit, wait, lead, engines: hosts.map((host) => host.id) });
  const cached = key === undefined ? undefined : options.cache?.get(key);
  if (cached !== undefined) return { sources: cached, failures, ...(proxy === undefined ? {} : { proxy }) };

  const ordered = [...usable.filter((host) => leadsQuery(host, lead)), ...usable.filter((host) => !leadsQuery(host, lead))];
  const primary = ordered.filter((host) => host.tier === 'primary');
  const fallback = ordered.filter((host) => host.tier === 'fallback');

  let answers = await runTier(primary, query, signal, timeoutMs, failures, proxy, limits, options.health);
  let sources = answers.length === 0 ? [] : mergeRegions(answers, lead, limit, rank);
  if (sources.length === 0 && fallback.length > 0) {
    answers = await runTier(fallback, query, signal, timeoutMs, failures, proxy, limits, options.health);
    sources = answers.length === 0 ? [] : mergeRegions(answers, lead, limit, rank);
  }

  if (signal?.aborted === true) throw new SearchError('web search was cancelled', 'SEARCH_ABORTED', false);
  if (key !== undefined && sources.length > 0) options.cache?.set(key, sources);
  return { sources, failures, ...(proxy === undefined ? {} : { proxy }) };
}
