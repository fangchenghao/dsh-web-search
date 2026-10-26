/**
 * Key-free vertical (domain-specific) search sources.
 *
 * `web_search` answers "what is on the open web". This module answers the
 * narrower question a coding agent asks far more often: "which package, which
 * paper, which repository, which Q&A thread". Every endpoint here is a public,
 * documented, credential-free API, so the feature costs no key and no account.
 *
 * A source is a build/parse pair: {@link VerticalSpec.build} turns the query
 * into an absolute URL, and the parser turns the served body into the same
 * {@link Source} shape `web_search` returns. Parsers never throw on markup or
 * payload drift — a source that changes shape yields an empty list so the other
 * sources still answer. Timeouts, status classification and failure isolation
 * live in {@link searchVerticals}, not in the parsers.
 *
 * The original eight sources answer by default. The expanded repositories,
 * package registries, paper indexes and data sources are opt-in
 * (`defaultOn: false`): they are queried only when the caller names them, so a
 * bare `domain_search` stays a cheap eight-request fan-out instead of a
 * thirty-request one (GitHub alone allows ten unauthenticated searches a
 * minute). {@link DEFAULT_VERTICAL_IDS} is the default set and
 * {@link VERTICAL_IDS} is every supported source.
 *
 * @module @fangchenghao/dsh-web-search/verticals
 */
import type { Source, TimeRange } from './types.ts';
import { SearchError } from './errors.ts';
import { text } from './parsers.ts';
import { decodeEntities } from './markdown.ts';
import { proxyGet } from './proxy.ts';

/** Identifiers accepted in `sources` and in the `domainSources` config field. */
export type VerticalId =
  // The original default set.
  | 'github'
  | 'npm'
  | 'pypi'
  | 'arxiv'
  | 'wikipedia'
  | 'hn'
  | 'stackexchange'
  | 'crates'
  // Code hosts: repositories, issues and merge requests.
  | 'githubissues'
  | 'gitlab'
  | 'codeberg'
  // Package, container, model and extension registries.
  | 'dockerhub'
  | 'maven'
  | 'nuget'
  | 'rubygems'
  | 'packagist'
  | 'pubdev'
  | 'huggingface'
  | 'hfdatasets'
  | 'openvsx'
  | 'terraform'
  | 'terraformproviders'
  | 'wordpress'
  | 'jetbrains'
  // Papers and life-science records.
  | 'openalex'
  | 'crossref'
  | 'europepmc'
  | 'uniprot'
  | 'clinicaltrials'
  // Structured data: vulnerabilities, coins, archive, entities and places.
  | 'nvd'
  | 'coingecko'
  | 'internetarchive'
  | 'wikidata'
  | 'nominatim';

/**
 * Every supported source, in the order results are interleaved.
 *
 * The eight original ids come first so the default set keeps its historical
 * order; expanded sources follow, grouped by kind.
 */
export const VERTICAL_IDS: readonly VerticalId[] = [
  'github',
  'npm',
  'pypi',
  'arxiv',
  'wikipedia',
  'hn',
  'stackexchange',
  'crates',
  'githubissues',
  'gitlab',
  'codeberg',
  'dockerhub',
  'maven',
  'nuget',
  'rubygems',
  'packagist',
  'pubdev',
  'huggingface',
  'hfdatasets',
  'openvsx',
  'terraform',
  'terraformproviders',
  'wordpress',
  'jetbrains',
  'openalex',
  'crossref',
  'europepmc',
  'uniprot',
  'clinicaltrials',
  'nvd',
  'coingecko',
  'internetarchive',
  'wikidata',
  'nominatim',
];

/** Default and maximum result budget for one source. */
export const DEFAULT_VERTICAL_LIMIT = 5;
/** Upper bound the tool and the adapters both respect. */
export const MAX_VERTICAL_LIMIT = 20;

/** The user agent every source sees. GitHub and crates.io both require one. */
const USER_AGENT =
  'dsh-web-search/0.15 (+https://github.com/fangchenghao/dsh-web-search)';

/** Scripts that make a query CJK rather than ASCII. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/** One vertical source definition. */
export interface VerticalSpec {
  /** Stable id, also what configuration and tool arguments name. */
  id: VerticalId;
  /** Human label used in failure messages and smoke output. */
  label: string;
  /** `Accept` header this endpoint serves. */
  accept: string;
  /**
   * Include this source in {@link DEFAULT_VERTICAL_IDS}. The original eight are
   * on by default; expanded sources set `false` so a bare `domain_search` stays
   * a cheap eight-request fan-out. A missing value counts as on.
   */
  defaultOn?: boolean;
  /**
   * Treat HTTP 404 as "no such record" rather than a failure. Only PyPI needs
   * this: its endpoint is an exact-package lookup, and a missing package is a
   * legitimate empty answer, not a broken source.
   */
  notFoundIsEmpty?: boolean;
  /** Absolute request URL for a query and result budget. */
  build: (query: string, limit: number) => string;
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>;
  /** Turn the served body into sources; must never throw on drift. */
  parse: (payload: string, finalUrl: string, limit: number) => Source[];
}

/** `fetch`-compatible function, injectable so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link searchVerticals}. */
export interface VerticalSearchOptions {
  /** Source ids to query; empty or absent means {@link DEFAULT_VERTICAL_IDS}. */
  ids?: readonly string[];
  /** Results wanted per source; clamped to 1…20. */
  limit?: number;
  /** Per-source deadline in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation, propagated to every source. */
  signal?: AbortSignal;
  /** Tunnel URL from the plugin's `proxy` setting, when configured. */
  proxy?: string;
  /** Test seam; defaults to the platform `fetch`. */
  fetch?: FetchLike;
  /** Publication window; arXiv switches to submitted-date order when set. */
  timeRange?: TimeRange;
}

/** What one vertical run reports. */
export interface VerticalOutcome {
  /** Merged, de-duplicated sources, capped at the caller's budget. */
  sources: Source[];
  /** One `id: reason` line per source that failed. */
  failures: string[];
  /** Parsed row count per source, before the global cap. */
  counts: Record<string, number>;
  /** Whether rows were dropped because of the global cap. */
  truncated: boolean;
}

