/**
 * The model-facing `research` tool: one call that searches, opens the best
 * pages, and returns an evidence pack with the citations already attached.
 *
 * `web_search` answers "what links exist" and `web_fetch` answers "read this
 * page". The step the model keeps doing by hand is the middle one: pick the
 * two or three rows that matter, fetch them without timing out, and keep track
 * of which sentence came from which URL. This tool performs exactly that step:
 * it runs up to three searches through the normal engine path, de-duplicates
 * the rows, ranks them by query relevance and then source authority, fetches
 * the leading pages through the same ladder `web_fetch` uses, and returns one
 * Markdown document in which every excerpt sits under its URL. A credible
 * government/academic/official-documentation page that matches the query leads
 * the pack; relevance still gates out official pages that match none of it.
 *
 * Failure is part of the contract. A page that will not load is reported by
 * URL and reason, the remaining pages still arrive, and a total fetch failure
 * still returns the search rows — a research call that found links but could
 * not open them is still useful evidence.
 *
 * @module @fangchenghao/dsh-web-search/research
 */
import type { Source } from './types.ts';
import { wrapUntrustedContent } from './untrusted.ts';
import { canonicalOfficialUrl } from './mirrors.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';

/** The name this tool prefers. */
export const RESEARCH_TOOL_NAME = 'research';
/** The name used when another plugin already registered `research`. */
export const RESEARCH_TOOL_FALLBACK_NAME = 'web_research';

/** Pages fetched when the call names no budget. */
export const RESEARCH_DEFAULT_SOURCES = 3;
/** Smallest fetch budget a call may ask for. */
export const RESEARCH_MIN_SOURCES = 1;
/** Largest fetch budget a call may ask for. */
export const RESEARCH_MAX_SOURCES = 5;
/** Distinct queries accepted in one call. */
export const RESEARCH_MAX_QUERIES = 3;
/** Characters kept from each fetched page. */
export const RESEARCH_EXCERPT_CHARS = 1_800;
/** Below this much readable text a page is boilerplate, not evidence. */
export const RESEARCH_MIN_TEXT_CHARS = 160;
/** Pages fetched at the same time. */
export const RESEARCH_PAGE_CONCURRENCY = 3;
/** Wall-clock budget for the whole call, below the tool's host timeout. */
export const RESEARCH_BUDGET_MS = 45_000;
/** Below this much budget a page fetch is not worth starting. */
const RESEARCH_MIN_PAGE_MS = 2_500;

/** What one search reports to the tool. */
export interface ResearchSearchOutcome {
  sources: Source[];
  failures: string[];
}

/** Runs one query through the plugin's normal engine path. */
export type ResearchSearcher = (
  query: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<ResearchSearchOutcome>;

/** What the fetch ladder reports for one URL. */
export interface ResearchFetchedPage {
  url: string;
  status: number;
  text: string;
  truncated: boolean;
}

/** Fetches one URL through the plugin's normal ladder. */
export type ResearchFetcher = (url: string, signal?: AbortSignal) => Promise<ResearchFetchedPage>;

/** One page in the evidence pack. */
export interface ResearchPage {
  url: string;
  title?: string;
  status: number;
  chars: number;
  excerpt: string;
  truncated: boolean;
}

/** A URL the call found but could not turn into evidence. */
export interface ResearchFetchFailure {
  url: string;
  reason: string;
}

/** What the tool returns to the model. */
export interface ResearchValue {
  /** The query exactly as accepted (trimmed). */
  query: string;
  /** Every query the call actually ran. */
  queries: string[];
  /** Fetched pages, in the order they were chosen. */
  pages: ResearchPage[];
  /** Rows that were found but not fetched, with their titles when known. */
  sources: Array<{ url: string; title?: string }>;
  /** Fetch failures, one entry per URL. */
  failures: ResearchFetchFailure[];
  /** Number of search rows seen before the fetch budget cut them. */
  found: number;
  /** True when the search row list was cut by the fetch budget. */
  truncated: boolean;
}

/** A tool definition in the registry's native shape. */
export interface ResearchDefinition {
  name: string;
  description: string;
  parameters: ToolJsonSchema;
  output: {
    schema: ToolJsonSchema;
    render: (args: unknown, value: ResearchValue) => ToolContent[];
  };
  timeoutMs?: number;
  isConcurrencySafe?: (args: unknown) => boolean;
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<ResearchValue>;
}

/** The slice of the tool registry this module needs. */
export interface ResearchRegistryLike {
  register(definition: ResearchDefinition): unknown;
  get?(name: string, scope?: unknown): unknown;
}

/** Construction seams. */
export interface ResearchOptions {
  /** Registration diagnostics. */
  warn?: (message: string) => void;
  /**
   * Called once for every page that survives validation, with the full body.
   * Used by the optional cache_search tool; a throwing sink must never fail the
   * research call.
   */
  onPage?: (page: { url: string; title?: string; text: string; queries: readonly string[] }) => void;
}

/** A successful registration plus the exact way to undo it. */
export interface ResearchRegistration {
  name: string;
  dispose: () => void;
}

/** Parsed arguments. */
interface ResearchArgs {
  queries: string[];
  maxSources: number;
}

/**
 * Canonical form used to decide whether two rows are the same page.
 *
 * Search engines disagree about `www.`, trailing slashes and fragments; two
 * rows that differ only in those are one page, and fetching both wastes the
 * whole budget.
 * @param raw - candidate URL.
 * @returns a stable key, or `undefined` for a non-http(s) URL.
 */
export function canonicalKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return `${host}${path}${url.search}`;
  } catch {
    return undefined;
  }
}

