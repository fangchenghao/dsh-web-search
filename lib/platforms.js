import { SearchError } from "./errors.js";
import { parsePublishedAt, publishedTimestamp } from "./freshness.js";
import { decodeEntities } from "./markdown.js";
import { proxyGet } from "./proxy.js";
/** Every supported platform, in the order results are interleaved. */
export const PLATFORM_IDS = Object.freeze([
    'bilibili',
    'v2ex',
    'reddit',
    'youtube',
    'zhihu',
    'juejin',
]);
/** Human labels, used in notes and in the model-facing tool description. */
export const PLATFORM_LABELS = Object.freeze({
    bilibili: 'Bilibili',
    v2ex: 'V2EX',
    reddit: 'Reddit',
    youtube: 'YouTube',
    zhihu: '知乎',
    juejin: '掘金',
});
/** Results wanted when the caller names no limit. */
export const DEFAULT_PLATFORM_LIMIT = 5;
/** Upper bound a single call may request. */
export const MAX_PLATFORM_LIMIT = 10;
/** Per-platform deadline when the caller names no timeout. */
const DEFAULT_TIMEOUT_MS = 8000;
/** Longest snippet kept per source. */
const SNIPPET_LIMIT = 300;
/** Browser user agent: Bilibili and YouTube reject the plugin's own. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
/** True for a value usable as a platform id. */
export function isPlatformId(value) {
    return typeof value === 'string' && PLATFORM_IDS.includes(value);
}
/** The direct route for every platform, keyed by id. */
const SPECS = {
    bilibili: {
        id: 'bilibili',
        site: 'bilibili.com',
        accept: 'application/json, text/plain, */*',
        headers: { referer: 'https://www.bilibili.com/' },
        build: (query) => `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1`,
        alternateBuild: (query) => `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}&page=1`,
        parse: (payload, query, limit) => parseBilibili(payload, limit, query),
    },
    v2ex: {
        id: 'v2ex',
        site: 'v2ex.com',
        accept: 'application/json',
        build: () => 'https://www.v2ex.com/api/topics/hot.json',
        parse: (payload, query, limit) => parseV2ex(payload, query, limit),
    },
    reddit: {
        id: 'reddit',
        site: 'reddit.com',
        accept: 'application/json',
        acceptLanguage: 'en-US,en;q=0.9',
        build: (query, limit) => `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=${limit}&sort=relevance&raw_json=1`,
        parse: (payload, _query, limit) => parseReddit(payload, limit),
    },
    youtube: {
        id: 'youtube',
        site: 'youtube.com',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        acceptLanguage: 'en-US,en;q=0.9',
        build: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
        parse: (payload, _query, limit) => parseYoutube(payload, limit),
    },
    zhihu: {
        id: 'zhihu',
        site: 'zhihu.com',
        accept: 'application/json',
        fallbackOnly: true,
    },
    juejin: {
        id: 'juejin',
        site: 'juejin.cn',
        accept: 'application/json',
        headers: { referer: 'https://juejin.cn/' },
        build: (query, limit) => `https://api.juejin.cn/search_api/v1/search?query=${encodeURIComponent(query)}&id_type=0&cursor=0&limit=${limit}`,
        parse: (payload, _query, limit) => parseJuejin(payload, limit),
    },
};
/** True for a value usable as a JSON record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Read one optional record. */
function asRecord(value) {
    return isRecord(value) ? value : undefined;
}
/** Read a non-empty string. */
function stringValue(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
/** Read a finite number, accepting the numeric strings these APIs sometimes send. */
function numberValue(value) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
}
/** Read an id that may be a string or a number. */
function identifier(value) {
    if (typeof value === 'string' && value.trim().length > 0)
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
/** True when a payload is markup rather than the JSON the endpoint promised. */
function looksLikeHtml(payload) {
    return payload.trimStart().startsWith('<');
}
/**
 * Strip markup and decode entities without breaking words that a highlight tag
 * split apart: `<em>鸣潮</em>` is `鸣潮`, not ` 鸣潮 `. Block boundaries become
 * a space so a description that used `<br>` keeps its words apart.
 * @param value - raw field from the API.
 * @returns plain single-line text.
 */
function cleanMarkup(value) {
    if (typeof value !== 'string')
        return '';
    return decodeEntities(value
        .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, ' ')
        .replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Parse a JSON payload, turning an anti-bot page into an actionable reason.
 * @param payload - response body.
 * @returns the parsed JSON value.
 * @throws `Error` when the body is HTML or is not valid JSON.
 */
function readJson(payload) {
    try {
        return JSON.parse(payload);
    }
    catch {
        throw new Error(looksLikeHtml(payload) ? 'returned HTML (anti-bot)' : 'invalid JSON');
    }
}
/** Render a thrown value as one line. */
function messageOf(error) {
    if (error instanceof Error) {
        return error.message.length > 0 ? error.message : error.name.length > 0 ? error.name : 'request failed';
    }
    return String(error);
}
/** Prefix a reason with its platform id exactly once. */
function failureText(id, reason) {
    return reason.startsWith(`${id}: `) ? reason : `${id}: ${reason}`;
}
/** Convert an epoch-seconds or epoch-milliseconds value to ISO 8601. */
function isoFromEpoch(value) {
    const raw = numberValue(value);
    if (raw === undefined || raw <= 0)
        return undefined;
    const milliseconds = raw > 1_000_000_000_000 ? raw : raw * 1000;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime()))
        return undefined;
    const year = date.getUTCFullYear();
    // Outside this range the field is almost certainly not a timestamp.
    return year >= 2000 && year <= 2100 ? date.toISOString() : undefined;
}
/** Normalise a date string to ISO 8601. */
function isoDate(value) {
    const raw = stringValue(value);
    if (raw === undefined)
        return undefined;
    const at = Date.parse(raw);
    return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}