/** True for a value usable as a JSON record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse JSON without throwing; `undefined` means "not JSON". */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** Read a string field, trimmed; anything else becomes the empty string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Turn one URL into a citable http(s) URL, or drop it. */
function webUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Strip markup and collapse whitespace, then bound the snippet length. */
function snippetOf(value: unknown, max = 400): string {
  const clean = text(value);
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/** Read a finite number, or `undefined`. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a scalar (string or number) as trimmed text; anything else is empty. */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const number = num(value);
  return number === undefined ? '' : String(number);
}

/** Turn unix seconds, milliseconds or a date string into a timestamp. */
function isoFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  const number = num(value);
  if (number === undefined) return undefined;
  const date = new Date(number > 1e12 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Read the first string of a `string | string[]` field. */
function firstText(value: unknown): string {
  return Array.isArray(value) ? str(value[0]) : str(value);
}

/** Join a `string | string[]` field into one plain-text line. */
function joinedText(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  return value
    .map((item) => text(item))
    .filter((item) => item.length > 0)
    .join(' ');
}

/** Read a Crossref `date-parts` stamp as `YYYY-MM-DD`. */
function crossrefDate(row: Record<string, unknown>): string | undefined {
  for (const key of ['published', 'published-print', 'published-online', 'issued', 'created']) {
    const stamp = row[key];
    if (!isRecord(stamp)) continue;
    const parts = stamp['date-parts'];
    if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue;
    const year = num(parts[0][0]);
    if (year === undefined) continue;
    const month = num(parts[0][1]);
    const day = num(parts[0][2]);
    const mm = month === undefined ? '01' : String(month).padStart(2, '0');
    const dd = day === undefined ? '01' : String(day).padStart(2, '0');
    return `${String(year).padStart(4, '0')}-${mm}-${dd}`;
  }
  return undefined;
}

/** Rebuild an OpenAlex abstract from its inverted index, in reading order. */
function openAlexAbstract(value: unknown): string {
  if (!isRecord(value)) return '';
  const words: { word: string; position: number }[] = [];
  for (const [word, positions] of Object.entries(value)) {
    if (!Array.isArray(positions) || word.trim().length === 0) continue;
    const position = positions.find(
      (item): item is number => typeof item === 'number' && Number.isFinite(item),
    );
    if (position === undefined) continue;
    words.push({ word: word.trim(), position });
  }
  words.sort((a, b) => a.position - b.position);
  return words.map((entry) => entry.word).join(' ');
}

/** Build one source, dropping rows that carry no citable URL. */
function sourceOf(
  rawUrl: unknown,
  title: string,
  snippet: string,
  publishedAt?: string,
): Source | undefined {
  const url = webUrl(rawUrl);
  if (url === undefined) return undefined;
  return {
    url,
    ...(title.length > 0 ? { title } : {}),
    ...(snippet.length > 0 ? { snippet } : {}),
    ...(publishedAt !== undefined && publishedAt.length > 0 ? { publishedAt } : {}),
  };
}

/** Clamp a caller budget into the range every adapter can serve. */
function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VERTICAL_LIMIT;
  return Math.max(1, Math.min(MAX_VERTICAL_LIMIT, Math.floor(value)));
}

/** Read one XML/Atom tag's text, with entities decoded. */
function tag(block: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  return match === null ? '' : text(match[1]);
}

/**
 * Parse GitHub's repository search envelope.
 * @param payload - `api.github.com/search/repositories` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns repositories as sources, in API order.
 */