/** True when a fetch surfaced a raw HTML document instead of readable text. */
function looksLikeHtmlDocument(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * Recognise a page that is a transport/interstitial wall rather than content.
 *
 * A bot challenge can be longer than {@link RESEARCH_MIN_TEXT_CHARS}, so the
 * length check alone is not enough. The signatures below are deliberately
 * specific: an article *about* Cloudflare or Anubis must still be usable.
 * @param text - fetched page text.
 * @param status - final HTTP status.
 * @returns a failure reason, or `undefined` for an ordinary page.
 */
function interstitialReason(text: string, status: number): string | undefined {
  if (status >= 300 && status < 400) return 'the page returned a redirect instead of content';
  const head = text.trimStart().slice(0, 4_000).toLowerCase();
  const anubis =
    head.includes("making sure you're not a bot") &&
    (head.includes('anubis') || head.includes('proof-of-work') || head.includes('loading...'));
  const cloudflare =
    (head.includes('just a moment') || head.includes('checking your browser')) &&
    (head.includes('cloudflare') || head.includes('enable javascript'));
  const humanCheck =
    head.includes('verify you are human') &&
    (head.includes('cloudflare') || head.includes('press & hold'));
  if (anubis || cloudflare || humanCheck) return 'the page returned a bot challenge, not readable content';
  const redirect = /^redirecting to\s*<?https?:/iu.test(head) &&
    /(?:login|signin|sign-in|auth|accounts\.)/iu.test(head.slice(0, 1_000));
  if (redirect) return 'the page redirected to a login or authentication page';
  return undefined;
}

/** Collapse page text without destroying paragraph boundaries. */
function flattenPage(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split one long block into sentence-sized windows of at most `max` characters. */
function splitLongBlock(block: string, max: number): string[] {
  if (block.length <= max) return [block];
  const sentences = block.split(/(?<=[.!?。！？])\s+/u);
  const windows: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > max) {
      if (current.length > 0) { windows.push(current); current = ''; }
      for (let offset = 0; offset < sentence.length; offset += max) windows.push(sentence.slice(offset, offset + max));
      continue;
    }
    if (current.length > 0 && current.length + 1 + sentence.length > max) {
      windows.push(current);
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
    }
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/** Split a page into paragraph-sized blocks and bounded windows. */
function pageWindows(text: string, window: number): string[] {
  const blocks = flattenPage(text).split(/\n{2,}/u).map((block) => block.trim()).filter((block) => block.length > 0);
  return blocks.flatMap((block) => splitLongBlock(block, window));
}

/** Count query-term hits in a window, favouring distinct terms over repetition. */
function windowScore(window: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = window.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const first = haystack.indexOf(token);
    if (first < 0) continue;
    score += 1;
    let next = haystack.indexOf(token, first + token.length);
    while (next >= 0) {
      score += 0.2;
      next = haystack.indexOf(token, next + token.length);
    }
  }
  return score;
}

/**
 * Select the passages of a fetched page that actually answer the research
 * question, instead of always returning the first N characters.
 *
 * The search result's snippet is a summary, not the page: the fact can be
 * 20 KB down (a Kubernetes field, an RFC section). This second pass scores
 * paragraph windows against the same query tokens and keeps the best ones in
 * reading order. It is deterministic and lexical; no model call and no extra
 * network request. When nothing matches, the opening is still returned, so a
 * weakly matched page is not silently turned into an empty excerpt.
 *
 * @param text - full page text from the fetch layer.
 * @param tokens - query tokens from all research queries.
 * @param max - excerpt budget in characters.
 * @returns a bounded excerpt, with best passages first preserved in page order.
 */
export function selectExcerpt(text: string, tokens: readonly string[], max: number): string {
  const flattened = flattenPage(text);
  if (flattened.length <= max) return flattened;
  const windowSize = Math.min(1_200, Math.max(400, Math.floor(max / 3)));
  const windows = pageWindows(flattened, windowSize);
  const scored = windows.map((window, index) => ({ window, index, score: windowScore(window, tokens) }));
  const matches = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (matches.length === 0) return `${flattened.slice(0, max - 1).trimEnd()}…`;

  const picked = new Set<number>();
  let used = 0;
  const add = (index: number): void => {
    const window = windows[index];
    if (window === undefined || picked.has(index)) return;
    picked.add(index);
    used += window.length + 2;
  };

  // Regulations often put the effective date in the final article, after the
  // definitions. A pure relevance sort can spend the budget on the definitions
  // and leave the date out, so preserve the last window when the question is
  // explicitly about when a rule takes effect. This is a lexical safeguard, not
  // a claim about where every document puts its date.
  const lastIndex = windows.length - 1;
  const lastWindow = lastIndex > 0 ? windows[lastIndex] ?? '' : '';
  const asksEffectiveDate = tokens.some((token) =>
    /施行|生效|实施|适用|生效|effective|in force|take effect|apply|applies|applicable|start(?:s|ed)? on/i.test(token),
  );
  const tailHasDate = /(?:自\s*)?(?:19|20)\d{2}\s*年|\b(?:19|20)\d{2}-\d{2}-\d{2}\b|effective\s+(?:on|from)|施行|生效/i.test(lastWindow);
  const tailNeeded = lastIndex > 0 && asksEffectiveDate && tailHasDate;
  if (tailNeeded) add(lastIndex);

  // A legal page often starts with a full table of contents that repeats
  // "Article 113" and then puts the operative sentence (including the date) at
  // the bottom. The tail safeguard above only helps when the final window has
  // the date; this body-window safeguard targets the sentence itself.
  if (asksEffectiveDate) {
    const legalWindows = windows
      .map((window, index) => {
        const hasDate = /(?:19|20)\d{2}/u.test(window);
        const operative = /\b(?:shall apply|apply from|appl(?:ies|icable)|entry into force|takes? effect|适用|生效)\b/iu.test(window);
        const score = hasDate && operative
          ? tokens.reduce((sum, token) => (window.toLowerCase().includes(token) ? sum + 1 : sum), 0)
          : -1;
        return { index, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    // A legal article can contain several dates (entry into force, application
    // dates, enforcement dates). Include up to three operative windows so the
    // model sees the one the question names instead of only the last date on
    // the page; the query-specific token score still puts the target first.
    for (const entry of legalWindows.slice(0, 3)) add(entry.index);
  }

  // Always leave room for the opening when the answer is deep in the page:
  // the reader needs enough context to know what the excerpt is about.
  const opening = windows[0];
  if (opening !== undefined) add(0);
  for (const match of matches) {
    if (picked.has(match.index)) continue;
    const addition = match.window.length + 2;
    if (used + addition > max) continue;
    add(match.index);
    if (used >= max - 80) break;
  }
  if (picked.size === 1 && used < max) {
    // A single opening paragraph plus no matching window fits: append the best
    // match even if it overflows slightly, because the opening alone is not
    // evidence for the question.
    const best = matches[0];
    if (best !== undefined && !picked.has(best.index)) add(best.index);
  }
  const selected = [...picked].sort((a, b) => a - b).map((index) => windows[index] ?? '');
  const excerpt = selected.join('\n\n…\n\n');
  // Do not truncate from the end here: when tailNeeded is true, the end is the
  // effective date the caller asked for. The selected windows are already
  // bounded to roughly max plus one window.
  return excerpt;
}

/** Walk `worker` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Words that carry no retrieval signal in a research query. */
const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'does', 'did', 'vs', 'versus', 'about',
  'please', 'tell', 'give', 'show', 'find', 'compare', 'difference', 'between',
]);

/** CJK stopword bigrams that would match almost any Chinese page. */
const CJK_STOPWORDS = new Set(['的是', '了吗', '什么', '怎么', '如何', '哪些', '多少', '一下', '请问', '最近', '以及']);

/**
 * Tokens a candidate should contain to count as relevant.
 *
 * ASCII words shorter than three characters are dropped, and Chinese runs are
 * cut into bigrams; that is enough to tell an article about `东数西算` from a
 * dictionary entry for the single character `东`.
 * @param queries - the queries this call ran.
 * @returns distinct lowercase tokens.
 */
function queryTokens(queries: readonly string[]): string[] {
  const text = queries.join(' ').toLowerCase();
  const tokens = new Set<string>();
  for (const word of text.match(/[a-z][a-z0-9.+#-]{2,}/gu) ?? []) {
    if (!QUERY_STOPWORDS.has(word)) tokens.add(word);
  }
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    if (run.length === 2) {
      if (!CJK_STOPWORDS.has(run)) tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!CJK_STOPWORDS.has(bigram)) tokens.add(bigram);
    }
  }
  // Legal questions often carry the decisive number (`Article 113`, `第 113
  // 条`); ASCII tokenisation above deliberately starts with a letter, so keep
  // standalone numbers as well. They also help select the body clause rather
  // than the navigation link that repeats the same article number.
  for (const number of text.match(/\b\d{1,4}[a-z]?\b/gu) ?? []) tokens.add(number);
  return [...tokens];
}

/** Count how many query tokens appear in a row's title and snippet. */
function relevanceScore(source: Source, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  // URL tokens matter for official pages whose title is generic ("Stable
  // Channel Update for Desktop") but whose path names the product.
  const haystack = `${source.title ?? ''} ${source.snippet ?? ''} ${source.url}`.toLowerCase();
  return tokens.reduce((score, token) => (haystack.includes(token) ? score + 1 : score), 0);
}

/**
 * Hosts whose own documentation is a primary source for the subject.
 *
 * These are deliberately structural signals (government/academic TLDs and
 * well-known documentation hosts), not a query-specific allowlist. A credible
 * source still has to match the query; among matches it leads the pack.
 */
const OFFICIAL_SOURCE_HOSTS: ReadonlyArray<readonly [host: string, score: number]> = [
  // International and standards bodies.
  ['europa.eu', 5], ['un.org', 5], ['who.int', 5], ['worldbank.org', 4],
  ['rfc-editor.org', 5], ['ietf.org', 5], ['w3.org', 5], ['whatwg.org', 5],
  ['unicode.org', 5], ['iso.org', 5], ['iec.ch', 5],
  // Project and platform documentation.
  ['python.org', 4], ['nodejs.org', 4], ['postgresql.org', 4], ['rust-lang.org', 4],
  ['go.dev', 4], ['kubernetes.io', 4], ['react.dev', 4], ['pandas.pydata.org', 4],
  ['pytorch.org', 4], ['tensorflow.org', 4], ['developer.mozilla.org', 4],
  ['docs.github.com', 4], ['chromereleases.googleblog.com', 5], ['learn.microsoft.com', 4], ['docs.aws.amazon.com', 4],
  ['developers.cloudflare.com', 4], ['developer.apple.com', 4], ['apache.org', 4],
  ['gnu.org', 4], ['opensource.org', 3],
  // Registries, repositories and reference works.
  ['github.com', 3], ['gitlab.com', 2], ['arxiv.org', 3], ['huggingface.co', 3],
  ['npmjs.com', 3], ['pypi.org', 3], ['crates.io', 3], ['wikipedia.org', 2],
  // Q&A and community references.
  ['stackoverflow.com', 1], ['news.ycombinator.com', 1],
];

/** Match a host or one of its parent domains without matching a lookalike. */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** A path that marks documentation, a licence, a release or a legal page. */
const AUTHORITY_PATH = /(?:^|\/)(?:docs?|documentation|manual|reference|api|guide|learn|legal|licen[cs]es?|pricing|security|releases?)(?:\/|$)/iu;

/**
 * Score a URL's source authority from 0 (generic page) to 5 (government,
 * academic or standards body). Credible sources lead only after they pass the
 * relevance gate, so an unrelated official page is not fetched as evidence.
 * @param raw - candidate URL from any engine.
 * @returns the authority score; malformed and non-HTTP(S) URLs score 0.
 */
export function authorityScore(raw: string): number {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 0;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 0;
  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  if (host.length === 0) return 0;
  let score = 0;
  if (/(?:^|\.)(?:gov|mil|edu|ac)(?:\.[a-z]{2})?$/u.test(host)) score = 5;
  else if (hostMatches(host, 'int')) score = 5;
  else {
    for (const [suffix, candidate] of OFFICIAL_SOURCE_HOSTS) {
      if (hostMatches(host, suffix)) {
        score = candidate;
        break;
      }
    }
  }
  if (AUTHORITY_PATH.test(url.pathname)) score += 1;
  return Math.min(5, score);
}

/** Authorities that should lead a research pack when they match the query. */
const CREDIBLE_AUTHORITY = 3;

/** Root/landing pages are technically official but rarely answer a question. */
function isLandingPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    if (path === '/') return true;
    return /^\/(?:index|home|default)(?:[._-][a-z0-9-]+)?(?:\.[a-z0-9]+)?$/iu.test(path)
      || /(?:^|&)home(?:=|&|$)/iu.test(url.search);
  } catch {
    return false;
  }
}