/** Resolve a value to an absolute http(s) URL, dropping anything else. */
function absoluteHttpUrl(value, base) {
    const raw = stringValue(value);
    if (raw === undefined)
        return undefined;
    const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
    try {
        const parsed = new URL(candidate, base);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
    }
    catch {
        return undefined;
    }
}
/** Bound a snippet to the documented length. */
function boundSnippet(value) {
    return value.length > SNIPPET_LIMIT ? value.slice(0, SNIPPET_LIMIT).trimEnd() : value;
}
/** Validate, clean and bound one source; `undefined` when it is unusable. */
function cleanSource(raw, base) {
    const url = absoluteHttpUrl(raw.url, base);
    if (url === undefined)
        return undefined;
    const title = cleanMarkup(raw.title);
    const snippet = boundSnippet(cleanMarkup(raw.snippet));
    const publishedAt = isoDate(raw.publishedAt);
    return {
        url,
        ...(title.length > 0 ? { title } : {}),
        ...(snippet.length > 0 ? { snippet } : {}),
        ...(publishedAt === undefined ? {} : { publishedAt }),
    };
}
/** Hosts that legitimately redirect to a platform's canonical domain. */
const PLATFORM_ALIASES = {
    'bilibili.com': ['b23.tv'],
    'youtube.com': ['youtu.be'],
    'reddit.com': ['redd.it'],
};
/** True when a fallback row actually belongs to the platform's site. */
function isPlatformSource(url, site) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        const allowed = [site, ...(PLATFORM_ALIASES[site] ?? [])];
        return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
    }
    catch {
        return false;
    }
}
/** Canonical comparison key: fragments and a trailing slash do not make a new row. */
function urlKey(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.toString().replace(/\/$/, '');
    }
    catch {
        return url;
    }
}
/** Clean a list, drop duplicate URLs and cap it. */
function normaliseSources(raw, limit, base) {
    const sources = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const source = cleanSource(item, base);
        if (source === undefined)
            continue;
        const key = urlKey(source.url);
        if (seen.has(key))
            continue;
        seen.add(key);
        sources.push(source);
        if (sources.length >= limit)
            break;
    }
    return sources;
}
/** Clamp a caller limit into the accepted range. */
function clampLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_PLATFORM_LIMIT;
    return Math.max(1, Math.min(MAX_PLATFORM_LIMIT, Math.floor(value)));
}
/** Combine the caller signal with this request's own deadline. */
function deadline(timeoutMs, signal) {
    const timer = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}
/** Turn a non-2xx status into a reason. */
function statusError(status) {
    return new Error(status === 0 ? 'no response' : `HTTP ${status}`);
}
/** Turn a thrown transport failure into a reason, keeping timeouts readable. */
function transportError(error, timeoutMs) {
    const name = error instanceof Error ? error.name : '';
    const message = messageOf(error);
    if (name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)) {
        return new Error(`timed out after ${timeoutMs}ms`);
    }
    return new Error(message);
}
/**
 * Fetch one direct payload, directly or through the configured tunnel.
 * @param url - absolute request URL.
 * @param spec - route whose headers are used.
 * @param options - proxy, fetch seam, cancellation.
 * @param timeoutMs - per-platform deadline.
 * @returns the response body.
 * @throws `Error` on a transport failure or a non-2xx answer.
 */
