import { filterByTimeRange } from "./freshness.js";
import { proxyGet } from "./proxy.js";
import { text } from "./parsers.js";
/** Chrome Releases' public Blogger feed, newest first. */
export const CHROME_RELEASES_FEED_URL = 'https://chromereleases.googleblog.com/feeds/posts/default?alt=json&max-results=30';
/** Default deadline for one feed read. */
const DEFAULT_TIMEOUT_MS = 8_000;
/** Largest number of feed entries requested. */
const FEED_LIMIT = 30;
/** True for a query that is specifically about a Chrome release/security post. */
export function isChromeSecurityQuery(query) {
    if (typeof query !== 'string')
        return false;
    const value = query.trim();
    if (!/\b(?:chrome|chromium)\b/i.test(value))
        return false;
    return /(?:zero[- ]?day|0[- ]?day|security|vulnerab|漏洞|安全|安全博客|releases?|发布|公告)/i.test(value);
}
/** Read one nested string field from the Blogger JSON envelope. */
function nested(value, key) {
    if (typeof value !== 'object' || value === null)
        return '';
    const candidate = value[key];
    if (typeof candidate === 'string')
        return candidate;
    if (typeof candidate === 'object' && candidate !== null) {
        const textValue = candidate['$t'];
        return typeof textValue === 'string' ? textValue : '';
    }
    return '';
}
/** Find the canonical post URL, not the comment-feed URL. */
function postUrl(entry) {
    const links = Array.isArray(entry['link']) ? entry['link'] : [];
    for (const candidate of links) {
        if (typeof candidate !== 'object' || candidate === null)
            continue;
        const link = candidate;
        const href = typeof link['href'] === 'string' ? link['href'] : '';
        if (!href.startsWith('https://'))
            continue;
        if (link['rel'] === 'alternate')
            return href;
    }
    return '';
}
/** Normalize Blogger's timestamp; malformed entries are dropped. */
function postDate(raw) {
    if (raw.length === 0)
        return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
/**
 * Read the version, fix count and CVE severity distribution from a post body.
 *
 * Chrome release posts put the useful facts below the opening paragraph, past
 * the point where a short search snippet usually cuts off. Extracting them here
 * keeps the snippet useful without pretending the feed is a CVE database.
 *
 * @param plain - the post content converted to plain text.
 * @returns only the fields the post actually states.
 */
export function chromeSecuritySummary(plain) {
    const summary = {};
    const version = /\b(\d{2,3}\.\d+\.\d+\.\d+(?:\/\.?\d+)?)\b/.exec(plain);
    if (version?.[1] !== undefined)
        summary.version = version[1];
    const total = /(?:includes?|contains?)\s+(\d[\d,]*)\s+security\s+fix(?:es)?/i.exec(plain);
    if (total?.[1] !== undefined) {
        const parsed = Number.parseInt(total[1].replaceAll(',', ''), 10);
        if (Number.isFinite(parsed))
            summary.total = parsed;
    }
    const severity = new Map();
    for (const match of plain.matchAll(/\b(Critical|High|Medium|Low)\s+CVE-\d{4}-\d+/gi)) {
        const key = (match[1] ?? '').toLowerCase();
        severity.set(key, (severity.get(key) ?? 0) + 1);
    }
    const critical = severity.get('critical');
    const high = severity.get('high');
    const medium = severity.get('medium');
    const low = severity.get('low');
    if (critical !== undefined)
        summary.critical = critical;
    if (high !== undefined)
        summary.high = high;
    if (medium !== undefined)
        summary.medium = medium;
    if (low !== undefined)
        summary.low = low;
    return summary;
}
/** Build a compact snippet that puts the release facts before the prose. */
function chromeSnippet(plain) {
    const summary = chromeSecuritySummary(plain);
    const facts = [];
    if (summary.version !== undefined)
        facts.push(`version ${summary.version}`);
    if (summary.total !== undefined)
        facts.push(`${summary.total} security fix(es)`);
    const severity = [
        summary.critical === undefined ? undefined : `Critical ${summary.critical}`,
        summary.high === undefined ? undefined : `High ${summary.high}`,
        summary.medium === undefined ? undefined : `Medium ${summary.medium}`,
        summary.low === undefined ? undefined : `Low ${summary.low}`,
    ].filter((part) => part !== undefined);
    if (severity.length > 0)
        facts.push(`listed severity: ${severity.join(' / ')}`);
    const prefix = facts.length === 0 ? '' : `${facts.join('; ')}. `;
    const body = plain.length > Math.max(200, 400 - prefix.length)
        ? `${plain.slice(0, Math.max(200, 400 - prefix.length)).trimEnd()}…`
        : plain;
    return `${prefix}${body}`.trim();
}
/**
 * Parse the Chrome Releases JSON feed.
 *
 * The parser is intentionally tolerant: a feed shape change (or a non-JSON
 * maintenance page) yields an empty list instead of making the caller fail.
 *
 * @param payload - the feed body.
 * @param limit - maximum posts to keep.
 * @returns posts with their real publication timestamps, newest first.
 */
export function parseChromeReleases(payload, limit = FEED_LIMIT) {
    if (typeof payload !== 'string' || payload.trim().length === 0)
        return [];
    let body;
    try {
        body = JSON.parse(payload);
    }
    catch {
        return [];
    }
    const feed = typeof body === 'object' && body !== null
        ? body['feed']
        : undefined;
    const entries = typeof feed === 'object' && feed !== null
        ? feed['entry']
        : undefined;
    if (!Array.isArray(entries))
        return [];
    const sources = [];
    for (const raw of entries) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const entry = raw;
        const url = postUrl(entry);
        if (url.length === 0)
            continue;
        const title = text(nested(entry['title'], '$t')).trim();
        const content = nested(entry['content'], '$t') || nested(entry['summary'], '$t');
        const plain = text(content).replace(/\s+/gu, ' ').trim();
        const snippet = chromeSnippet(plain);
        const publishedAt = postDate(nested(entry['published'], '$t'));
        if (title.length === 0 && snippet.length === 0)
            continue;
        sources.push({
            url,
            ...(title.length > 0 ? { title } : {}),
            ...(snippet.length > 0 ? { snippet: snippet.length > 400 ? `${snippet.slice(0, 400).trimEnd()}…` : snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
        if (sources.length >= Math.max(1, Math.min(FEED_LIMIT, limit)))
            break;
    }
    return sources;
}
/**
 * Classify one feed post by its title.
 *
 * Chrome's feed mixes Desktop, Android, iOS and ChromeOS posts in one stream.
 * The title is the only channel marker the feed exposes consistently, so the
 * query path uses it before handing posts to the model.
 *
 * @param source - one parsed feed post.
 * @returns the channel name, or `other` for an unrecognised title.
 */
export function chromeChannel(source) {
    const title = (source.title ?? '').toLowerCase();
    if (title.length === 0)
        return 'other';
    if (/\b(?:dev|canary)\b|developer channel/.test(title))
        return 'dev';
    if (/\bbeta\b/.test(title))
        return 'beta';
    // "Early" and "Extended" Stable are separate rollout/maintenance channels,
    // not the Stable channel the user asked about.
    if (/early stable|extended stable/.test(title))
        return 'other';
    if (/\bstable\b|chrome for (?:android|ios) update|chromeos/.test(title))
        return 'stable';
    return 'other';
}
/**
 * Keep the posts that belong to the channel the query asked about.
 *
 * This is intentionally narrow: only an explicit Stable request changes the
 * feed, so a general Chrome security query still sees every channel. The
 * function is lexical and never invents a channel the title does not state.
 *
 * @param sources - posts inside the requested time window.
 * @param query - the caller's query.
 * @returns stable-only posts when the query says Stable; otherwise a copy.
 */
export function filterChromeChannel(sources, query) {
    if (!/\bstable\b|稳定版|稳定渠道/i.test(query))
        return [...sources];
    return sources.filter((source) => chromeChannel(source) === 'stable');
}
/** True when a stable-only query dropped any post, for an honest note. */
export function hasNonStableChromePosts(sources, query) {
    return /\bstable\b|稳定版|稳定渠道/i.test(query)
        && sources.some((source) => chromeChannel(source) !== 'stable');
}
/** Read the feed directly or through the configured HTTP tunnel. */
async function readFeed(options) {
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(15_000, Math.max(1_000, Math.floor(options.timeoutMs)))
        : DEFAULT_TIMEOUT_MS;
    const headers = {
        accept: 'application/json',
        'user-agent': 'dsh-web-search/0.20 (+https://github.com/fangchenghao/dsh-web-search)',
    };
    if (options.proxy !== undefined && options.proxy.trim().length > 0) {
        const response = await proxyGet(CHROME_RELEASES_FEED_URL, {
            proxy: options.proxy,
            headers,
            timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Chrome Releases feed returned HTTP ${response.status}`);
        }
        return response.text;
    }
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = options.signal === undefined ? timer : AbortSignal.any([options.signal, timer]);
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(CHROME_RELEASES_FEED_URL, { signal, headers });
    if (!response.ok)
        throw new Error(`Chrome Releases feed returned HTTP ${response.status}`);
    return response.text();
}
/**
 * Fetch and parse the latest Chrome Releases posts.
 *
 * @param options - proxy/deadline/cancellation seams.
 * @returns dated posts, newest first; an empty list when the feed is malformed.
 */
export async function fetchChromeReleases(options = {}) {
    return parseChromeReleases(await readFeed(options));
}
/**
 * Keep only posts inside the requested window.
 * @param sources - parsed feed posts.
 * @param range - the requested publication window.
 * @param now - test seam for the current time.
 * @returns posts inside the window, preserving feed order.
 */
export function chromeWindow(sources, range, now = Date.now()) {
    if (range === 'off')
        return [...sources];
    return filterByTimeRange(sources, range, now);
}
/**
 * Explain what the official feed showed, including the absence of a zero-day
 * mention. This is evidence about the feed, not an assertion that no such
 * vulnerability exists anywhere.
 * @param sources - feed posts inside the window.
 * @param range - the requested window.
 * @param query - the caller's query, used to decide whether zero-day matters.
 * @returns one short note.
 */
export function chromeFeedNote(sources, range, query) {
    const window = range === 'off' ? 'latest' : range;
    if (!/zero[- ]?day|0[- ]?day|零日/iu.test(query)) {
        return `Official Chrome Releases feed: ${sources.length} post(s) in the ${window} result set, each with a publication date.`;
    }
    const zeroDay = sources.filter((source) => /zero[- ]?day|0[- ]?day|零日/iu.test(`${source.title ?? ''} ${source.snippet ?? ''}`)).length;
    if (sources.length === 0) {
        return `Official Chrome Releases feed checked: no post fell inside the ${window} window.`;
    }
    return zeroDay === 0
        ? `Official Chrome Releases feed checked: ${sources.length} post(s) inside the ${window} window; no title or summary mentions zero-day.`
        : `Official Chrome Releases feed checked: ${sources.length} post(s) inside the ${window} window; ${zeroDay} mention zero-day.`;
}