export function parseGithub(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  const sources: Source[] = [];
  for (const row of body.items) {
    if (!isRecord(row)) continue;
    const name = str(row.full_name) || str(row.name);
    const license = isRecord(row.license) ? str(row.license.spdx_id) : '';
    const stars =
      typeof row.stargazers_count === 'number' && Number.isFinite(row.stargazers_count)
        ? `${row.stargazers_count} stars`
        : '';
    const snippet = [license, stars, snippetOf(row.description)].filter((part) => part.length > 0).join(' — ');
    const source = sourceOf(
      str(row.html_url) || (name.length > 0 ? `https://github.com/${name}` : undefined),
      name,
      snippet,
      str(row.pushed_at) || str(row.updated_at),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse npm's registry search envelope.
 * @param payload - `registry.npmjs.org/-/v1/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns packages as sources.
 */
export function parseNpm(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.objects)) return [];
  const sources: Source[] = [];
  for (const row of body.objects) {
    if (!isRecord(row) || !isRecord(row.package)) continue;
    const pkg = row.package;
    const name = str(pkg.name);
    if (name.length === 0) continue;
    const version = str(pkg.version);
    const links = isRecord(pkg.links) ? pkg.links : undefined;
    // `row.updated` is the search index's update time, not a publish time;
    // only `package.date` (and the legacy `row.date`) name the version time.
    const signature = version.length > 0 ? `${name}@${version}` : name;
    const source = sourceOf(
      str(links?.npm) || str(links?.homepage) || `https://www.npmjs.com/package/${name}`,
      signature,
      snippetOf(pkg.description),
      str(pkg.date) || str(row.date),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse PyPI's exact-package envelope.
 *
 * PyPI no longer publishes a credential-free search API, so the adapter asks
 * for the query as a package name. A 404 is handled by the orchestrator
 * (`notFoundIsEmpty`) and never reaches this parser; a body without `info`
 * still parses to `[]`.
 * @param payload - `pypi.org/pypi/<name>/json`.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (PyPI answers one).
 * @returns the package as one source, or `[]`.
 */
export function parsePypi(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  if (limit < 1) return [];
  const body = parseJson(payload);
  if (!isRecord(body) || !isRecord(body.info)) return [];
  const info = body.info;
  const name = str(info.name);
  if (name.length === 0) return [];
  const version = str(info.version);
  const urls = Array.isArray(body.urls) ? body.urls : [];
  const first = isRecord(urls[0]) ? urls[0] : undefined;
  const requires = str(info.requires_python);
  const snippet = [requires.length > 0 ? `Requires-Python: ${requires}` : '', snippetOf(info.summary)]
    .filter((part) => part.length > 0)
    .join(' — ');
  const source = sourceOf(
    str(info.package_url) || `https://pypi.org/project/${encodeURIComponent(name)}/`,
    version.length > 0 ? `${name} ${version}` : name,
    snippet,
    str(first?.upload_time_iso_8601) || str(first?.upload_time),
  );
  return source === undefined ? [] : [source];
}

/**
 * Parse the arXiv Atom feed.
 * @param payload - `export.arxiv.org/api/query` XML.
 * @param _url - request URL, unused by this XML shape.
 * @param limit - entries to keep.
 * @returns papers as sources, in feed order.
 */
export function parseArxiv(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  if (typeof payload !== 'string') return [];
  const sources: Source[] = [];
  for (const match of payload.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const block = match[1] ?? '';
    const id = tag(block, 'id');
    const title = tag(block, 'title');
    const summary = tag(block, 'summary');
    const published = tag(block, 'published') || tag(block, 'updated');
    // The feed's own id uses plain http; the canonical page is https.
    const page = id.replace(/^http:\/\//i, 'https://');
    const source = sourceOf(page, title, snippetOf(summary), published);
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Wikipedia's REST search envelope (zh or en host).
 * @param payload - `*.wikipedia.org/w/rest.php/v1/search/page` JSON.
 * @param finalUrl - the request URL, whose host decides the wiki language.
 * @param limit - pages to keep.
 * @returns wiki pages as sources.
 */
export function parseWikipedia(payload: string, finalUrl: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.pages)) return [];
  let language = 'en';
  try {
    if (new URL(finalUrl).hostname.startsWith('zh.')) language = 'zh';
  } catch {
    // Keep the English default; the parser still answers.
  }
  const sources: Source[] = [];
  for (const row of body.pages) {
    if (!isRecord(row)) continue;
    const key = str(row.key) || str(row.title);
    if (key.length === 0) continue;
    const title = str(row.title) || key;
    const excerpt = snippetOf(row.excerpt) || snippetOf(row.description);
    const page = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(key.replace(/ /g, '_'))}`;
    const source = sourceOf(page, title, excerpt);
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Hacker News's Algolia search envelope.
 * @param payload - `hn.algolia.com/api/v1/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - hits to keep.
 * @returns stories or comments as sources.
 */
export function parseHn(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.hits)) return [];
  const sources: Source[] = [];
  for (const row of body.hits) {
    if (!isRecord(row)) continue;
    const objectId = str(row.objectID);
    const fallback = objectId.length > 0 ? `https://news.ycombinator.com/item?id=${objectId}` : undefined;
    const highlighted = isRecord(row._highlightResult) && isRecord(row._highlightResult.title)
      ? row._highlightResult.title.value
      : undefined;
    const title = decodeEntities(str(row.title) || str(row.story_title) || snippetOf(highlighted, 120));
    const points = typeof row.points === 'number' && Number.isFinite(row.points) ? `${row.points} points` : '';
    const comments = typeof row.num_comments === 'number' && Number.isFinite(row.num_comments) ? `${row.num_comments} comments` : '';
    const body = decodeEntities(snippetOf(row.story_text) || snippetOf(row.comment_text));
    const snippet = [points, comments, body].filter((part) => part.length > 0).join(' — ');
    const source = sourceOf(str(row.url) || fallback, title, snippet, str(row.created_at));
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Stack Exchange's advanced-search envelope.
 * @param payload - `api.stackexchange.com/2.3/search/advanced` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - questions to keep.
 * @returns questions as sources.
 */
export function parseStackExchange(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  const sources: Source[] = [];
  for (const row of body.items) {
    if (!isRecord(row)) continue;
    const created = typeof row.creation_date === 'number' && Number.isFinite(row.creation_date)
      ? new Date(row.creation_date * 1000).toISOString()
      : undefined;
    const source = sourceOf(
      str(row.link),
      decodeEntities(str(row.title)),
      decodeEntities(snippetOf(row.body)),
      created,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse crates.io's crate search envelope.
 * @param payload - `crates.io/api/v1/crates` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - crates to keep.
 * @returns crates as sources.
 */
export function parseCrates(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.crates)) return [];
  const sources: Source[] = [];
  for (const row of body.crates) {
    if (!isRecord(row)) continue;
    const name = str(row.name);
    if (name.length === 0) continue;
    const version = str(row.max_version) || str(row.newest_version);
    const source = sourceOf(
      `https://crates.io/crates/${encodeURIComponent(name)}`,
      version.length > 0 ? `${name} ${version}` : name,
      snippetOf(row.description),
      str(row.updated_at),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse GitHub's issue-and-pull-request search envelope.
 * @param payload - `api.github.com/search/issues` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns issues and pull requests as sources, in API order.
 */
export function parseGithubIssues(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  const sources: Source[] = [];
  for (const row of body.items) {
    if (!isRecord(row)) continue;
    const source = sourceOf(
      row.html_url,
      str(row.title),
      snippetOf(row.body),
      str(row.created_at) || str(row.updated_at),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse GitLab's project search envelope.
 * @param payload - `gitlab.com/api/v4/projects` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns projects as sources.
 */
export function parseGitlab(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!Array.isArray(body)) return [];
  const sources: Source[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const name = str(row.path_with_namespace) || str(row.name);
    const source = sourceOf(str(row.web_url), name, snippetOf(row.description), str(row.last_activity_at));
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Codeberg's Gitea repository search envelope.
 * @param payload - `codeberg.org/api/v1/repos/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns repositories as sources.
 */
export function parseCodeberg(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const sources: Source[] = [];
  for (const row of body.data) {
    if (!isRecord(row)) continue;
    const name = str(row.full_name) || str(row.name);
    const source = sourceOf(str(row.html_url), name, snippetOf(row.description), str(row.updated_at));
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Docker Hub's repository search envelope.
 * @param payload - `hub.docker.com/v2/search/repositories` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns container repositories as sources.
 */
export function parseDockerHub(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const sources: Source[] = [];
  for (const row of body.results) {
    if (!isRecord(row)) continue;
    const name = str(row.repo_name);
    if (name.length === 0) continue;
    const stars = num(row.star_count);
    const pulls = num(row.pull_count);
    const meta = [
      stars === undefined ? '' : `${stars} stars`,
      pulls === undefined ? '' : `${pulls} pulls`,
    ].filter((value) => value.length > 0).join(' · ');
    const source = sourceOf(
      `https://hub.docker.com/r/${name}`,
      name,
      snippetOf(row.short_description) || meta,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Maven Central's Solr search envelope.
 * @param payload - `search.maven.org/solrsearch/select` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns artifacts as sources.
 */
export function parseMaven(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !isRecord(body.response) || !Array.isArray(body.response.docs)) return [];
  const sources: Source[] = [];
  for (const row of body.response.docs) {
    if (!isRecord(row)) continue;
    const group = str(row.g);
    const artifact = str(row.a);
    if (group.length === 0 || artifact.length === 0) continue;
    const version = str(row.latestVersion);
    const versions = num(row.versionCount);
    const source = sourceOf(
      `https://central.sonatype.com/artifact/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}`,
      version.length > 0 ? `${group}:${artifact} ${version}` : `${group}:${artifact}`,
      versions === undefined ? '' : `${versions} versions`,
      isoFrom(row.timestamp),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse NuGet's search envelope.
 * @param payload - `azuresearch-usnc.nuget.org/query` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns packages as sources.
 */
export function parseNuget(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const sources: Source[] = [];
  for (const row of body.data) {
    if (!isRecord(row)) continue;
    const name = str(row.id);
    if (name.length === 0) continue;
    const version = str(row.version);
    const downloads = num(row.totalDownloads);
    const source = sourceOf(
      `https://www.nuget.org/packages/${encodeURIComponent(name)}`,
      version.length > 0 ? `${name} ${version}` : name,
      snippetOf(row.description) || (downloads === undefined ? '' : `${downloads} downloads`),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse RubyGems' search envelope.
 * @param payload - `rubygems.org/api/v1/search.json` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns gems as sources.
 */
export function parseRubyGems(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!Array.isArray(body)) return [];
  const sources: Source[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const name = str(row.name);
    if (name.length === 0) continue;
    const version = str(row.version);
    const source = sourceOf(
      str(row.project_uri) || `https://rubygems.org/gems/${encodeURIComponent(name)}`,
      version.length > 0 ? `${name} ${version}` : name,
      snippetOf(row.info),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Packagist's search envelope.
 * @param payload - `packagist.org/search.json` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns Composer packages as sources.
 */
export function parsePackagist(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const sources: Source[] = [];
  for (const row of body.results) {
    if (!isRecord(row)) continue;
    const name = str(row.name);
    if (name.length === 0) continue;
    const source = sourceOf(
      str(row.url) || `https://packagist.org/packages/${name}`,
      name,
      snippetOf(row.description),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse pub.dev's package search envelope.
 * @param payload - `pub.dev/api/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns Dart packages as sources.
 */
export function parsePubDev(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.packages)) return [];
  const sources: Source[] = [];
  for (const row of body.packages) {
    if (!isRecord(row)) continue;
    const name = str(row.package);
    if (name.length === 0) continue;
    const source = sourceOf(`https://pub.dev/packages/${encodeURIComponent(name)}`, name, '');
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/** Shared parse for Hugging Face's model and dataset listings. */
function huggingFaceList(payload: string, limit: number, base: string): Source[] {
  const body = parseJson(payload);
  if (!Array.isArray(body)) return [];
  const sources: Source[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const id = str(row.id) || str(row.modelId);
    if (id.length === 0) continue;
    const likes = num(row.likes);
    const downloads = num(row.downloads);
    const meta = [
      str(row.pipeline_tag),
      downloads === undefined ? '' : `${downloads} downloads`,
      likes === undefined || likes === 0 ? '' : `${likes} likes`,
    ].filter((value) => value.length > 0).join(' · ');
    const source = sourceOf(
      `${base}/${id}`,
      id,
      snippetOf(row.description) || meta,
      str(row.createdAt) || str(row.lastModified),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Hugging Face's model search envelope.
 * @param payload - `huggingface.co/api/models` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns models as sources.
 */
export function parseHuggingFaceModels(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  return huggingFaceList(payload, limit, 'https://huggingface.co');
}

/**
 * Parse Hugging Face's dataset search envelope.
 * @param payload - `huggingface.co/api/datasets` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns datasets as sources.
 */
export function parseHuggingFaceDatasets(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  return huggingFaceList(payload, limit, 'https://huggingface.co/datasets');
}

/**
 * Parse the Open VSX extension search envelope.
 * @param payload - `open-vsx.org/api/-/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns extensions as sources.
 */
export function parseOpenVsx(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.extensions)) return [];
  const sources: Source[] = [];
  for (const row of body.extensions) {
    if (!isRecord(row)) continue;
    const namespace = str(row.namespace);
    const name = str(row.name);
    if (namespace.length === 0 || name.length === 0) continue;
    const version = str(row.version);
    const page = `https://open-vsx.org/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    const source = sourceOf(
      version.length > 0 ? `${page}/${encodeURIComponent(version)}` : page,
      str(row.displayName) || `${namespace}.${name}`,
      snippetOf(row.description),
      isoFrom(row.timestamp),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse the Terraform Registry module search envelope.
 * @param payload - `registry.terraform.io/v1/modules` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns registry modules as sources.
 */
export function parseTerraformModules(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.modules)) return [];
  const sources: Source[] = [];
  for (const row of body.modules) {
    if (!isRecord(row)) continue;
    const namespace = str(row.namespace);
    const name = str(row.name);
    if (namespace.length === 0 || name.length === 0) continue;
    const provider = str(row.provider);
    const version = str(row.version);
    const page = [
      'https://registry.terraform.io/modules',
      encodeURIComponent(namespace),
      encodeURIComponent(name),
      encodeURIComponent(provider.length > 0 ? provider : 'latest'),
      encodeURIComponent(version.length > 0 ? version : 'latest'),
    ].join('/');
    const label = [namespace, name, provider].filter((value) => value.length > 0).join('/');
    const source = sourceOf(
      page,
      version.length > 0 ? `${label} ${version}` : label,
      snippetOf(row.description),
      str(row.published_at),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse the Terraform Registry provider search envelope.
 * @param payload - `registry.terraform.io/v1/providers` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns registry providers as sources.
 */
export function parseTerraformProviders(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.providers)) return [];
  const sources: Source[] = [];
  for (const row of body.providers) {
    if (!isRecord(row)) continue;
    const namespace = str(row.namespace);
    const name = str(row.name);
    if (namespace.length === 0 || name.length === 0) continue;
    const version = str(row.version);
    const page = [
      'https://registry.terraform.io/providers',
      encodeURIComponent(namespace),
      encodeURIComponent(name),
      encodeURIComponent(version.length > 0 ? version : 'latest'),
    ].join('/');
    const label = `${namespace}/${name}`;
    const source = sourceOf(
      page,
      version.length > 0 ? `${label} ${version}` : label,
      snippetOf(row.description),
      str(row.published_at),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse WordPress.org's plugin search envelope.
 * @param payload - `api.wordpress.org/plugins/info/1.2` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns plugins as sources.
 */
export function parseWordpress(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.plugins)) return [];
  const sources: Source[] = [];
  for (const row of body.plugins) {
    if (!isRecord(row)) continue;
    const slug = str(row.slug);
    const name = text(row.name);
    if (slug.length === 0 || name.length === 0) continue;
    const version = str(row.version);
    const source = sourceOf(
      `https://wordpress.org/plugins/${encodeURIComponent(slug)}/`,
      version.length > 0 ? `${name} ${version}` : name,
      snippetOf(row.short_description),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse the JetBrains Marketplace plugin search envelope.
 * @param payload - `plugins.jetbrains.com/api/searchPlugins` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns plugins as sources.
 */
export function parseJetbrains(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.plugins)) return [];
  const sources: Source[] = [];
  for (const row of body.plugins) {
    if (!isRecord(row)) continue;
    const name = str(row.name);
    const link = str(row.link);
    if (name.length === 0 || link.length === 0) continue;
    const page = `https://plugins.jetbrains.com${link.startsWith('/') ? link : `/${link}`}`;
    const source = sourceOf(page, name, snippetOf(row.preview), isoFrom(row.cdate));
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse OpenAlex's work search envelope.
 * @param payload - `api.openalex.org/works` JSON (`select`ed fields).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns works as sources.
 */
export function parseOpenAlex(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const sources: Source[] = [];
  for (const row of body.results) {
    if (!isRecord(row)) continue;
    const primary = isRecord(row.primary_location) ? row.primary_location : undefined;
    const venueRecord = primary !== undefined && isRecord(primary.source) ? primary.source : undefined;
    const venue = venueRecord === undefined ? '' : str(venueRecord.display_name);
    const year = num(row.publication_year);
    const meta = [
      str(row.type),
      venue,
      year === undefined ? '' : String(year),
    ].filter((value) => value.length > 0).join(' · ');
    const title = str(row.display_name) || str(row.title);
    if (title.length === 0) continue;
    const source = sourceOf(
      str(row.doi) || str(row.id) || (primary === undefined ? '' : str(primary.landing_page_url)),
      title,
      snippetOf(openAlexAbstract(row.abstract_inverted_index)) || snippetOf(meta),
      str(row.publication_date) || (year === undefined ? undefined : String(year)),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Crossref's work search envelope.
 * @param payload - `api.crossref.org/works` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns DOIs as sources.
 */
export function parseCrossref(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !isRecord(body.message) || !Array.isArray(body.message.items)) return [];
  const sources: Source[] = [];
  for (const row of body.message.items) {
    if (!isRecord(row)) continue;
    const doi = str(row.DOI);
    const title = firstText(row.title) || doi;
    if (title.length === 0) continue;
    const published = crossrefDate(row);
    const source = sourceOf(
      str(row.URL) || (doi.length > 0 ? `https://doi.org/${doi}` : undefined),
      title,
      snippetOf(row.abstract) || snippetOf(joinedText(row['container-title'])) || snippetOf(row.type),
      published,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Europe PMC's search envelope.
 * @param payload - `ebi.ac.uk/europepmc/webservices/rest/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns articles and preprints as sources.
 */
export function parseEuropepmc(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !isRecord(body.resultList) || !Array.isArray(body.resultList.result)) return [];
  const sources: Source[] = [];
  for (const row of body.resultList.result) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const doi = str(row.doi);
    const database = str(row.source) || 'MED';
    const fallback = id.length > 0
      ? `https://europepmc.org/article/${encodeURIComponent(database)}/${encodeURIComponent(id)}`
      : undefined;
    const title = text(row.title);
    if (title.length === 0) continue;
    const source = sourceOf(
      doi.length > 0 ? `https://doi.org/${doi}` : fallback,
      title,
      snippetOf(row.abstractText),
      str(row.firstPublicationDate) || str(row.pubYear),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse UniProt's protein search envelope.
 * @param payload - `rest.uniprot.org/uniprotkb/search` JSON (`select`ed fields).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns protein records as sources.
 */
export function parseUniprot(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.results)) return [];
  const sources: Source[] = [];
  for (const row of body.results) {
    if (!isRecord(row)) continue;
    const accession = str(row.primaryAccession);
    if (accession.length === 0) continue;
    const description = isRecord(row.proteinDescription) ? row.proteinDescription : undefined;
    const recommended = description !== undefined && isRecord(description.recommendedName)
      ? description.recommendedName
      : undefined;
    const fullName = recommended !== undefined && isRecord(recommended.fullName)
      ? str(recommended.fullName.value)
      : '';
    const organism = isRecord(row.organism) ? str(row.organism.scientificName) : '';
    const length = isRecord(row.sequence) ? num(row.sequence.length) : undefined;
    const meta = [organism, length === undefined ? '' : `${length} aa`]
      .filter((value) => value.length > 0)
      .join(' · ');
    const source = sourceOf(
      `https://www.uniprot.org/uniprotkb/${encodeURIComponent(accession)}/entry`,
      fullName.length > 0 ? `${fullName} (${accession})` : accession,
      meta,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse ClinicalTrials.gov's study search envelope.
 * @param payload - `clinicaltrials.gov/api/v2/studies` JSON (`fields` narrowed).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns trials as sources.
 */
export function parseClinicaltrials(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.studies)) return [];
  const sources: Source[] = [];
  for (const row of body.studies) {
    if (!isRecord(row) || !isRecord(row.protocolSection)) continue;
    const protocol = row.protocolSection;
    const identification = isRecord(protocol.identificationModule) ? protocol.identificationModule : undefined;
    const trialId = identification === undefined ? '' : str(identification.nctId);
    if (trialId.length === 0) continue;
    const status = isRecord(protocol.statusModule) ? protocol.statusModule : undefined;
    const summary = isRecord(protocol.descriptionModule) ? protocol.descriptionModule : undefined;
    const start = status !== undefined && isRecord(status.startDateStruct)
      ? str(status.startDateStruct.date)
      : '';
    const title = identification !== undefined ? str(identification.briefTitle) : '';
    const overallStatus = status === undefined ? '' : str(status.overallStatus);
    const source = sourceOf(
      `https://clinicaltrials.gov/study/${encodeURIComponent(trialId)}`,
      title.length > 0 ? title : trialId,
      snippetOf(summary === undefined ? '' : summary.briefSummary)
        || (overallStatus.length > 0 ? `Status: ${overallStatus}` : ''),
      start,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse NVD's CVE search envelope.
 * @param payload - `services.nvd.nist.gov/rest/json/cves/2.0` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns CVEs as sources.
 */
export function parseNvd(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.vulnerabilities)) return [];
  const sources: Source[] = [];
  for (const row of body.vulnerabilities) {
    if (!isRecord(row) || !isRecord(row.cve)) continue;
    const cve = row.cve;
    const id = str(cve.id);
    if (id.length === 0) continue;
    const descriptions = Array.isArray(cve.descriptions) ? cve.descriptions : [];
    const english = descriptions.find((item) => isRecord(item) && str(item.lang) === 'en');
    const chosen = isRecord(english) ? english : descriptions.find((item) => isRecord(item));
    const description = isRecord(chosen) ? snippetOf(chosen.value) : '';
    const source = sourceOf(
      `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`,
      id,
      description,
      str(cve.published),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse CoinGecko's coin search envelope.
 * @param payload - `api.coingecko.com/api/v3/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends no row cap; rows are capped).
 * @returns coins as sources.
 */
export function parseCoinGecko(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.coins)) return [];
  const sources: Source[] = [];
  for (const row of body.coins) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    if (id.length === 0) continue;
    const symbol = str(row.symbol);
    const rank = num(row.market_cap_rank);
    const meta = [
      symbol.length > 0 ? `$${symbol}` : '',
      rank === undefined ? '' : `rank #${rank}`,
    ].filter((value) => value.length > 0).join(' · ');
    const source = sourceOf(
      `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
      str(row.name) || id,
      meta,
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse the Internet Archive's advanced-search envelope.
 * @param payload - `archive.org/advancedsearch.php` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns archive items as sources.
 */
export function parseInternetarchive(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !isRecord(body.response) || !Array.isArray(body.response.docs)) return [];
  const sources: Source[] = [];
  for (const row of body.response.docs) {
    if (!isRecord(row)) continue;
    const identifier = scalarText(row.identifier);
    if (identifier.length === 0) continue;
    const source = sourceOf(
      `https://archive.org/details/${encodeURIComponent(identifier)}`,
      joinedText(row.title) || identifier,
      joinedText(row.description),
      scalarText(row.year),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Wikidata's entity search envelope.
 * @param payload - `www.wikidata.org/w/api.php?action=wbsearchentities` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns entities as sources.
 */
export function parseWikidata(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!isRecord(body) || !Array.isArray(body.search)) return [];
  const sources: Source[] = [];
  for (const row of body.search) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    if (id.length === 0) continue;
    let page = str(row.url);
    if (page.startsWith('//')) page = `https:${page}`;
    const concept = str(row.concepturi).replace(/^http:/i, 'https:');
    const source = sourceOf(
      page || concept || `https://www.wikidata.org/wiki/${encodeURIComponent(id)}`,
      str(row.label) || id,
      str(row.description),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/**
 * Parse Nominatim's place search envelope.
 * @param payload - `nominatim.openstreetmap.org/search?format=jsonv2` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns places as sources.
 */
export function parseNominatim(payload: string, _url: string, limit = MAX_VERTICAL_LIMIT): Source[] {
  const body = parseJson(payload);
  if (!Array.isArray(body)) return [];
  const sources: Source[] = [];
  for (const row of body) {
    if (!isRecord(row)) continue;
    const osmType = str(row.osm_type);
    const osmId = scalarText(row.osm_id);
    if (osmType.length === 0 || osmId.length === 0) continue;
    const display = str(row.display_name);
    const first = display.split(',')[0]?.trim() ?? '';
    const source = sourceOf(
      `https://www.openstreetmap.org/${encodeURIComponent(osmType)}/${encodeURIComponent(osmId)}`,
      str(row.name) || first || osmId,
      display || [str(row.category), str(row.type)].filter((value) => value.length > 0).join('/'),
    );
    if (source !== undefined) sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}

/** A source id that this module actually knows. */
export function isVerticalId(value: unknown): value is VerticalId {
  return typeof value === 'string' && (VERTICAL_IDS as readonly string[]).includes(value);
}

/** Every adapter, keyed by id. */
export const VERTICALS: readonly VerticalSpec[] = [
  {
    id: 'github',
    label: 'GitHub',
    accept: 'application/vnd.github+json',
    headers: { 'x-github-api-version': '2022-11-28' },
    defaultOn: true,
    build: (query, limit) =>
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
    parse: parseGithub,
  },
  {
    id: 'npm',
    label: 'npm',
    accept: 'application/json',
    defaultOn: true,
    build: (query, limit) =>
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
    parse: parseNpm,
  },
  {
    id: 'pypi',
    label: 'PyPI',
    accept: 'application/json',
    notFoundIsEmpty: true,
    defaultOn: true,
    // PyPI has no credential-free search API. The first token is the package
    // name; a descriptive query (`requests http`) still resolves `requests`.
    build: (query, _limit) => {
      const name = query.trim().split(/\s+/)[0] ?? query.trim();
      return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    },
    parse: parsePypi,
  },
  {
    id: 'arxiv',
    label: 'arXiv',
    accept: 'application/atom+xml',
    defaultOn: true,
    build: (query, limit) =>
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`,
    parse: parseArxiv,
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    accept: 'application/json',
    defaultOn: true,
    build: (query, limit) => {
      const language = CJK.test(query) ? 'zh' : 'en';
      return `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`;
    },
    parse: parseWikipedia,
  },
  {
    id: 'hn',
    label: 'Hacker News',
    accept: 'application/json',
    defaultOn: true,
    build: (query, limit) =>
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`,
    parse: parseHn,
  },
  {
    id: 'stackexchange',
    label: 'Stack Exchange',
    accept: 'application/json',
    defaultOn: true,
    build: (query, limit) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}&filter=withbody`,
    parse: parseStackExchange,
  },
  {
    id: 'crates',
    label: 'crates.io',
    accept: 'application/json',
    defaultOn: true,
    build: (query, limit) =>
      `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}`,
    parse: parseCrates,
  },
  // Code hosts: repositories, issues and merge requests.
  {
    id: 'githubissues',
    label: 'GitHub issues',
    accept: 'application/vnd.github+json',
    headers: { 'x-github-api-version': '2022-11-28' },
    defaultOn: false,
    build: (query, limit) =>
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}`,
    parse: parseGithubIssues,
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://gitlab.com/api/v4/projects?search=${encodeURIComponent(query)}&per_page=${limit}`,
    parse: parseGitlab,
  },
  {
    id: 'codeberg',
    label: 'Codeberg',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://codeberg.org/api/v1/repos/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    parse: parseCodeberg,
  },
  // Package, container, model and extension registries.
  {
    id: 'dockerhub',
    label: 'Docker Hub',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(query)}&page_size=${limit}`,
    parse: parseDockerHub,
  },
  {
    id: 'maven',
    label: 'Maven Central',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(query)}&rows=${limit}&wt=json`,
    parse: parseMaven,
  },
  {
    id: 'nuget',
    label: 'NuGet',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://azuresearch-usnc.nuget.org/query?q=${encodeURIComponent(query)}&take=${limit}`,
    parse: parseNuget,
  },
  {
    id: 'rubygems',
    label: 'RubyGems',
    accept: 'application/json',
    defaultOn: false,
    // RubyGems answers a fixed page; the parser caps it at `limit`.
    build: (query) => `https://rubygems.org/api/v1/search.json?query=${encodeURIComponent(query)}`,
    parse: parseRubyGems,
  },
  {
    id: 'packagist',
    label: 'Packagist',
    accept: 'application/json',
    defaultOn: false,
    // Packagist answers a fixed page; the parser caps it at `limit`.
    build: (query) => `https://packagist.org/search.json?q=${encodeURIComponent(query)}`,
    parse: parsePackagist,
  },
  {
    id: 'pubdev',
    label: 'pub.dev',
    accept: 'application/json',
    defaultOn: false,
    // pub.dev answers a fixed page; the parser caps it at `limit`.
    build: (query) => `https://pub.dev/api/search?q=${encodeURIComponent(query)}`,
    parse: parsePubDev,
  },
  {
    id: 'huggingface',
    label: 'Hugging Face models',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${limit}`,
    parse: parseHuggingFaceModels,
  },
  {
    id: 'hfdatasets',
    label: 'Hugging Face datasets',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://huggingface.co/api/datasets?search=${encodeURIComponent(query)}&limit=${limit}`,
    parse: parseHuggingFaceDatasets,
  },
  {
    id: 'openvsx',
    label: 'Open VSX',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://open-vsx.org/api/-/search?query=${encodeURIComponent(query)}&size=${limit}`,
    parse: parseOpenVsx,
  },
  {
    id: 'terraform',
    label: 'Terraform Registry',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://registry.terraform.io/v1/modules?q=${encodeURIComponent(query)}&limit=${limit}`,
    parse: parseTerraformModules,
  },
  {
    id: 'terraformproviders',
    label: 'Terraform providers',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://registry.terraform.io/v1/providers?q=${encodeURIComponent(query)}&limit=${limit}`,
    parse: parseTerraformProviders,
  },
  {
    id: 'wordpress',
    label: 'WordPress plugins',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://api.wordpress.org/plugins/info/1.2/?action=query_plugins&request%5Bsearch%5D=${encodeURIComponent(query)}&request%5Bper_page%5D=${limit}`,
    parse: parseWordpress,
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Marketplace',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://plugins.jetbrains.com/api/searchPlugins?search=${encodeURIComponent(query)}&max=${limit}`,
    parse: parseJetbrains,
  },
  // Papers and life-science records.
  {
    id: 'openalex',
    label: 'OpenAlex',
    accept: 'application/json',
    defaultOn: false,
    // `select` keeps the response to the fields the parser reads.
    build: (query, limit) =>
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=id,display_name,doi,publication_year,publication_date,type,primary_location,abstract_inverted_index`,
    parse: parseOpenAlex,
  },
  {
    id: 'crossref',
    label: 'Crossref',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`,
    parse: parseCrossref,
  },
  {
    id: 'europepmc',
    label: 'Europe PMC',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${limit}`,
    parse: parseEuropepmc,
  },
  {
    id: 'uniprot',
    label: 'UniProt',
    accept: 'application/json',
    defaultOn: false,
    // `fields` keeps the response to the fields the parser reads.
    build: (query, limit) =>
      `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=${limit}&fields=accession,id,protein_name,organism_name,length`,
    parse: parseUniprot,
  },
  {
    id: 'clinicaltrials',
    label: 'ClinicalTrials.gov',
    accept: 'application/json',
    defaultOn: false,
    // `fields` keeps the response to the fields the parser reads.
    build: (query, limit) =>
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}&pageSize=${limit}&fields=NCTId,BriefTitle,BriefSummary,OverallStatus,StartDate`,
    parse: parseClinicaltrials,
  },
  // Structured data: vulnerabilities, coins, archive, entities and places.
  {
    id: 'nvd',
    label: 'NVD',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(query)}&resultsPerPage=${limit}`,
    parse: parseNvd,
  },
  {
    id: 'coingecko',
    label: 'CoinGecko',
    accept: 'application/json',
    defaultOn: false,
    // CoinGecko has no row cap; the parser caps the answer at `limit`.
    build: (query) => `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
    parse: parseCoinGecko,
  },
  {
    id: 'internetarchive',
    label: 'Internet Archive',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=year&rows=${limit}&output=json`,
    parse: parseInternetarchive,
  },
  {
    id: 'wikidata',
    label: 'Wikidata',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) => {
      const language = CJK.test(query) ? 'zh' : 'en';
      return `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&format=json&limit=${limit}`;
    },
    parse: parseWikidata,
  },
  {
    id: 'nominatim',
    label: 'OpenStreetMap Nominatim',
    accept: 'application/json',
    defaultOn: false,
    build: (query, limit) =>
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${limit}`,
    parse: parseNominatim,
  },
];

/** One adapter by id, or `undefined` for a typo. */
export function verticalById(id: string): VerticalSpec | undefined {
  return VERTICALS.find((spec) => spec.id === id);
}

/**
 * Sources queried when the caller names none.
 *
 * The original eight answer by default; every expanded source is
 * `defaultOn: false`. Fanning a bare tool call out to all of
 * {@link VERTICAL_IDS} would spend the whole GitHub unauthenticated search
 * budget in one request and make the common case slow, so participation is
 * declared per spec rather than implied by membership.
 */
export const DEFAULT_VERTICAL_IDS: readonly VerticalId[] = VERTICAL_IDS.filter(
  (id) => verticalById(id)?.defaultOn !== false,
);

/** Classify a non-2xx status into the shared business codes. */
function statusError(status: number): SearchError {
  if (status === 429) return new SearchError('HTTP 429', 'SEARCH_THROTTLED');
  if (status === 403) return new SearchError('HTTP 403', 'SEARCH_BLOCKED');
  if (status >= 500) return new SearchError(`HTTP ${status}`, 'SEARCH_NETWORK');
  if (status === 0) return new SearchError('no response', 'SEARCH_NETWORK');
  return new SearchError(`HTTP ${status}`, 'SEARCH_BLOCKED');
}

/** Classify a thrown transport failure. */
function thrownError(error: unknown): SearchError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
    return new SearchError(message, 'SEARCH_TIMEOUT');
  }
  return new SearchError(message, 'SEARCH_NETWORK');
}

/** Combine the caller signal with this request's own deadline. */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}

/**
 * Ask one source once and return its payload.
 *
 * Non-2xx answers become {@link SearchError}; a 404 for a source marked
 * `notFoundIsEmpty` is returned as an empty payload so the parser reports "no
 * such record" instead of the run reporting a broken source.
 * @param spec - the adapter.
 * @param url - absolute request URL.
 * @param options - deadline, cancellation, optional tunnel and fetch seam.
 * @returns the response body, or `''` for an accepted 404.
 */
async function fetchPayload(
  spec: VerticalSpec,
  url: string,
  options: VerticalSearchOptions,
  timeoutMs: number,
): Promise<string> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: spec.accept,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...spec.headers,
  };
  let status = 0;
  let payload = '';
  try {
    if (options.proxy !== undefined && options.proxy.length > 0) {
      const response = await proxyGet(url, {
        proxy: options.proxy,
        headers,
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      status = response.status;
      payload = response.text;
    } else {
      const send = options.fetch ?? fetch;
      const response = await send(url, {
        headers,
        redirect: 'follow',
        signal: deadline(timeoutMs, options.signal),
      });
      status = response.status;
      payload = response.ok ? await response.text() : '';
    }
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw thrownError(error);
  }
  if (status === 404 && spec.notFoundIsEmpty === true) return '';
  if (status < 200 || status >= 300) throw statusError(status);
  return payload;
}

/** Render one failure as `id: reason`, without doubling an existing id. */
function failureText(id: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${id}: `) ? message : `${id}: ${message}`;
}

/**
 * Query every requested vertical concurrently and merge the answers.
 *
 * One source failing never fails the run: its reason is recorded in
 * `failures`, its count stays `0`, and the other sources still answer. Answers
 * are interleaved by rank (one row from each source, then the second row from
 * each) so a single prolific source cannot crowd the others out.
 *
 * @param query - what to search for; must be non-empty.
 * @param options - sources, budget, deadline, cancellation, tunnel, fetch seam.
 * @returns merged sources plus per-source counts and failures.
 * @throws SearchError `SEARCH_ABORTED` when the caller cancelled the run.
 */
export async function searchVerticals(
  query: string,
  options: VerticalSearchOptions = {},
): Promise<VerticalOutcome> {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed.length === 0) return { sources: [], failures: [], counts: {}, truncated: false };
  const limit = clampLimit(options.limit);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 8000;
  const requested = (options.ids ?? []).filter(isVerticalId);
  const selected = requested.length > 0
    ? VERTICAL_IDS.filter((id) => requested.includes(id))
    : DEFAULT_VERTICAL_IDS;
  const specs = selected
    .map((id) => verticalById(id))
    .filter((spec): spec is VerticalSpec => spec !== undefined);

  const answers = await Promise.all(
    specs.map(async (spec) => {
      try {
        const built = spec.build(trimmed, limit);
        const url = spec.id === 'arxiv' && options.timeRange !== undefined && options.timeRange !== 'off'
          ? `${built.replace(/search_query=all:([^&]*)/u, 'search_query=all:%22$1%22')}&sortBy=submittedDate&sortOrder=descending`
          : built;
        const payload = await fetchPayload(spec, url, options, timeoutMs);
        const sources = spec.parse(payload, url, limit);
        return { id: spec.id, sources };
      } catch (error) {
        return { id: spec.id, failure: failureText(spec.id, error) };
      }
    }),
  );

  if (options.signal?.aborted === true) {
    throw new SearchError('domain search was cancelled', 'SEARCH_ABORTED', false);
  }

  const counts: Record<string, number> = {};
  const failures: string[] = [];
  let sourceRanks = 0;
  for (const answer of answers) {
    counts[answer.id] = 'sources' in answer ? answer.sources.length : 0;
    if ('sources' in answer) sourceRanks = Math.max(sourceRanks, answer.sources.length);
    if ('failure' in answer) failures.push(answer.failure);
  }

  const merged: Source[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < sourceRanks; rank += 1) {
    for (const answer of answers) {
      if (!('sources' in answer)) continue;
      const source = answer.sources[rank];
      if (source === undefined || seen.has(source.url)) continue;
      seen.add(source.url);
      merged.push(source);
    }
  }
  return {
    sources: merged.slice(0, limit),
    failures,
    counts,
    truncated: merged.length > limit,
  };
}