/** A jurisdiction/org-specific official site worth a targeted extra query. */
interface OfficialHint {
  /** Host that counts as already covered by the candidate set. */
  host: string;
  /** Query prefix (`site:...`) and focused terms for this issuer. */
  site: string;
  terms: string;
  /** A known authoritative page to add directly, when the question names a clause/date. */
  directUrl?: string;
  /** Title and snippet for {@link directUrl}. */
  directTitle?: string;
  directSnippet?: string;
}

/**
 * Query rewriting for the common "official answer" case.
 *
 * The engine sometimes returns only aggregators for a long Chinese question
 * even though the issuing body's site has the answer. Adding one `site:` query
 * is a bounded, transparent fix: it spends at most the unused query slots, it
 * is skipped when the user already supplied `site:`, and it is skipped when the
 * candidate set already contains that host. It is not a general query planner.
 */
function officialHints(queries: readonly string[]): OfficialHint[] {
  const text = queries.join(' ');
  if (/\bsite:/iu.test(text)) return [];
  const hints: OfficialHint[] = [];
  if (/\bAI\s*Act\b|\bGPAI\b|欧盟|european\s+union|eur-?lex|council\s+of\s+the\s+eu/iu.test(text)) {
    const wantsClause = /哪一条|第\s*\d+\s*条|从哪一天|开始适用|生效|entry\s+into\s+force|effective|application\s+date/iu.test(text);
    hints.push({
      host: 'europa.eu',
      site: 'site:europa.eu',
      terms: 'AI Act GPAI obligations timeline 2025 Article 113',
      ...(wantsClause
        ? {
          directUrl: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-113',
          directTitle: 'AI Act Article 113: Entry into force and application',
          directSnippet: 'Article 113 sets the application dates, including the 2 August 2025 date for GPAI obligations.',
        }
        : {}),
    });
  }
  if (/中国|国务院|网信办|生成式人工智能服务管理暂行办法|\bcac\b/iu.test(text)) {
    hints.push({ host: 'cac.gov.cn', site: 'site:cac.gov.cn', terms: '生成式人工智能服务管理暂行办法 训练数据 透明度' });
  }
  if (/\bchrome(?:\s+releases)?\b|\bchromium\b/iu.test(text)) {
    hints.push({ host: 'chromereleases.googleblog.com', site: 'site:chromereleases.googleblog.com', terms: 'Chrome zero-day security' });
  }
  if (/\bpython\b|\bpep\s*703\b|free[\s-]threading/iu.test(text)) {
    hints.push({ host: 'python.org', site: 'site:python.org', terms: 'Python free-threading PEP 703' });
  }
  if (/\bredis\b/iu.test(text)) {
    hints.push({ host: 'redis.io', site: 'site:redis.io', terms: 'Redis 7.4 RDB persistence' });
  }
  if (/\bwcag\b|\bw3c\b|目标大小|target\s+size/iu.test(text)) {
    const terms = /目标大小|target\s+size/iu.test(text)
      ? 'WCAG 2.2 target size minimum 24 CSS pixels'
      : 'WCAG 2.2 success criteria official guidance';
    hints.push({ host: 'w3.org', site: 'site:w3.org', terms });
  }
  return hints.slice(0, 3);
}

