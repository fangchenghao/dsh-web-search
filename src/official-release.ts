/**
 * Official Rust release notes for an explicitly versioned release query.
 *
 * Search engines often return the Rust home page or a third-party changelog for
 * a query such as `Rust 1.90 发布说明`, even when the official announcement is
 * indexed. The release announcement has a deterministic shape once its date is
 * known: `https://blog.rust-lang.org/YYYY/MM/DD/Rust-X.Y.Z/`. GitHub's public
 * release endpoint is key-free and exposes that date, so this module can add
 * the official page as a high-priority row without hard-coding release dates.
 *
 * The lookup is deliberately narrow. Only a Rust query that names a numeric
 * version *and* asks for release notes is enriched; a generic Rust tutorial
 * keeps the normal engine ranking.
 *
 * @module @fangchenghao/dsh-web-search/official-release
 */
import type { Source } from './types.ts';
import { proxyGet } from './proxy.ts';
import { text } from './parsers.ts';

/** Public GitHub release endpoint for the Rust repository. */
export const RUST_RELEASE_API = 'https://api.github.com/repos/rust-lang/rust/releases/tags';

/** Official Rust announcement host. */
export const RUST_BLOG_HOST = 'blog.rust-lang.org';

const DEFAULT_TIMEOUT_MS = 6_000;

/** Inputs accepted by {@link fetchRustRelease}. */
export interface RustReleaseOptions {
  /** Tunnel URL from the plugin's `proxy` setting, when configured. */
  proxy?: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Test seam; defaults to the platform `fetch`. */
  fetch?: typeof fetch;
}

/** A version such as `1.90`, normalized to a release tag like `1.90.0`. */
export interface RustVersion {
  /** User-facing version, e.g. `1.90.0`. */
  readonly version: string;
  /** GitHub tag, normally identical to {@link version}. */
  readonly tag: string;
}

/** Extract a Rust version from a release query. */
export function rustReleaseVersion(query: string): RustVersion | undefined {
  if (typeof query !== 'string' || !/\brust\b/iu.test(query)) return undefined;
  const match = /\brust(?:\s+(?:release|version|v))?\s*([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?)\b/iu.exec(query);
  if (match?.[1] === undefined) return undefined;
  const raw = match[1];
  const version = raw.split('.').length === 2 ? `${raw}.0` : raw;
  return { version, tag: version };
}

/** True for a query asking for a specific Rust release's notes. */
export function isRustReleaseQuery(query: string): boolean {
  if (typeof query !== 'string') return false;
  if (rustReleaseVersion(query) === undefined) return false;
  return /(?:release|releases|changelog|notes?|announcement|发布|发行|版本|更新|说明|日志|公告)/iu.test(query);
}

/** Trim release Markdown/HTML into a bounded snippet. */
function releaseSnippet(body: unknown, version: string): string {
  const plain = text(typeof body === 'string' ? body : '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const prefix = `Official Rust ${version} release notes. `;
  if (plain.length === 0) return prefix.trim();
  const budget = Math.max(80, 420 - prefix.length);
  return `${prefix}${plain.length > budget ? `${plain.slice(0, budget).trimEnd()}…` : plain}`;
}

/**
 * Build the canonical announcement URL from a GitHub release timestamp.
 *
 * Rust publishes the post on the UTC date in the release metadata. Using UTC
 * avoids shifting the path when the machine is in a negative-offset timezone.
 */
export function rustBlogUrl(version: string, publishedAt: string): string | undefined {
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `https://${RUST_BLOG_HOST}/${yyyy}/${mm}/${dd}/Rust-${version}/`;
}

/**
 * Parse a GitHub release response into one official-blog source.
 *
 * A malformed response, a missing publication date or a tag that does not
 * match the requested version returns `undefined`; the caller then keeps the
 * ordinary search rows.
 *
 * @param payload - GitHub JSON response body.
 * @param requested - normalized version from the query.
 * @returns the official source, or `undefined`.
 */
export function parseRustRelease(payload: string, requested: RustVersion): Source | undefined {
  if (typeof payload !== 'string' || payload.trim().length === 0) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const publishedAt = typeof record['published_at'] === 'string' ? record['published_at'] : '';
  const url = rustBlogUrl(requested.version, publishedAt);
  if (url === undefined) return undefined;
  const tag = typeof record['tag_name'] === 'string' ? record['tag_name'] : '';
  if (tag.length > 0 && tag !== requested.tag && tag !== requested.version) return undefined;
  const title = `Announcing Rust ${requested.version} - Rust Blog`;
  const snippet = releaseSnippet(record['body'], requested.version);
  return {
    url,
    title,
    snippet,
    ...(Number.isNaN(new Date(publishedAt).getTime()) ? {} : { publishedAt: new Date(publishedAt).toISOString() }),
  };
}

/** One direct GET with its own abort budget. */
async function directJson(url: string, headers: Record<string, string>, options: RustReleaseOptions, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const send = options.fetch ?? fetch;
    const response = await send(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Read the GitHub release endpoint.
 *
 * Measurement showed this API is often fast directly and slow through the
 * configured tunnel (a successful proxy request took ~4 s while the direct
 * request took <1 s). Try direct first with a short exploratory budget, then
 * spend the rest of the caller's deadline on the tunnel when direct fails.
 * A test seam bypasses the tunnel so unit tests stay deterministic.
 */
async function fetchJson(url: string, options: RustReleaseOptions, timeoutMs: number): Promise<string> {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Mozilla/5.0 (compatible; dsh-web-search; +https://github.com/fangchenghao/dsh-web-search)',
  };
  const started = Date.now();
  if (options.fetch !== undefined) return directJson(url, headers, options, timeoutMs);
  try {
    return await directJson(url, headers, options, Math.min(timeoutMs, 1_500));
  } catch (error) {
    if (options.proxy === undefined || options.proxy.length === 0) throw error;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < 250) throw error;
    const response = await proxyGet(url, {
      proxy: options.proxy,
      timeoutMs: remaining,
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.text;
  }
}

/**
 * Fetch the official Rust release page for a query.
 *
 * Failure is contained: an unavailable API, rate limit or malformed body
 * returns `undefined`, and the caller keeps its ordinary search rows.
 *
 * @param query - the original user query.
 * @param options - proxy, deadline, cancellation and fetch seam.
 * @returns the official blog source, or `undefined`.
 */
export async function fetchRustRelease(query: string, options: RustReleaseOptions = {}): Promise<Source | undefined> {
  if (!isRustReleaseQuery(query)) return undefined;
  const requested = rustReleaseVersion(query);
  if (requested === undefined) return undefined;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  try {
    const payload = await fetchJson(`${RUST_RELEASE_API}/${requested.tag}`, options, timeoutMs);
    return parseRustRelease(payload, requested);
  } catch {
    return undefined;
  }
}
