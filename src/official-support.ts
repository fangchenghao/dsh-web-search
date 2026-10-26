/**
 * Official, key-free release facts that ordinary search results often miss.
 *
 * PostgreSQL's versioning page is the first entry: it is the authoritative
 * source for the current major, current minor and final-support date, while a
 * generic web query frequently returns cloud-provider EOL pages or an old
 * press kit. The lookup is deliberately narrow: only a PostgreSQL query that
 * asks about versions, support or EOL is enriched, so an ordinary PostgreSQL
 * how-to search keeps the normal engine ranking.
 *
 * @module @fangchenghao/dsh-web-search/official-support
 */
import type { Source } from './types.ts';
import { proxyGet } from './proxy.ts';
import { text } from './parsers.ts';

/** PostgreSQL's official versioning and support table. */
export const POSTGRES_SUPPORT_URL = 'https://www.postgresql.org/support/versioning/';

const DEFAULT_TIMEOUT_MS = 8_000;

/** One major release row from the official table. */
export interface PostgresRelease {
  /** Major version, e.g. `18` or `9.6`. */
  major: string;
  /** Current minor release, e.g. `18.6`. */
  minor: string;
  /** Whether the PostgreSQL project still supports this major. */
  supported: boolean;
  /** First release date as printed by the page. */
  firstRelease: string;
  /** Final release date as printed by the page. */
  finalRelease: string;
}

/** Inputs accepted by {@link fetchPostgresSupport}. */
export interface PostgresSupportOptions {
  /** Tunnel URL from the plugin's `proxy` setting, when configured. */
  proxy?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Test seam; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}

/** True for a PostgreSQL query that is asking about versions/support/EOL. */
export function isPostgresVersionQuery(query: string): boolean {
  if (typeof query !== 'string') return false;
  const value = query.trim();
  if (!/\bpostgres(?:ql)?\b/iu.test(value)) return false;
  return /(?:eol|end[- ]of[- ]life|support(?:ed)?|version|latest|current|release|大版本|最新|版本|支持|结束|生命周期|过期|停止维护)/iu.test(value);
}

/** Read one table cell as plain text. */
function cellText(html: string): string {
  return text(html).replace(/\s+/gu, ' ').trim();
}

/**
 * Parse the official versioning table.
 *
 * The parser intentionally ignores the surrounding navigation and prose, and
 * returns only rows with five cells. A markup change yields an empty list so
 * the caller can fall back to ordinary search instead of returning a made-up
 * version.
 *
 * @param payload - the support page HTML.
 * @returns release rows, highest major first.
 */
export function parsePostgresSupport(payload: string): PostgresRelease[] {
  if (typeof payload !== 'string' || payload.trim().length === 0) return [];
  const rows: PostgresRelease[] = [];
  for (const match of payload.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const body = match[1] ?? '';
    const cells = [...body.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => cellText(cell[1] ?? ''));
    if (cells.length < 5) continue;
    const [major = '', minor = '', supported = '', firstRelease = '', finalRelease = ''] = cells;
    if (!/^\d+(?:\.\d+)?$/u.test(major)) continue;
    rows.push({
      major,
      minor,
      supported: /^yes\b/iu.test(supported),
      firstRelease,
      finalRelease,
    });
  }
  rows.sort((left, right) => Number.parseFloat(right.major) - Number.parseFloat(left.major));
  return rows;
}

/**
 * Build one model-facing source from the parsed table.
 *
 * The EOL field is the page's "Final Release" column. It is labeled as the
 * official final release/EOL date rather than as a promise about the exact
 * day a deployment stops receiving fixes.
 *
 * @param releases - parsed rows.
 * @returns a source, or `undefined` when no usable row exists.
 */
export function postgresSupportSource(releases: readonly PostgresRelease[]): Source | undefined {
  const latest = releases.find((release) => release.supported) ?? releases[0];
  if (latest === undefined) return undefined;
  const status = latest.supported ? 'supported' : 'not supported';
  return {
    url: POSTGRES_SUPPORT_URL,
    title: `PostgreSQL versioning policy: major ${latest.major} (${latest.minor}), ${status}`,
    snippet:
      `Official PostgreSQL versioning policy: latest major ${latest.major}; current minor ${latest.minor}; ` +
      `status ${status}; first release ${latest.firstRelease || 'not stated'}; ` +
      `final release (EOL) ${latest.finalRelease || 'not stated'}.`,
  };
}

/** Read the page over the configured tunnel, or directly when none is set. */
async function fetchText(url: string, options: PostgresSupportOptions, timeoutMs: number): Promise<string> {
  if (options.proxy !== undefined && options.proxy.length > 0) {
    const response = await proxyGet(url, {
      proxy: options.proxy,
      timeoutMs,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-web-search/0.20; +https://github.com/fangchenghao/dsh-web-search)',
        accept: 'text/html,application/xhtml+xml',
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.text;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const send = options.fetch ?? fetch;
    const response = await send(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; dsh-web-search/0.20; +https://github.com/fangchenghao/dsh-web-search)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Fetch and parse the official PostgreSQL support source.
 *
 * Failure is contained: a blocked page, a timeout or markup drift returns
 * `undefined` and the caller keeps its ordinary search rows.
 *
 * @param options - proxy, deadline, cancellation and fetch seam.
 * @returns the official source, or `undefined`.
 */
export async function fetchPostgresSupport(options: PostgresSupportOptions = {}): Promise<Source | undefined> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  try {
    const payload = await fetchText(POSTGRES_SUPPORT_URL, options, Math.min(timeoutMs, DEFAULT_TIMEOUT_MS));
    return postgresSupportSource(parsePostgresSupport(payload));
  } catch {
    return undefined;
  }
}