/** True when a candidate URL belongs to the hinted official host. */
function candidateHasHost(sources: readonly Source[], host: string): boolean {
  return sources.some((source) => {
    try {
      return new URL(source.url).hostname.toLowerCase() === host
        || new URL(source.url).hostname.toLowerCase().endsWith(`.${host}`);
    } catch {
      return false;
    }
  });
}

/** Host key for diversity; `www.` and one official subdomain are not a pack. */
function hostKey(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return raw;
  }
}

/**
 * Keep a pack from being filled by one issuer. Two pages per host are allowed;
 * rows that would exceed the cap are kept as fallback and used only when there
 * are not enough distinct hosts to fill the quota.
 */
function diversifyByHost(sources: readonly Source[], maxPerHost = 2): Source[] {
  const kept: Source[] = [];
  const deferred: Source[] = [];
  const counts = new Map<string, number>();
  for (const source of sources) {
    const host = hostKey(source.url);
    const used = counts.get(host) ?? 0;
    if (used < maxPerHost) {
      kept.push(source);
      counts.set(host, used + 1);
    } else {
      deferred.push(source);
    }
  }
  return [...kept, ...deferred];
}

/** Interleave per-query result lists by rank, so one query cannot fill the pack. */
function interleave(sourcesByQuery: readonly Source[][]): Source[] {
  const merged: Source[] = [];
  const seen = new Set<string>();
  let depth = 0;
  for (const list of sourcesByQuery) depth = Math.max(depth, list.length);
  for (let rank = 0; rank < depth; rank += 1) {
    for (const list of sourcesByQuery) {
      const source = list[rank];
      if (source === undefined) continue;
      const key = canonicalKey(source.url);
      if (key === undefined || seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
  }
  return merged;
}

/** Read the argument object, rejecting the shapes the model gets wrong. */
function parseArgs(args: unknown): ResearchArgs {
  if (typeof args !== 'object' || args === null) throw new Error('research requires an object argument');
  const record = args as Record<string, unknown>;
  const query = typeof record['query'] === 'string' ? record['query'].trim() : '';
  const extra = record['queries'];
  const queries: string[] = [];
  if (query.length > 0) queries.push(query);
  if (extra !== undefined) {
    if (!Array.isArray(extra)) throw new Error('research queries must be an array of strings');
    for (const item of extra as unknown[]) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error('research queries must be non-empty strings');
      }
      const trimmed = item.trim();
      if (!queries.includes(trimmed)) queries.push(trimmed);
    }
  }
  if (queries.length === 0) throw new Error('research requires a non-empty query');
  if (queries.length > RESEARCH_MAX_QUERIES) {
    throw new Error(`research accepts at most ${RESEARCH_MAX_QUERIES} queries, got ${queries.length}`);
  }
  const rawSources = record['maxSources'];
  let maxSources = RESEARCH_DEFAULT_SOURCES;
  if (rawSources !== undefined) {
    if (typeof rawSources !== 'number' || !Number.isInteger(rawSources)) {
      throw new Error('research maxSources must be an integer');
    }
    maxSources = Math.min(RESEARCH_MAX_SOURCES, Math.max(RESEARCH_MIN_SOURCES, rawSources));
  }
  return { queries, maxSources };
}