async function requestText(url, spec, options, timeoutMs) {
    const headers = {
        'user-agent': USER_AGENT,
        accept: spec.accept,
        'accept-language': spec.acceptLanguage ?? ACCEPT_LANGUAGE,
        ...spec.headers,
    };
    if (options.proxy !== undefined && options.proxy.length > 0) {
        const response = await proxyGet(url, {
            proxy: options.proxy,
            headers,
            timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (response.status < 200 || response.status >= 300)
            throw statusError(response.status);
        return response.text;
    }
    const send = options.fetch ?? fetch;
    let response;
    try {
        response = await send(url, {
            headers,
            redirect: 'follow',
            signal: deadline(timeoutMs, options.signal),
        });
    }
    catch (error) {
        if (options.signal?.aborted === true)
            throw error;
        throw transportError(error, timeoutMs);
    }
    if (!response.ok)
        throw statusError(response.status);
    try {
        return await response.text();
    }
    catch (error) {
        if (options.signal?.aborted === true)
            throw error;
        throw transportError(error, timeoutMs);
    }
}
/* -------------------------------------------------------------------------- */
/* Parsers                                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Collect Bilibili video rows from either `search/type` (`data.result` is the
 * row list) or `search/all/v2` (each section carries its own `data` list).
 * @param value - candidate node.
 * @param out - accumulator.
 */
function collectBilibiliRows(value, out) {
    if (Array.isArray(value)) {
        for (const item of value)
            collectBilibiliRows(item, out);
        return;
    }
    if (!isRecord(value))
        return;
    if (typeof value['arcurl'] === 'string' || typeof value['bvid'] === 'string') {
        out.push(value);
        return;
    }
    if (Array.isArray(value['data']))
        collectBilibiliRows(value['data'], out);
}
/**
 * Parse Bilibili's video search envelope.
 *
 * Row-level drift yields fewer sources; an anti-bot envelope (HTML or a
 * non-zero `code`) throws so the caller knows to fall back.
 *
 * @param payload - `api.bilibili.com/x/web-interface/search/type` JSON.
 * @param limit - rows to keep.
 * @returns video sources in API order.
 * @throws `Error` on a wall or an unparsable envelope.
 */
export function parseBilibili(payload, limit = DEFAULT_PLATFORM_LIMIT, query = '') {
    const root = asRecord(readJson(payload));
    if (root === undefined)
        throw new Error('unexpected response shape');
    const code = numberValue(root['code']) ?? 0;
    if (code !== 0) {
        const message = cleanMarkup(root['message'] ?? root['msg']);
        throw new Error(`API code ${code}${message.length > 0 ? `: ${message}` : ''}`);
    }
    const rows = [];
    collectBilibiliRows(asRecord(root['data'])?.['result'], rows);
    const sources = [];
    for (const row of rows) {
        const bvid = stringValue(row['bvid']);
        const url = absoluteHttpUrl(row['arcurl']) ??
            (bvid === undefined ? undefined : `https://www.bilibili.com/video/${encodeURIComponent(bvid)}`);
        if (url === undefined)
            continue;
        const author = cleanMarkup(row['author'] ?? row['up_name']);
        const description = cleanMarkup(row['description'] ?? row['desc']);
        const play = numberValue(row['play']);
        const duration = cleanMarkup(row['duration']);
        const facts = [
            author.length > 0 ? `UP主 ${author}` : undefined,
            play === undefined ? undefined : `播放 ${play}`,
            duration.length > 0 ? `时长 ${duration}` : undefined,
        ].filter((part) => part !== undefined);
        const snippet = description.length > 0
            ? (facts.length > 0 ? `${facts.join(' · ')} · ${description}` : description)
            : facts.join(' · ');
        const source = cleanSource({
            url,
            title: cleanMarkup(row['title']) || bvid,
            snippet,
            publishedAt: isoFromEpoch(row['pubdate']),
        });
        if (source !== undefined)
            sources.push(source);
    }
    return normaliseBilibiliSources(normaliseSources(sources, clampLimit(limit * 3)), query).slice(0, clampLimit(limit));
}
/** Query tokens for a light relevance gate on Bilibili's broad search. */
function bilibiliQueryTokens(query) {
    const text = query.toLowerCase();
    const tokens = new Set();
    for (const word of text.match(/[a-z][a-z0-9.+#-]{2,}/gu) ?? [])
        tokens.add(word);
    for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
        if (run.length === 2)
            tokens.add(run);
        else
            for (let index = 0; index < run.length - 1; index += 1)
                tokens.add(run.slice(index, index + 2));
    }
    return [...tokens];
}
/**
 * Bilibili's relevance search sometimes returns an adjacent topic (a Python
 * async video for a Rust async query, or a Spring `@Async` video). Keep rows
 * that carry every Latin term and at least two distinct query tokens; when the
 * gate would empty the list, return the original rows so the caller can still
 * decide rather than seeing a fabricated empty answer.
 */
function normaliseBilibiliSources(sources, query, now = Date.now()) {
    const tokens = bilibiliQueryTokens(query);
    if (tokens.length === 0)
        return sources;
    const latin = tokens.filter((token) => /^[a-z]/u.test(token));
    // When the query names a narrow topic (`async`, `异步`), a row that merely
    // says "programming" is not the same topic. This removes a Goose-language
    // news video or an Axum backend course from a Rust-async query without
    // requiring every related video to repeat the exact token.
    const topics = tokens.filter((token) => /异步|async|并发|concurr|tokio/iu.test(token));
    const filtered = sources.filter((source) => {
        const haystack = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
        if (!latin.every((token) => haystack.includes(token)))
            return false;
        if (topics.length > 0 && !topics.some((token) => haystack.includes(token)))
            return false;
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        return hits >= Math.min(2, tokens.length);
    });
    if (filtered.length === 0)
        return sources;
    // The API returns relevance order, not recency or popularity. A question
    // that asks for "最近半年" or "播放量较高" should say so; only then do we
    // apply a bounded filter/sort rather than silently reordering every query.
    const wantsRecent = /最近半年|近半年|过去半年|last six months|recent|今年|2026/iu.test(query);
    const wantsPopular = /播放量|高播放|最热|热门|popular|most viewed|views?/iu.test(query);
    let rows = filtered;
    if (wantsRecent) {
        const cutoff = now - 183 * 24 * 60 * 60 * 1_000;
        rows = rows.filter((source) => {
            const at = publishedTimestamp(source.publishedAt);
            return at === undefined || at >= cutoff;
        });
        if (rows.length === 0)
            return [];
    }
    if (wantsPopular) {
        const plays = (source) => {
            const match = /播放\s+(\d+)/u.exec(source.snippet ?? '');
            return match?.[1] === undefined ? -1 : Number.parseInt(match[1], 10);
        };
        rows = [...rows].sort((left, right) => plays(right) - plays(left));
    }
    return rows;
}
/** Recursively collect every `videoRenderer` object in YouTube's page data. */
function collectVideoRenderers(value, out) {
    if (Array.isArray(value)) {
        for (const item of value)
            collectVideoRenderers(item, out);
        return;
    }
    if (!isRecord(value))
        return;
    const renderer = value['videoRenderer'];
    if (isRecord(renderer))
        out.push(renderer);
    for (const key of Object.keys(value)) {
        if (key === 'videoRenderer')
            continue;
        const child = value[key];
        if (typeof child === 'object' && child !== null)
            collectVideoRenderers(child, out);
    }
}
/** Read `{ simpleText }`/`{ runs: [{ text }] }` as one line. */
function inlineText(value) {
    const record = asRecord(value);
    if (record === undefined)
        return '';
    const simple = stringValue(record['simpleText']);
    if (simple !== undefined)
        return simple;
    const runs = record['runs'];
    if (!Array.isArray(runs))
        return '';
    return runs
        .map((run) => cleanMarkup(asRecord(run)?.['text']))
        .filter((part) => part.length > 0)
        .join('');
}
/** Extract the balanced JSON object that follows `ytInitialData`. */
function youtubeInitialData(payload) {
    const marker = /ytInitialData["'\]\s]*=\s*\{/.exec(payload);
    if (marker === null)
        return undefined;
    const start = marker.index + marker[0].lastIndexOf('{');
    return sliceBalancedObject(payload, start);
}
/** Slice one balanced `{...}` object, skipping braces inside strings. */
function sliceBalancedObject(textValue, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < textValue.length; index += 1) {
        const character = textValue[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (character === '\\')
                escaped = true;
            else if (character === '"')
                inString = false;
            continue;
        }
        if (character === '"')
            inString = true;
        else if (character === '{')
            depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0)
                return textValue.slice(start, index + 1);
        }
    }
    return undefined;
}
/** Expand YouTube's compact relative stamps (`1d ago`) for the shared parser. */
function youtubePublishedAt(value) {
    const units = {
        s: 'second',
        m: 'minute',
        h: 'hour',
        d: 'day',
        w: 'week',
        mo: 'month',
        y: 'year',
    };
    const expanded = value.replace(/\b(\d+)\s*(mo|[smhdwy])\s+ago\b/gi, (_whole, amount, unit) => `${amount} ${units[unit.toLowerCase()] ?? 'day'} ago`);
    return parsePublishedAt(expanded);
}
/**
 * Parse a YouTube results page through the embedded `ytInitialData` graph.
 *
 * `videoRenderer` is looked up at any depth because YouTube reshuffles the
 * section wrappers between experiments; the marker and the JSON are the only
 * two things the parser insists on.
 *
 * @param payload - `/results?search_query=` HTML.
 * @param limit - rows to keep.
 * @returns video sources in page order.
 * @throws `Error` when the page embeds no parsable `ytInitialData`.
 */
export function parseYoutube(payload, limit = DEFAULT_PLATFORM_LIMIT) {
    const json = youtubeInitialData(payload);
    if (json === undefined)
        throw new Error('ytInitialData not found');
    let root;
    try {
        root = JSON.parse(json);
    }
    catch {
        throw new Error('invalid ytInitialData JSON');
    }
    const renderers = [];
    collectVideoRenderers(root, renderers);
    const sources = [];
    for (const renderer of renderers) {
        const videoId = stringValue(renderer['videoId']);
        if (videoId === undefined)
            continue;
        const owner = inlineText(renderer['ownerText'] ?? renderer['longBylineText']);
        const length = inlineText(renderer['lengthText']);
        const views = inlineText(renderer['viewCountText']);
        const published = inlineText(renderer['publishedTimeText']);
        const snippet = [owner, length, views, published].filter((part) => part.length > 0).join(' · ');
        const source = cleanSource({
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
            title: inlineText(renderer['title']),
            snippet,
            publishedAt: youtubePublishedAt(published),
        });
        if (source !== undefined)
            sources.push(source);
    }
    return normaliseSources(sources, clampLimit(limit));
}
/**
 * Parse a Reddit search listing.
 *
 * The permalink is preferred over the external target so a post's citation
 * points at the discussion; `selftext` becomes the snippet, with a
 * subreddit/score line used when the post is link-only.
 *
 * @param payload - `reddit.com/search.json` JSON.
 * @param limit - rows to keep.
 * @returns post sources in listing order.
 * @throws `Error` on a wall, invalid JSON or an unexpected envelope.
 */
export function parseReddit(payload, limit = DEFAULT_PLATFORM_LIMIT) {
    const root = asRecord(readJson(payload));
    const children = asRecord(root?.['data'])?.['children'];
    if (!Array.isArray(children))
        throw new Error('unexpected response shape');
    const sources = [];
    for (const child of children) {
        const post = asRecord(asRecord(child)?.['data']);
        if (post === undefined)
            continue;
        const permalink = stringValue(post['permalink']);
        const url = (permalink === undefined ? undefined : absoluteHttpUrl(permalink, 'https://www.reddit.com')) ??
            absoluteHttpUrl(post['url']);
        if (url === undefined)
            continue;
        const subreddit = cleanMarkup(post['subreddit_name_prefixed'] ?? post['subreddit']);
        const score = numberValue(post['score']);
        const comments = numberValue(post['num_comments']);
        const meta = [
            subreddit,
            score === undefined ? '' : `${score} points`,
            comments === undefined ? '' : `${comments} comments`,
        ]
            .filter((part) => part.length > 0)
            .join(' · ');
        const source = cleanSource({
            url,
            title: cleanMarkup(post['title']),
            snippet: cleanMarkup(post['selftext']) || meta,
            publishedAt: isoFromEpoch(post['created_utc']),
        });
        if (source !== undefined)
            sources.push(source);
    }
    return normaliseSources(sources, clampLimit(limit));
}
/** Recursively collect Juejin article info objects, tolerating envelope drift. */
function collectJuejinArticles(value, out) {
    if (Array.isArray(value)) {
        for (const item of value)
            collectJuejinArticles(item, out);
        return;
    }
    if (!isRecord(value))
        return;
    const articleId = identifier(value['article_id']);
    if (articleId !== undefined) {
        out.push(value);
        return;
    }
    const direct = asRecord(value['article_info']);
    if (direct !== undefined && identifier(direct['article_id']) !== undefined) {
        out.push(direct);
        return;
    }
    const model = asRecord(value['result_model']);
    if (model !== undefined) {
        const info = asRecord(model['article_info']);
        if (info !== undefined && identifier(info['article_id']) !== undefined) {
            out.push(info);
            return;
        }
        collectJuejinArticles(model, out);
        return;
    }
    if (Array.isArray(value['data']))
        collectJuejinArticles(value['data'], out);
}
/**
 * Parse Juejin's article search envelope.
 *
 * The documented shape is `data[].result_model.article_info`; the collector
 * also accepts a bare `article_info` or an unwrapped `data` array because the
 * search API has changed wrappers before.
 *
 * @param payload - `api.juejin.cn/search_api/v1/search` JSON.
 * @param limit - rows to keep.
 * @returns article sources in API order.
 * @throws `Error` on a wall, invalid JSON or an API error code.
 */
export function parseJuejin(payload, limit = DEFAULT_PLATFORM_LIMIT) {
    const root = asRecord(readJson(payload));
    if (root === undefined)
        throw new Error('unexpected response shape');
    const errorNumber = numberValue(root['err_no']);
    if (errorNumber !== undefined && errorNumber !== 0) {
        const message = cleanMarkup(root['err_msg']);
        throw new Error(`API err_no ${errorNumber}${message.length > 0 ? `: ${message}` : ''}`);
    }
    const articles = [];
    collectJuejinArticles(root['data'], articles);
    const sources = [];
    for (const article of articles) {
        const articleId = identifier(article['article_id']);
        if (articleId === undefined)
            continue;
        const likes = numberValue(article['digg_count'] ?? article['like_count']);
        const views = numberValue(article['view_count'] ?? article['read_count']);
        const engagement = [
            likes === undefined ? undefined : `点赞 ${likes}`,
            views === undefined ? undefined : `阅读 ${views}`,
        ].filter((part) => part !== undefined);
        const body = cleanMarkup(article['brief_content']) || cleanMarkup(article['content']);
        const source = cleanSource({
            url: `https://juejin.cn/post/${encodeURIComponent(articleId)}`,
            title: cleanMarkup(article['title']),
            snippet: engagement.length > 0
                ? (body.length > 0 ? `${engagement.join(' · ')} · ${body}` : engagement.join(' · '))
                : body,
            publishedAt: isoFromEpoch(article['ctime'] ?? article['publish_time']),
        });
        if (source !== undefined)
            sources.push(source);
    }
    return normaliseSources(sources, clampLimit(limit));
}
/**
 * Sort Juejin rows by likes only when the query asks for popular posts. The
 * API returns a relevance order; an explicit "高赞/热门" request should not
 * leave a 16-like post above a 217-like one. Rows without a like count keep
 * their relative order after measured rows.
 *
 * @param sources - rows from {@link parseJuejin}, or a fallback.
 * @param query - the caller's query.
 * @returns the original order when no popularity intent is present.
 */
export function normaliseJuejinSources(sources, query) {
    if (!/高赞|点赞|热门|受欢迎|popular|most liked|top\b/iu.test(query))
        return [...sources];
    return [...sources]
        .map((source, index) => {
        const match = /点赞\s*(\d+)/u.exec(source.snippet ?? '');
        return { source, index, likes: match === null ? -1 : Number(match[1]) };
    })
        .sort((left, right) => right.likes - left.likes || left.index - right.index)
        .map((entry) => entry.source);
}
/**
 * Filter V2EX's hot-topic snapshot by the query.
 *
 * The public API has no search endpoint, so the hot list is the only keyless
 * source; a query that does not appear in any title or body filters everything
 * out and the caller is expected to fall back to `site:v2ex.com`.
 *
 * @param payload - `v2ex.com/api/topics/hot.json` JSON.
 * @param query - text to look for in a title or body, case-insensitively.
 * @param limit - rows to keep.
 * @returns matching topics in hot-list order.
 * @throws `Error` on a Cloudflare page, invalid JSON or an unexpected envelope.
 */
export function parseV2ex(payload, query, limit = DEFAULT_PLATFORM_LIMIT) {
    const parsed = readJson(payload);
    if (!Array.isArray(parsed))
        throw new Error('unexpected response shape');
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const sources = [];
    const seen = new Set();
    for (const item of parsed) {
        if (!isRecord(item))
            continue;
        const title = cleanMarkup(item['title']);
        const content = cleanMarkup(item['content']);
        if (needle.length > 0 && !`${title} ${content}`.toLowerCase().includes(needle))
            continue;
        const id = identifier(item['id']);
        const url = absoluteHttpUrl(item['url']) ??
            (id === undefined ? undefined : `https://www.v2ex.com/t/${encodeURIComponent(id)}`);
        if (url === undefined)
            continue;
        const key = urlKey(url);
        if (seen.has(key))
            continue;
        seen.add(key);
        const source = cleanSource({
            url,
            title,
            snippet: content,
            publishedAt: isoFromEpoch(item['created']),
        });
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= clampLimit(limit))
            break;
    }
    return sources;
}
/* -------------------------------------------------------------------------- */
/* Orchestration                                                               */
/* -------------------------------------------------------------------------- */
/**
 * Try one platform's fallback search, or report why it cannot run.
 * @param spec - platform being served.
 * @param query - original query, already trimmed.
 * @param limit - per-platform budget.
 * @param options - caller options.
 * @param directReason - why the direct attempt produced nothing, if it failed.
 * @returns the platform answer.
 */
async function fallbackAnswer(spec, query, limit, options, directReason) {
    if (options.fallbackSearch === undefined) {
        return {
            id: spec.id,
            sources: [],
            via: spec.fallbackOnly === true ? 'fallback' : 'api',
            ...(directReason === undefined ? {} : { failure: failureText(spec.id, directReason) }),
        };
    }
    const fallbackQuery = `site:${spec.site} ${query}`;
    try {
        const result = await options.fallbackSearch(fallbackQuery, limit, options.signal);
        // A search engine may ignore the site: operator and return generic pages.
        // A platform result must at least live on that platform's domain.
        const allowed = normaliseSources(result.sources, limit * 2)
            .filter((source) => isPlatformSource(source.url, spec.site));
        const sourced = spec.id === 'bilibili'
            ? normaliseBilibiliSources(allowed, query)
            : spec.id === 'juejin'
                ? normaliseJuejinSources(allowed, query)
                : spec.id === 'zhihu'
                    ? normaliseZhihuFallback(allowed, query)
                    : allowed;
        const sources = sourced.slice(0, limit);
        if (sources.length > 0) {
            return { id: spec.id, sources, via: 'fallback' };
        }
        const fallbackFailures = result.failures.filter((item) => typeof item === 'string' && item.trim().length > 0);
        const noDomainRows = fallbackFailures.length === 0 && result.sources.length > 0;
        const fragments = [
            ...(directReason === undefined ? [] : [directReason]),
            ...(fallbackFailures.length === 0 ? [] : [`fallback failed: ${fallbackFailures.join('; ')}`]),
            ...(noDomainRows ? [`fallback returned no ${spec.site} result`] : []),
        ];
        return {
            id: spec.id,
            sources: [],
            via: 'fallback',
            ...(fragments.length === 0 ? {} : { failure: failureText(spec.id, fragments.join('; ')) }),
        };
    }
    catch (error) {
        if (options.signal?.aborted === true)
            throw error;
        const reason = messageOf(error);
        const combined = directReason === undefined ? `fallback failed: ${reason}` : `${directReason}; fallback failed: ${reason}`;
        return { id: spec.id, sources: [], via: 'fallback', failure: failureText(spec.id, combined) };
    }
}
/**
 * Search one platform: its direct endpoint first, then the fallback.
 * @param spec - platform to query.
 * @param query - original query, already trimmed.
 * @param limit - per-platform budget.
 * @param options - caller options.
 * @param timeoutMs - per-platform deadline.
 * @returns the platform answer.
 */
async function searchPlatform(spec, query, limit, options, timeoutMs) {
    if (spec.fallbackOnly === true || spec.build === undefined || spec.parse === undefined) {
        if (options.fallbackSearch === undefined) {
            return {
                id: spec.id,
                sources: [],
                via: 'fallback',
                failure: failureText(spec.id, 'no keyless direct API; fallback search not configured'),
            };
        }
        return fallbackAnswer(spec, query, limit, options, undefined);
    }
    let directSources = [];
    let directReason;
    const builds = [spec.build, ...(spec.alternateBuild === undefined ? [] : [spec.alternateBuild])];
    for (const build of builds) {
        try {
            const payload = await requestText(build(query, limit), spec, options, timeoutMs);
            const parsed = normaliseSources(spec.parse(payload, query, limit), limit);
            const found = spec.id === 'juejin' ? normaliseJuejinSources(parsed, query) : parsed;
            // The primary endpoint can answer with one row while the alternate has
            // the wider set (Bilibili does this for a long query). Merge rather than
            // stop at the first non-empty answer; the URL de-duplication keeps the
            // result stable when both endpoints overlap.
            const seen = new Set(directSources.map((source) => source.url));
            for (const source of found) {
                if (!seen.has(source.url)) {
                    seen.add(source.url);
                    directSources.push(source);
                }
            }
        }
        catch (error) {
            if (options.signal?.aborted === true)
                throw error;
            directReason = messageOf(error);
        }
        if (directSources.length >= limit)
            break;
    }
    if (directSources.length > 0) {
        // The primary and alternate endpoints may each return a popularity-sorted
        // list; sort the merged rows again so their interleaving cannot undo it.
        const ordered = spec.id === 'bilibili'
            ? normaliseBilibiliSources(directSources, query)
            : spec.id === 'juejin'
                ? normaliseJuejinSources(directSources, query)
                : directSources;
        return { id: spec.id, sources: ordered, via: 'api' };
    }
    return fallbackAnswer(spec, query, limit, options, directReason);
}
/**
 * Search the requested platforms and merge their answers.
 *
 * Every platform is asked concurrently. A direct endpoint that is blocked or
 * unparsable is retried through `fallbackSearch`; a platform that still has
 * nothing contributes a `failures` line instead of failing the call. Answers
 * are interleaved by rank (one row from each platform, then the second row
 * from each), duplicate URLs are dropped, and the merged list is capped at the
 * caller's budget.
 *
 * @param query - what to search for; empty input yields an empty outcome.
 * @param options - platform ids, budget, deadline, cancellation, tunnel, fetch
 *   seam and fallback search.
 * @returns merged sources plus per-platform counts, channels and failures.
 * @throws SearchError `SEARCH_ABORTED` when the caller cancelled the run.
 */
export async function searchPlatforms(query, options = {}) {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed.length === 0) {
        return { sources: [], failures: [], counts: {}, truncated: false, via: {} };
    }
    const limit = clampLimit(options.limit);
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const requested = (options.ids ?? []).filter(isPlatformId);
    const selected = requested.length > 0 ? PLATFORM_IDS.filter((id) => requested.includes(id)) : [...PLATFORM_IDS];
    let answers;
    try {
        answers = await Promise.all(selected.map((id) => searchPlatform(SPECS[id], trimmed, limit, options, timeoutMs)));
    }
    catch (error) {
        if (options.signal?.aborted === true) {
            throw new SearchError('platform search was cancelled', 'SEARCH_ABORTED', false);
        }
        throw error;
    }
    const counts = {};
    const via = {};
    const failures = [];
    let deepest = 0;
    for (const answer of answers) {
        counts[answer.id] = answer.sources.length;
        via[answer.id] = answer.via;
        deepest = Math.max(deepest, answer.sources.length);
        if (answer.failure !== undefined)
            failures.push(answer.failure);
    }
    const merged = [];
    const seen = new Set();
    for (let rank = 0; rank < deepest; rank += 1) {
        for (const answer of answers) {
            const source = answer.sources[rank];
            if (source === undefined)
                continue;
            const key = urlKey(source.url);
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(source);
        }
    }
    return {
        sources: merged.slice(0, limit),
        failures,
        counts,
        truncated: merged.length > limit,
        via,
    };
}
/**
 * Drop a generic fallback row that shares almost none of a specific query.
 *
 * Zhihu has no keyless direct endpoint. Its fallback sometimes puts a broad
 * question such as "目前有哪些主流的 AI？" above an answer that actually names
 * coding assistants. This is a light preference, not a hard filter: when fewer
 * than two rows survive, the original list is returned.
 *
 * @param sources - fallback rows already filtered to the Zhihu host.
 * @param query - the caller's query.
 * @returns rows with at least two query-term matches, or the original list.
 */
export function normaliseZhihuFallback(sources, query) {
    const terms = new Set();
    const text = query.toLowerCase();
    for (const word of text.match(/[a-z][a-z0-9.+#-]{2,}/gu) ?? [])
        terms.add(word);
    for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
        for (let index = 0; index < run.length - 1; index += 1)
            terms.add(run.slice(index, index + 2));
    }
    const stop = new Set(['哪些', '主流', '目前', '什么', '怎么', '哪个', '如何', '可以', '是否', '这个', '那个']);
    for (const word of stop)
        terms.delete(word);
    if (terms.size === 0)
        return [...sources];
    const kept = sources.filter((source) => {
        const haystack = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
        let matches = 0;
        for (const term of terms)
            if (haystack.includes(term))
                matches += 1;
        return matches >= 2;
    });
    return kept.length >= Math.min(2, sources.length) ? kept : [...sources];
}
