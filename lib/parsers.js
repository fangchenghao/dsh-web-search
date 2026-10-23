import { extractPublishedAt, parsePublishedAt } from "./freshness.js";
/** Named HTML entities that actually show up in result markup. */
const ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    middot: '·',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    laquo: '«',
    raquo: '»',
    bull: '•',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
    times: '×',
    divide: '÷',
    plusmn: '±',
    frac12: '½',
    sup2: '²',
    sup3: '³',
    euro: '€',
    pound: '£',
    yen: '¥',
    cent: '¢',
    sect: '§',
    para: '¶',
    dagger: '†',
    prime: '′',
    permil: '‰',
};
/**
 * Decode the HTML entities and strip tags from one fragment of result markup.
 * Highlight tags (`<em>`) are dropped, keeping only visible text.
 * @param value - raw markup.
 * @returns plain single-line text.
 */
export function text(value) {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
        const key = name.toLowerCase();
        if (key in ENTITIES)
            return ENTITIES[key] ?? whole;
        const numeric = key.startsWith('#x')
            ? parseInt(key.slice(2), 16)
            : key.startsWith('#')
                ? parseInt(key.slice(1), 10)
                : Number.NaN;
        if (Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff)
            return String.fromCodePoint(numeric);
        // An unrecognized named entity is spacing or decoration, never content:
        // drop it rather than leaking the raw "&name;" into a snippet.
        return /^[a-z][a-z0-9]*$/.test(key) ? ' ' : whole;
    })
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Resolve an anchor target to an absolute http(s) URL, undoing the Bing
 * click-tracker wrapper (`/ck/a?...&u=a1<base64url>`) when present, and the
 * DuckDuckGo `/l/?uddg=<urlencoded>` wrapper.
 * @param raw - the raw `href` attribute, still HTML-escaped.
 * @param baseUrl - the page the anchor came from.
 * @returns the absolute URL, or `undefined` when there is none.
 */