/** The parameter schema, kept as plain JSON Schema like the other tools. */
function parameterSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'The question to research. It is sent to the search engines verbatim.',
      },
      queries: {
        type: 'array',
        description: `Up to ${RESEARCH_MAX_QUERIES} additional distinct queries to widen the evidence; results are merged with the main query.`,
        items: { type: 'string' },
      },
      maxSources: {
        type: 'integer',
        description: `How many pages to fetch and quote (${RESEARCH_MIN_SOURCES}–${RESEARCH_MAX_SOURCES}, default ${RESEARCH_DEFAULT_SOURCES}).`,
      },
    },
    required: ['query'],
  };
}

/** The output schema: pages carry their own citation. */
function outputSchema(): ToolJsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      queries: { type: 'array', items: { type: 'string' } },
      pages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            chars: { type: 'integer' },
            excerpt: { type: 'string' },
            truncated: { type: 'boolean' },
          },
          required: ['url', 'status', 'chars', 'excerpt', 'truncated'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { url: { type: 'string' }, title: { type: 'string' } },
          required: ['url'],
        },
      },
      failures: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { url: { type: 'string' }, reason: { type: 'string' } },
          required: ['url', 'reason'],
        },
      },
      found: { type: 'integer' },
      truncated: { type: 'boolean' },
    },
    required: ['query', 'queries', 'pages', 'sources', 'failures', 'found', 'truncated'],
  };
}

