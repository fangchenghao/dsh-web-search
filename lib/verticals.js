import { SearchError } from "./errors.js";
import { text } from "./parsers.js";
import { proxyGet } from "./proxy.js";
/** Every supported source, in the order results are interleaved. */
export const VERTICAL_IDS = [
    'github',
    'npm',
    'pypi',
    'arxiv',
    'wikipedia',
    'hn',
    'stackexchange',
    'crates',
];
/** Default and maximum result budget for one source. */
export const DEFAULT_VERTICAL_LIMIT = 5;
/** Upper bound the tool and the adapters both respect. */
export const MAX_VERTICAL_LIMIT = 20;
/** The user agent every source sees. GitHub and crates.io both require one. */
const USER_AGENT = 'dsh-web-search/0.10 (+https://github.com/fangchenghao/dsh-web-search-bing)';
/** Scripts that make a query CJK rather than ASCII. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
/** True for a value usable as a JSON record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Parse JSON without throwing; `undefined` means "not JSON". */
function parseJson(payload) {
    try {
        return JSON.parse(payload);
    }
    catch {
        return undefined;
    }
}
/** Read a string field, trimmed; anything else becomes the empty string. */
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** Turn one URL into a citable http(s) URL, or drop it. */
function webUrl(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return undefined;
    try {
        const url = new URL(raw.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return url.toString();
    }
    catch {
        return undefined;
    }
}
/** Strip markup and collapse whitespace, then bound the snippet length. */
function snippetOf(value, max = 400) {
    const clean = text(value);
    return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}
/** Build one source, dropping rows that carry no citable URL. */
function sourceOf(rawUrl, title, snippet, publishedAt) {
    const url = webUrl(rawUrl);
    if (url === undefined)
        return undefined;
    return {
        url,
        ...(title.length > 0 ? { title } : {}),
        ...(snippet.length > 0 ? { snippet } : {}),
        ...(publishedAt !== undefined && publishedAt.length > 0 ? { publishedAt } : {}),
    };
}
/** Clamp a caller budget into the range every adapter can serve. */
function clampLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_VERTICAL_LIMIT;
    return Math.max(1, Math.min(MAX_VERTICAL_LIMIT, Math.floor(value)));
}
/** Read one XML/Atom tag's text, with entities decoded. */
function tag(block, name) {
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
export function parseGithub(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.items))
        return [];
    const sources = [];
    for (const row of body.items) {
        if (!isRecord(row))
            continue;
        const name = str(row.full_name) || str(row.name);
        const source = sourceOf(str(row.html_url) || (name.length > 0 ? `https://github.com/${name}` : undefined), name, snippetOf(row.description), str(row.pushed_at) || str(row.updated_at));
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parseNpm(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.objects))
        return [];
    const sources = [];
    for (const row of body.objects) {
        if (!isRecord(row) || !isRecord(row.package))
            continue;
        const pkg = row.package;
        const name = str(pkg.name);
        if (name.length === 0)
            continue;
        const version = str(pkg.version);
        const links = isRecord(pkg.links) ? pkg.links : undefined;
        const source = sourceOf(str(links?.npm) || str(links?.homepage) || `https://www.npmjs.com/package/${name}`, version.length > 0 ? `${name}@${version}` : name, snippetOf(pkg.description), str(row.date) || str(row.updated));
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parsePypi(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    if (limit < 1)
        return [];
    const body = parseJson(payload);
    if (!isRecord(body) || !isRecord(body.info))
        return [];
    const info = body.info;
    const name = str(info.name);
    if (name.length === 0)
        return [];
    const version = str(info.version);
    const urls = Array.isArray(body.urls) ? body.urls : [];
    const first = isRecord(urls[0]) ? urls[0] : undefined;
    const source = sourceOf(str(info.package_url) || `https://pypi.org/project/${encodeURIComponent(name)}/`, version.length > 0 ? `${name} ${version}` : name, snippetOf(info.summary), str(first?.upload_time_iso_8601) || str(first?.upload_time));
    return source === undefined ? [] : [source];
}
/**
 * Parse the arXiv Atom feed.
 * @param payload - `export.arxiv.org/api/query` XML.
 * @param _url - request URL, unused by this XML shape.
 * @param limit - entries to keep.
 * @returns papers as sources, in feed order.
 */
export function parseArxiv(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    if (typeof payload !== 'string')
        return [];
    const sources = [];
    for (const match of payload.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
        const block = match[1] ?? '';
        const id = tag(block, 'id');
        const title = tag(block, 'title');
        const summary = tag(block, 'summary');
        const published = tag(block, 'published') || tag(block, 'updated');
        // The feed's own id uses plain http; the canonical page is https.
        const page = id.replace(/^http:\/\//i, 'https://');
        const source = sourceOf(page, title, snippetOf(summary), published);
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parseWikipedia(payload, finalUrl, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.pages))
        return [];
    let language = 'en';
    try {
        if (new URL(finalUrl).hostname.startsWith('zh.'))
            language = 'zh';
    }
    catch {
        // Keep the English default; the parser still answers.
    }
    const sources = [];
    for (const row of body.pages) {
        if (!isRecord(row))
            continue;
        const key = str(row.key) || str(row.title);
        if (key.length === 0)
            continue;
        const title = str(row.title) || key;
        const excerpt = snippetOf(row.excerpt) || snippetOf(row.description);
        const page = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(key.replace(/ /g, '_'))}`;
        const source = sourceOf(page, title, excerpt);
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parseHn(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.hits))
        return [];
    const sources = [];
    for (const row of body.hits) {
        if (!isRecord(row))
            continue;
        const objectId = str(row.objectID);
        const fallback = objectId.length > 0 ? `https://news.ycombinator.com/item?id=${objectId}` : undefined;
        const highlighted = isRecord(row._highlightResult) && isRecord(row._highlightResult.title)
            ? row._highlightResult.title.value
            : undefined;
        const title = str(row.title) || str(row.story_title) || snippetOf(highlighted, 120);
        const snippet = snippetOf(row.story_text) || snippetOf(row.comment_text);
        const source = sourceOf(str(row.url) || fallback, title, snippet, str(row.created_at));
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parseStackExchange(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.items))
        return [];
    const sources = [];
    for (const row of body.items) {
        if (!isRecord(row))
            continue;
        const created = typeof row.creation_date === 'number' && Number.isFinite(row.creation_date)
            ? new Date(row.creation_date * 1000).toISOString()
            : undefined;
        const source = sourceOf(str(row.link), str(row.title), snippetOf(row.body), created);
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
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
export function parseCrates(payload, _url, limit = MAX_VERTICAL_LIMIT) {
    const body = parseJson(payload);
    if (!isRecord(body) || !Array.isArray(body.crates))
        return [];
    const sources = [];
    for (const row of body.crates) {
        if (!isRecord(row))
            continue;
        const name = str(row.name);
        if (name.length === 0)
            continue;
        const version = str(row.max_version) || str(row.newest_version);
        const source = sourceOf(`https://crates.io/crates/${encodeURIComponent(name)}`, version.length > 0 ? `${name} ${version}` : name, snippetOf(row.description), str(row.updated_at));
        if (source !== undefined)
            sources.push(source);
        if (sources.length >= limit)
            break;
    }
    return sources;
}
/** A source id that this module actually knows. */
export function isVerticalId(value) {
    return typeof value === 'string' && VERTICAL_IDS.includes(value);
}
/** Every adapter, keyed by id. */
export const VERTICALS = [
    {
        id: 'github',
        label: 'GitHub',
        accept: 'application/vnd.github+json',
        headers: { 'x-github-api-version': '2022-11-28' },
        build: (query, limit) => `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
        parse: parseGithub,
    },
    {
        id: 'npm',
        label: 'npm',
        accept: 'application/json',
        build: (query, limit) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
        parse: parseNpm,
    },
    {
        id: 'pypi',
        label: 'PyPI',
        accept: 'application/json',
        notFoundIsEmpty: true,
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
        build: (query, limit) => `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`,
        parse: parseArxiv,
    },
    {
        id: 'wikipedia',
        label: 'Wikipedia',
        accept: 'application/json',
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
        build: (query, limit) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`,
        parse: parseHn,
    },
    {
        id: 'stackexchange',
        label: 'Stack Exchange',
        accept: 'application/json',
        build: (query, limit) => `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}&filter=withbody`,
        parse: parseStackExchange,
    },
    {
        id: 'crates',
        label: 'crates.io',
        accept: 'application/json',
        build: (query, limit) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${limit}`,
        parse: parseCrates,
    },
];
/** One adapter by id, or `undefined` for a typo. */
export function verticalById(id) {
    return VERTICALS.find((spec) => spec.id === id);
}
/** Classify a non-2xx status into the shared business codes. */
function statusError(status) {
    if (status === 429)
        return new SearchError('HTTP 429', 'SEARCH_THROTTLED');
    if (status === 403)
        return new SearchError('HTTP 403', 'SEARCH_BLOCKED');
    if (status >= 500)
        return new SearchError(`HTTP ${status}`, 'SEARCH_NETWORK');
    if (status === 0)
        return new SearchError('no response', 'SEARCH_NETWORK');
    return new SearchError(`HTTP ${status}`, 'SEARCH_BLOCKED');
}
/** Classify a thrown transport failure. */
function thrownError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
        return new SearchError(message, 'SEARCH_TIMEOUT');
    }
    return new SearchError(message, 'SEARCH_NETWORK');
}
/** Combine the caller signal with this request's own deadline. */
function deadline(timeoutMs, signal) {
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
async function fetchPayload(spec, url, options, timeoutMs) {
    const headers = {
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
        }
        else {
            const send = options.fetch ?? fetch;
            const response = await send(url, {
                headers,
                redirect: 'follow',
                signal: deadline(timeoutMs, options.signal),
            });
            status = response.status;
            payload = response.ok ? await response.text() : '';
        }
    }
    catch (error) {
        if (options.signal?.aborted === true)
            throw error;
        throw thrownError(error);
    }
    if (status === 404 && spec.notFoundIsEmpty === true)
        return '';
    if (status < 200 || status >= 300)
        throw statusError(status);
    return payload;
}
/** Render one failure as `id: reason`, without doubling an existing id. */
function failureText(id, error) {
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
export async function searchVerticals(query, options = {}) {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    if (trimmed.length === 0)
        return { sources: [], failures: [], counts: {}, truncated: false };
    const limit = clampLimit(options.limit);
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 8000;
    const requested = (options.ids ?? []).filter(isVerticalId);
    const specs = (requested.length > 0 ? VERTICAL_IDS.filter((id) => requested.includes(id)) : VERTICAL_IDS)
        .map((id) => verticalById(id))
        .filter((spec) => spec !== undefined);
    const answers = await Promise.all(specs.map(async (spec) => {
        try {
            const url = spec.build(trimmed, limit);
            const payload = await fetchPayload(spec, url, options, timeoutMs);
            const sources = spec.parse(payload, url, limit);
            return { id: spec.id, sources };
        }
        catch (error) {
            return { id: spec.id, failure: failureText(spec.id, error) };
        }
    }));
    if (options.signal?.aborted === true) {
        throw new SearchError('domain search was cancelled', 'SEARCH_ABORTED', false);
    }
    const counts = {};
    const failures = [];
    let sourceRanks = 0;
    for (const answer of answers) {
        counts[answer.id] = 'sources' in answer ? answer.sources.length : 0;
        if ('sources' in answer)
            sourceRanks = Math.max(sourceRanks, answer.sources.length);
        if ('failure' in answer)
            failures.push(answer.failure);
    }
    const merged = [];
    const seen = new Set();
    for (let rank = 0; rank < sourceRanks; rank += 1) {
        for (const answer of answers) {
            if (!('sources' in answer))
                continue;
            const source = answer.sources[rank];
            if (source === undefined || seen.has(source.url))
                continue;
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