export function resolveHref(raw, baseUrl) {
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    // Attribute values are HTML-escaped, so a Bing click tracker arrives as
    // `...&amp;u=a1<base64url>`; decode before looking for the payload.
    let candidate = raw.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&');
    const wrapped = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(candidate);
    if (wrapped) {
        try {
            candidate = Buffer.from(wrapped[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        }
        catch {
            return undefined;
        }
    }
    else {
        // DuckDuckGo wraps outbound links as `/l/?uddg=<percent-encoded>`.
        const uddg = /[?&]uddg=([^&]+)/.exec(candidate);
        if (uddg) {
            try {
                candidate = decodeURIComponent(uddg[1]);
            }
            catch {
                return undefined;
            }
        }
    }
    try {
        const url = new URL(candidate, baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return url.toString();
    }
    catch {
        return undefined;
    }
}
/**
 * Parse a 360 (so.com) results page. The real URL lives in `data-mdurl`;
 * without it the only target is a 360 click tracker, which is not citable.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, oldest result first.
 */
export function parseSo(payload, baseUrl) {
    const sources = [];
    if (typeof payload !== 'string')
        return sources;
    for (const chunk of payload.split(/class="res-list"/).slice(1)) {
        const item = chunk.slice(0, 12000);
        // The heading class carries a trailing space in the served markup, and the
        // result wrapper is a `<li>` for ordinary results but a `<div>` for rich
        // ones — so match on the class value rather than the element or its exact
        // attribute text.
        const heading = /<h3[^>]*class="res-title[^"]*"[^>]*>/.exec(item);
        if (!heading || heading.index === undefined)
            continue;
        const anchor = /<a\s([^>]{0,4000})>([\s\S]*?)<\/a>/.exec(item.slice(heading.index + heading[0].length));
        if (!anchor)
            continue;
        const direct = /data-mdurl="([^"]+)"/.exec(anchor[1] ?? '');
        if (direct === null)
            continue;
        const url = resolveHref(direct[1], baseUrl);
        if (url === undefined)
            continue;
        const title = text(anchor[2]);
        const summary = /<span[^>]*class="res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(item);
        const snippet = summary ? text(summary[1]) : '';
        // 360 prints the stamp in a separate span (`发贴时间：2026年1月22日`), not in
        // the summary. Reading only that span avoids treating prose such as
        // `但是我们今天讲的逻辑复制` as a publication date.
        const stamp = /(?:发[贴布]|发布)时间[：:]\s*([^<]{0,60})/.exec(item);
        const publishedAt = stamp ? parsePublishedAt(text(stamp[1])) : undefined;
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
/**
 * Parse a Bing results page.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export function parseBing(payload, baseUrl) {
    const sources = [];
    if (typeof payload !== 'string')
        return sources;
    for (const chunk of payload.split(/<li class="b_algo"/).slice(1)) {
        const item = chunk.slice(0, 8000);
        const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(item);
        if (!anchor)
            continue;
        const url = resolveHref(anchor[1], baseUrl);
        if (url === undefined)
            continue;
        const title = text(anchor[2]);
        const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/.exec(item);
        const snippet = paragraph ? text(paragraph[1]) : '';
        // Bing puts the date at the head of the caption (`2025年9月25日 …`,
        // `2 天之前 …`) or in a `news_dt` span; some captions end with an ISO date.
        const newsDate = /<span[^>]*class="news_dt"[^>]*>([\s\S]*?)<\/span>/.exec(item);
        const publishedAt = extractPublishedAt([newsDate ? text(newsDate[1]) : undefined, snippet]);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
/**
 * Parse a DuckDuckGo lite page.
 *
 * Its attributes are single-quoted (`class='result-link'`), unlike Bing's, so
 * the patterns here accept either quote style. The snippet lives in a sibling
 * row (`class='result-snippet'`) that follows the anchor, so each hit is
 * examined up to the next hit.
 * @param payload - the served lite page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export function parseDdgLite(payload, baseUrl) {
    const sources = [];
    if (typeof payload !== 'string')
        return sources;
    const anchors = [...payload.matchAll(/<a\s[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const [index, match] of anchors.entries()) {
        const start = (match.index ?? 0) + match[0].length;
        const next = anchors[index + 1];
        const end = next?.index ?? payload.length;
        const url = resolveHref(/href=['"]([^'"]+)['"]/.exec(match[0])?.[1], baseUrl);
        if (url === undefined)
            continue;
        const title = text(match[1]);
        const snippet = text(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(payload.slice(start, end))?.[1] ?? '');
        // The lite page has no timestamp in today's markup; if one ever appears it
        // is the authoritative stamp, otherwise a date mentioned in the snippet is
        // the only evidence available.
        const stamp = /<[a-z]+[^>]*class=['"]result-timestamp['"][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(payload.slice(start, end));
        const publishedAt = extractPublishedAt([stamp?.[1], snippet]);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
/**
 * Parse a DuckDuckGo HTML page.
 *
 * The endpoint used to be richer than the lite one and carries a snippet per
 * hit (`result__snippet`), which the lite page also has but with different
 * markup. Outbound links are usually wrapped as `/l/?uddg=<percent-encoded>`,
 * which {@link resolveHref} unwraps; the endpoint also serves direct links.
 * Attribute order and quoting vary, so both are matched loosely.
 * @param payload - the served result page.
 * @param baseUrl - the page URL, used to resolve relative links.
 * @returns parsed sources, in page order.
 */
export function parseDdgHtml(payload, baseUrl) {
    const sources = [];
    if (typeof payload !== 'string')
        return sources;
    const anchors = [...payload.matchAll(/<a\s[^>]*class=['"]result__a['"][^>]*>([\s\S]*?)<\/a>/gi)];
    for (const [index, match] of anchors.entries()) {
        const start = (match.index ?? 0) + match[0].length;
        const next = anchors[index + 1];
        const end = next?.index ?? payload.length;
        const url = resolveHref(/href=['"]([^'"]+)['"]/.exec(match[0])?.[1], baseUrl);
        if (url === undefined)
            continue;
        const title = text(match[1]);
        const snippet = text(/<[a-z]+[^>]*class=['"]result__snippet['"][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(payload.slice(start, end))?.[1] ?? '');
        // DuckDuckGo's HTML endpoint usually omits the date; when a timestamp span
        // is present it is preferred over a date that only appears in the snippet.
        const stamp = /<[a-z]+[^>]*class=['"]result__timestamp['"][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(payload.slice(start, end));
        const publishedAt = extractPublishedAt([stamp?.[1], snippet]);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
/** True when a value is a non-null object, the only shape JSON rows may have. */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/**
 * Parse an AnySearch JSON envelope.
 *
 * The endpoint is a documented API rather than scraped markup, so it needs no
 * echo check: the envelope either carries `data.results` or reports a business
 * code. Rows without a usable URL are dropped — the seam requires a citable
 * URL, and inventing one would be a lie.
 * @param payload - the response body.
 * @param baseUrl - the API URL, used as the base for relative row URLs.
 * @returns parsed sources, in envelope order; `[]` for any unusable envelope.
 */
export function parseAnySearch(payload, baseUrl) {
    let body;
    try {
        body = JSON.parse(payload);
    }
    catch {
        return [];
    }
    if (!isRecord(body) || body.code !== 0)
        return [];
    const data = body.data;
    if (!isRecord(data))
        return [];
    const rows = data.results;
    if (!Array.isArray(rows))
        return [];
    const base = baseUrl || 'https://api.anysearch.com';
    const sources = [];
    for (const row of rows) {
        if (!isRecord(row))
            continue;
        const url = resolveHref(typeof row.url === 'string' ? row.url : undefined, base);
        if (url === undefined)
            continue;
        const title = typeof row.title === 'string' ? row.title.trim() : '';
        const snippet = typeof row.snippet === 'string' ? row.snippet.trim() : '';
        // Measured against the live endpoint: rows carry title/url/snippet/content,
        // and the publication stamp is appended to `content` as `date: 22 hours
        // ago` rather than exposed as a top-level date field. A top-level `date`
        // is accepted too, so a future API change does not need a parser rewrite.
        // Only the marked value is parsed: the rest of `content` is article prose
        // and may mention unrelated dates (`Retrieved June 2, 2024`).
        const content = typeof row.content === 'string' ? row.content : '';
        const marker = /(?:^|[\s|])date\s*[:：]\s*([^|\n]+?)\s*$/i.exec(content);
        const topLevel = typeof row.date === 'string' ? row.date : undefined;
        const publishedAt = extractPublishedAt([topLevel, marker?.[1]]);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
            ...(publishedAt === undefined ? {} : { publishedAt }),
        });
    }
    return sources;
}
/**
 * Check that a page actually belongs to the query.
 *
 * Every engine echoes the query in its search box, so a genuine result page
 * contains it. A rate-limited reply does not: Bing answers repeated rapid
 * requests with a "trending" feed whose entries belong to somebody else's
 * search, and those results were previously attributed to the user's query.
 * Accepted when the query has no token long enough to be distinctive.
 * @param payload - the response body.
 * @param query - the query that was asked for.
 * @returns whether the payload contains a distinctive query token.
 */
export function echoesQuery(payload, query) {
    if (typeof payload !== 'string' || typeof query !== 'string')
        return true;
    const tokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3);
    if (tokens.length === 0)
        return true;
    const lower = payload.toLowerCase();
    return tokens.some((token) => lower.includes(token));
}
/**
 * Parse the Firecrawl `/v1/search` JSON API.
 *
 * The endpoint is credential-free and answers
 * `{ success: true, data: [{ title, url, description }] }`, where `description`
 * is the page's extracted Markdown rather than a search snippet. Only the
 * opening prose is kept: a whole page in one snippet would push every other
 * engine's result out of the model-facing row.
 * @param payload - the response body.
 * @param baseUrl - the endpoint URL, used to resolve relative links.
 * @returns parsed sources in the served order; empty on drift.
 */
export function parseFirecrawl(payload, baseUrl) {
    let body;
    try {
        body = JSON.parse(payload);
    }
    catch {
        return [];
    }
    if (!isRecord(body) || body.success !== true)
        return [];
    const rows = body.data;
    if (!Array.isArray(rows))
        return [];
    const sources = [];
    for (const row of rows) {
        if (!isRecord(row))
            continue;
        const url = resolveHref(typeof row.url === 'string' ? row.url : undefined, baseUrl);
        if (url === undefined)
            continue;
        const title = typeof row.title === 'string' ? row.title.trim() : '';
        const description = typeof row.description === 'string' ? row.description : '';
        const snippet = excerpt(description, 240);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
        });
    }
    return sources;
}
/**
 * Parse an Exa MCP `web_search_exa` answer.
 *
 * The MCP server replies with one SSE frame whose `text` content lists results
 * as `Title: … / URL: … / Published: … / Author: … / Highlights: …` blocks
 * separated by `---`. The block is the only stable shape here, so it is parsed
 * line-wise; anything unexpected yields fewer rows, never an exception.
 * @param payload - the raw SSE body.
 * @param baseUrl - the MCP endpoint, used to resolve relative links.
 * @returns parsed sources in the served order; empty on drift.
 */
export function parseExaMcp(payload, baseUrl) {
    if (typeof payload !== 'string' || payload.length === 0)
        return [];
    const texts = [];
    for (const line of payload.split(/\r?\n/)) {
        if (!line.startsWith('data:'))
            continue;
        const chunk = line.slice(5).trim();
        if (chunk.length === 0 || chunk === '[DONE]')
            continue;
        try {
            const frame = JSON.parse(chunk);
            if (!isRecord(frame))
                continue;
            const result = frame.result;
            if (!isRecord(result))
                continue;
            const content = result.content;
            if (!Array.isArray(content))
                continue;
            for (const item of content) {
                if (isRecord(item) && item.type === 'text' && typeof item.text === 'string')
                    texts.push(item.text);
            }
        }
        catch {
            // A non-JSON frame is not fatal: the remaining frames may still parse.
        }
    }
    if (texts.length === 0)
        return [];
    const sources = [];
    for (const block of texts.join('\n').split(/\n-{3,}\n?/u)) {
        const lines = block.split(/\r?\n/);
        let title = '';
        let url;
        const highlights = [];
        let inHighlights = false;
        for (const line of lines) {
            if (/^title\s*:/i.test(line)) {
                title = line.replace(/^title\s*:/i, '').trim();
                inHighlights = false;
            }
            else if (/^url\s*:/i.test(line)) {
                url = resolveHref(line.replace(/^url\s*:/i, '').trim(), baseUrl);
                inHighlights = false;
            }
            else if (/^highlights\s*:/i.test(line)) {
                inHighlights = true;
            }
            else if (/^(published|author)\s*:/i.test(line)) {
                inHighlights = false;
            }
            else if (inHighlights) {
                highlights.push(line);
            }
        }
        if (url === undefined)
            continue;
        const snippet = excerpt(highlights.join(' '), 240);
        sources.push({
            url,
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
        });
    }
    return sources;
}
/**
 * Flatten a Markdown-ish page extract into one snippet line.
 * @param raw - the text to flatten.
 * @param max - the character ceiling.
 * @returns a single trimmed line, possibly empty.
 */
function excerpt(raw, max) {
    const flattened = raw
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (flattened.length <= max)
        return flattened;
    return `${flattened.slice(0, max - 1).trimEnd()}…`;
}
