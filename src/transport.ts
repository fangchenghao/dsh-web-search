/**
 * One engine request, direct or tunnelled, classified.
 *
 * This module owns the only place where a transport failure becomes a
 * {@link SearchError} with a business code. That matters beyond diagnostics:
 * the engine health tracker decides from that code whether to cool the engine
 * down, and whether the service's own `Retry-After` should set the duration.
 *
 * @module @fangchenghao/dsh-web-search/transport
 */
import type { HostSpec, Source, TimeRange } from './types.ts';
import { SearchError, parseRetryAfter } from './errors.ts';
import { proxyGet } from './proxy.ts';
import { echoesQuery } from './parsers.ts';
import { gateFor } from './semaphore.ts';

/** Markers of an interstitial anti-bot page, narrow enough not to hit prose. */
const BOT_WALL_MARKERS = ['qcaptcha', '访问异常', 'unusual traffic', 'verify you are human', '安全验证'];

/**
 * Whether a payload is an anti-bot interstitial rather than a result page.
 * @param payload - response body.
 * @returns true when the page is a wall.
 */
function looksLikeBotWall(payload: string): boolean {
  if (payload.length === 0) return true;
  const sample = payload.slice(0, 4000).toLowerCase();
  return BOT_WALL_MARKERS.some((marker) => sample.includes(marker.toLowerCase()));
}

/** The user agent the scraped engines see. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** Outcome of asking one engine once. */
export type AttemptOutcome = { ok: true; sources: Source[] } | { ok: false; error: SearchError };

/**
 * Turn a non-2xx status into a classified failure.
 * @param id - engine id, used as the message prefix.
 * @param status - HTTP status.
 * @param retryAfter - the service's own wait hint in milliseconds, if any.
 * @returns the classified error.
 */
function statusError(id: string, status: number, retryAfter: number | undefined): SearchError {
  if (status === 429) return new SearchError(`${id}: HTTP 429`, 'SEARCH_THROTTLED', true, retryAfter);
  if (status === 403) return new SearchError(`${id}: HTTP 403`, 'SEARCH_BLOCKED', true, retryAfter);
  if (status >= 500) return new SearchError(`${id}: HTTP ${status}`, 'SEARCH_NETWORK', true, retryAfter);
  return new SearchError(`${id}: HTTP ${status}`, 'SEARCH_BLOCKED', true, retryAfter);
}

/**
 * Classify a thrown transport error.
 * @param id - engine id.
 * @param error - whatever was thrown.
 * @returns the classified error.
 */
function thrownError(id: string, error: unknown): SearchError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || /timed out/i.test(message)) {
    return new SearchError(`${id}: ${message}`, 'SEARCH_TIMEOUT', true);
  }
  return new SearchError(`${id}: ${message}`, 'SEARCH_NETWORK', true);
}

/**
 * Ask one engine once, through the given route.
 * @param host - the engine.
 * @param url - absolute request URL.
 * @param signal - cancellation.
 * @param timeoutMs - deadline for this attempt.
 * @param proxy - tunnel URL, or `undefined` to go direct.
 * @param query - the user query, used by the echoed-query check.
 * @returns parsed sources, or a classified failure; cancellation is rethrown.
 */
async function attempt(
  host: HostSpec,
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  proxy: string | undefined,
  query: string,
): Promise<AttemptOutcome> {
  const post = host.method === 'POST';
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: post ? 'application/json' : 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (post) headers['content-type'] = 'application/json';
  if (host.headers !== undefined) Object.assign(headers, host.headers);
  const body = typeof host.body === 'function' ? host.body(query) : undefined;

  let status: number;
  let payload: string;
  let retryAfter: number | undefined;
  try {
    if (proxy === undefined) {
      const timer = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? timer : AbortSignal.any([signal, timer]);
      const response = await fetch(url, {
        signal: combined,
        redirect: 'follow',
        headers,
        ...(post ? { method: 'POST' as const, body: body ?? '' } : {}),
      });
      status = response.status;
      retryAfter = parseRetryAfter(response.headers.get('retry-after') ?? undefined);
      payload = response.ok ? await response.text() : '';
    } else {
      const response = await proxyGet(url, {
        proxy,
        headers,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
        ...(post ? { method: 'POST' as const, body: body ?? '' } : {}),
      });
      status = response.status;
      retryAfter = parseRetryAfter(response.headers?.['retry-after']);
      payload = response.text;
    }
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return { ok: false, error: thrownError(host.id, error) };
  }

  if (status < 200 || status >= 300) return { ok: false, error: statusError(host.id, status, retryAfter) };

  // A wall served with HTTP 200 is not an empty result set. Treating it as one
  // quietly removed an engine from every search while its slot stayed reserved,
  // and the cooldown never engaged because nothing had failed.
  if (looksLikeBotWall(payload)) {
    return { ok: false, error: new SearchError(`${host.id}: bot verification page`, 'SEARCH_BLOCKED', true, retryAfter) };
  }

  // A JSON API validates itself through its envelope, so the echoed-query check
  // (which exists to catch a rate-limit page served with HTTP 200) does not
  // apply to it.
  const check = host.echoesQuery ?? echoesQuery;
  if (host.skipEcho !== true && !check(payload, query)) {
    return { ok: false, error: new SearchError(`${host.id}: page does not match the query (possibly rate limited)`, 'SEARCH_BLOCKED', true, retryAfter) };
  }

  try {
    return { ok: true, sources: host.parse(payload, url) };
  } catch (error) {
    // Markup drift upstream must degrade to the next engine, not fail the
    // search, and it must not cost the engine a cooldown: retrying markup that
    // changed shape cannot help.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: new SearchError(`${host.id}: parse failed (${message})`, 'SEARCH_PARSE', false) };
  }
}

/**
 * Ask one engine, going direct first unless it is marked `viaProxy`.
 *
 * A domestic engine goes direct first, because that is both faster and the path
 * its site expects; only if that fails is it retried through the tunnel, so a
 * network that blocks it directly still works. An engine marked `viaProxy` is
 * tunnelled from the start.
 *
 * @param host - the engine.
 * @param query - the user query.
 * @param signal - cancellation.
 * @param timeoutMs - per-attempt deadline.
 * @param proxy - tunnel URL, or `undefined` when none is available.
 * @param timeRange - active publication window, forwarded to engines that can
 *   push it into their query (currently DuckDuckGo's `df`).
 * @returns the outcome of the route that got furthest; cancellation is rethrown.
 */
export async function searchHost(
  host: HostSpec,
  query: string,
  signal: AbortSignal | undefined,
  timeoutMs = 15000,
  proxy?: string,
  timeRange?: TimeRange,
): Promise<AttemptOutcome> {
  const url = host.build(query, timeRange);
  const route = host.viaProxy === true ? proxy : undefined;
  // A gate holds the permit for the whole engine attempt, including the
  // direct-then-tunnel retry, so a burst of concurrent searches cannot stack
  // two requests on an engine that only tolerates a couple.
  const release = host.maxConcurrent === undefined
    ? undefined
    : await gateFor(host.id, host.maxConcurrent).acquire(signal);
  try {
    const first = await attempt(host, url, signal, timeoutMs, route, query);
    if (first.ok || route !== undefined || proxy === undefined || signal?.aborted === true) return first;
    const retry = await attempt(host, url, signal, timeoutMs, proxy, query);
    return retry.ok ? retry : first;
  } finally {
    release?.();
  }
}