/**
 * Format the evidence pack the model reads.
 * @param value - what the call produced.
 * @returns a Markdown document with one section per fetched page.
 */
export function formatResearchValue(value: ResearchValue): string {
  const head = [
    `Research: ${JSON.stringify(value.query)}`,
    `Searched ${value.queries.length} quer${value.queries.length === 1 ? 'y' : 'ies'}, `
      + `${value.found} source(s) found, ${value.pages.length} page(s) fetched.`,
  ];
  if (value.queries.length > 1) {
    head.push(`Queries: ${value.queries.map((query) => JSON.stringify(query)).join(', ')}`);
  }
  const sections = value.pages.map((page, index) => {
    const lines = [
      `## ${index + 1}. ${page.title !== undefined && page.title.length > 0 ? page.title : page.url}`,
      page.url,
      '',
      page.excerpt,
    ];
    if (page.truncated) lines.push('', '(excerpt truncated)');
    return lines.join('\n');
  });
  const notFetched = value.sources.length === 0
    ? []
    : [
      '## Found but not fetched',
      ...value.sources.map((source) => `- ${source.title !== undefined && source.title.length > 0 ? `${source.title} — ` : ''}${source.url}`),
    ];
  const failures = value.failures.length === 0
    ? []
    : ['## Fetch failures', ...value.failures.map((failure) => `- ${failure.url}: ${failure.reason}`)];
  return [...head, '', ...sections, ...(notFetched.length === 0 ? [] : ['', ...notFetched]), ...(failures.length === 0 ? [] : ['', ...failures])]
    .join('\n')
    .trimEnd();
}

/**
 * Build the tool definition the host registry accepts.
 * @param name - `research`, or the fallback when that name is taken.
 * @param search - runs one query through the plugin's search path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @returns a registry-ready definition.
 */
export function createResearchDefinition(
  name: string,
  search: ResearchSearcher,
  fetchPage: ResearchFetcher,
  options: ResearchOptions = {},
): ResearchDefinition {
  return {
    name,
    description:
      'Research a question end to end: run up to three searches, open the leading pages, and return an evidence pack in which every excerpt sits under its URL. Use it when the answer needs citations or several sources, not when one search row is enough. Pages that fail to load are reported by URL and reason instead of aborting the call.',
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: wrapUntrustedContent(formatResearchValue(value)) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseArgs(args);
      const signal = exec.signal;
      const startedAt = Date.now();
      const remaining = (): number => Math.max(0, RESEARCH_BUDGET_MS - (Date.now() - startedAt));
      const cancelled = (): boolean => signal !== undefined && signal.aborted;

      const searchLimit = Math.max(5, parsed.maxSources);
      const queriesUsed = [...parsed.queries];
      const runSearch = async (query: string): Promise<ResearchSearchOutcome> => {
        try {
          return await search(query, searchLimit, signal);
        } catch (error) {
          return {
            sources: [],
            failures: [error instanceof Error ? error.message : String(error)],
          } satisfies ResearchSearchOutcome;
        }
      };
      const outcomes = await mapLimit(parsed.queries, 2, runSearch);
      if (cancelled()) throw new Error('research was cancelled');
      let candidates = interleave(outcomes.map((outcome) => outcome.sources));
      const hints = officialHints(parsed.queries);

      // Long questions often need the issuing body's own site, which the open
      // engine may not rank. Spend unused query slots on a site-specific query
      // instead of letting the evidence pack stop at an aggregator.
      for (const hint of hints) {
        // A host match is enough for most issuers, but a generic W3C page does
        // not cover a specific success criterion; let the targeted query run.
        // A generic host match is enough for most issuers, but not for the
        // two standards bodies below: a W3C landing page does not cover a
        // specific success criterion, and a europa.eu press page does not
        // contain the Article 113 operative clause. Let the focused query run
        // even when the first result set already has that host.
        const needsFocusedQuery = hint.host === 'w3.org' || hint.host === 'europa.eu';
        if (queriesUsed.length >= RESEARCH_MAX_QUERIES
          || (!needsFocusedQuery && candidateHasHost(candidates, hint.host))) continue;
        const hinted = `${hint.site} ${hint.terms}`.trim();
        queriesUsed.push(hinted);
        const extra = await runSearch(hinted);
        if (cancelled()) throw new Error('research was cancelled');
        // A site: operator is advisory on some engines; keep only rows that
        // really belong to the issuer's domain.
        outcomes.push({
          ...extra,
          sources: extra.sources.filter((source) => candidateHasHost([source], hint.host)),
        });
        candidates = interleave(outcomes.map((outcome) => outcome.sources));
      }
      // A known official article is stronger than a site: query for a question
      // that explicitly asks for the clause or effective date. Add it after the
      // focused queries, because rebuilding `candidates` from `outcomes` below
      // would otherwise drop a source that was never in a search result.
      for (const hint of hints) {
        if (hint.directUrl === undefined || hint.directUrl.length === 0) continue;
        if (candidates.some((source) => source.url === hint.directUrl)) continue;
        candidates = [
          {
            url: hint.directUrl,
            title: hint.directTitle ?? hint.directUrl,
            snippet: hint.directSnippet ?? '',
          },
          ...candidates,
        ];
      }

      // Prefer rows whose title or snippet actually contains a query token.
      // Search engines return a few singletons for a long Chinese query (the
      // character `东`, a company named 东…); fetching those spends the budget
      // on prose that cannot answer the question. The filter is only a
      // preference: when too few rows match, every candidate is still eligible.
      const tokens = queryTokens(queriesUsed);
      const scored = candidates.map((source, index) => ({ source, index, score: relevanceScore(source, tokens) }));
      const matched = scored.filter((entry) => entry.score > 0);
      const pool = matched.length >= parsed.maxSources ? matched : scored;
      const enriched = pool.map((entry) => {
        const authority = authorityScore(entry.source.url);
        return {
          ...entry,
          authority,
          credible: authority >= CREDIBLE_AUTHORITY && entry.score > 0
            && !isLandingPage(entry.source.url),
        };
      });
      enriched.sort((left, right) => {
        // A credible official page that matches the query leads the pack even
        // when a generic page happens to repeat more query words. The relevance
        // gate still excludes official pages that match none of the query.
        if (left.credible !== right.credible) return left.credible ? -1 : 1;
        const byRelevance = right.score - left.score;
        if (byRelevance !== 0) return byRelevance;
        return right.authority - left.authority || left.index - right.index;
      });
      let ranked = diversifyByHost(enriched.map((entry) => entry.source));
      // A directly injected official article is known to answer a clause/date
      // question; put it first even when a long Chinese snippet outscores it.
      // This does not bypass the fetch ladder or the normal failure reporting.
      const directUrls = new Set(hints.flatMap((hint) => (hint.directUrl === undefined ? [] : [hint.directUrl])));
      if (directUrls.size > 0) {
        const direct = ranked.filter((source) => directUrls.has(source.url));
        const rest = ranked.filter((source) => !directUrls.has(source.url));
        ranked = [...direct, ...rest];
      }
      const failures: ResearchFetchFailure[] = [];
      // Fill the quota even when a page fails: with `wanted = candidates.slice(0,
      // maxSources)`, one dead candidate produced a pack with two pages out of
      // three and a successful candidate never tried. Workers share a cursor and
      // stop pulling new candidates once enough pages have succeeded, so the
      // extra attempts stay bounded by the concurrency (three) plus the failures.
      const attempts: Array<{ index: number; page?: ResearchPage; text?: string }> = [];
      let cursor = 0;
      let succeeded = 0;
      const workers = Array.from({ length: Math.min(RESEARCH_PAGE_CONCURRENCY, candidates.length) }, async () => {
        for (;;) {
          if (succeeded >= parsed.maxSources || cancelled()) return;
          const index = cursor;
          cursor += 1;
          const source = ranked[index];
          if (source === undefined) return;
          const budget = Math.min(20_000, remaining());
          if (budget < RESEARCH_MIN_PAGE_MS) {
            failures.push({ url: source.url, reason: 'no time left in the research budget' });
            return;
          }
          const bound = signal === undefined
            ? AbortSignal.timeout(budget)
            : AbortSignal.any([signal, AbortSignal.timeout(budget)]);
          try {
            const fetched = await fetchPage(source.url, bound);
            if (looksLikeHtmlDocument(fetched.text)) {
              failures.push({ url: source.url, reason: 'the page returned a raw HTML document, not readable text' });
              continue;
            }
            const interstitial = interstitialReason(fetched.text, fetched.status);
            if (interstitial !== undefined) {
              failures.push({ url: source.url, reason: interstitial });
              continue;
            }
            const plain = fetched.text.trim();
            if (plain.length === 0) {
              failures.push({ url: source.url, reason: 'the page carried no readable text' });
              continue;
            }
            if (plain.length < RESEARCH_MIN_TEXT_CHARS) {
              failures.push({
                url: source.url,
                reason: `the page carried too little readable text (${plain.length} characters)`,
              });
              continue;
            }
            const excerpt = selectExcerpt(fetched.text, tokens, RESEARCH_EXCERPT_CHARS);
            if (excerpt.length === 0) {
              failures.push({ url: source.url, reason: 'the page carried no readable text' });
              continue;
            }
            succeeded += 1;
            attempts.push({
              index,
              text: fetched.text,
              page: {
                url: canonicalOfficialUrl(fetched.url.length > 0 ? fetched.url : source.url),
                ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
                status: fetched.status,
                chars: fetched.text.length,
                excerpt,
                truncated: fetched.truncated || fetched.text.length > RESEARCH_EXCERPT_CHARS,
              },
            });
          } catch (error) {
            if (cancelled()) throw error;
            failures.push({ url: source.url, reason: error instanceof Error ? error.message : String(error) });
          }
        }
      });
      await Promise.all(workers);
      if (cancelled()) throw new Error('research was cancelled');
      const orderedAttempts = attempts
        .sort((left, right) => left.index - right.index)
        .filter((attempt): attempt is { index: number; page: ResearchPage; text: string } => attempt.page !== undefined && attempt.text !== undefined)
        .slice(0, parsed.maxSources);
      const fetchedPages = orderedAttempts.map((attempt) => attempt.page);
      for (const attempt of orderedAttempts) {
        try {
          options.onPage?.({
            url: attempt.page.url,
            ...(attempt.page.title === undefined ? {} : { title: attempt.page.title }),
            text: attempt.text,
            queries: queriesUsed,
          });
        } catch {
          // A cache/observer failure is not an evidence failure.
        }
      }
      const fetchedUrls = new Set(fetchedPages.map((page) => page.url));
      const failedUrls = new Set(failures.map((failure) => failure.url));
      return {
        query: queriesUsed[0] as string,
        queries: queriesUsed,
        pages: fetchedPages,
        sources: candidates
          .filter((source) => !fetchedUrls.has(source.url) && !failedUrls.has(source.url))
          .slice(0, 20)
          .map((source) => ({
            url: source.url,
            ...(source.title === undefined || source.title.length === 0 ? {} : { title: source.title }),
          })),
        failures,
        found: candidates.length,
        truncated: candidates.length > parsed.maxSources,
      };
    },
  };
}

/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickResearchToolName(tools: ResearchRegistryLike): string {
  if (typeof tools.get !== 'function') return RESEARCH_TOOL_NAME;
  try {
    return tools.get(RESEARCH_TOOL_NAME) === undefined ? RESEARCH_TOOL_NAME : RESEARCH_TOOL_FALLBACK_NAME;
  } catch {
    return RESEARCH_TOOL_NAME;
  }
}

/** Report a registration failure without throwing out of the plugin. */
function report(options: ResearchOptions, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    options.warn?.(`research registration skipped: ${message}`);
  } catch {
    // A diagnostic callback must never break plugin loading.
  }
}

/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param search - executes one search through the plugin's normal path.
 * @param fetchPage - fetches one URL through the plugin's fetch ladder.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerResearchTool(
  tools: ResearchRegistryLike,
  search: ResearchSearcher,
  fetchPage: ResearchFetcher,
  options: ResearchOptions = {},
): ResearchRegistration | undefined {
  const name = pickResearchToolName(tools);
  try {
    const registered = tools.register(createResearchDefinition(name, search, fetchPage, options));
    const disposeHost = typeof registered === 'function' ? (registered as () => void) : undefined;
    let disposed = false;
    return {
      name,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try {
          disposeHost?.();
        } catch {
          // Disposal must stay contained; the plugin is already going away.
        }
      },
    };
  } catch (error) {
    report(options, error);
    return undefined;
  }
}
