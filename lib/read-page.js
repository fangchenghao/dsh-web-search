/**
 * The model-facing `read_page` tool: true resumable reading of a long page.
 *
 * The host's `web_fetch` request has exactly one field, `url` (see
 * `@deepseek-ai/dsh-web`'s `WebFetchRequest`), so the host itself cannot
 * continue a page from the middle: every call starts at the top and the tail is
 * lost behind the character budget. A plugin, however, owns its own tool
 * registry entry, so it can offer the missing `offset`.
 *
 * The design is two-layered on purpose:
 *
 * 1. one internal `createFetchProvider` fetch obtains the whole converted body,
 *    so the direct/tunnel/render/extraction ladder, its proxy handling and its
 *    live `renderJs` settings are reused rather than reimplemented;
 * 2. that body is then sliced for the caller. A 2,000,000-character safety cap
 *    keeps one hostile page from pinning memory, and it is applied once, after
 *    conversion, never to an individual chunk.
 *
 * Successful bodies are cached per URL, output format and fetch-affecting
 * settings, so walking a page chunk by chunk issues exactly one provider fetch
 * (the test suite counts the calls). Failures are not cached. The cache is a
 * bounded eight-entry LRU with no TTL: a long-lived plugin can serve an earlier
 * capture until another page evicts it, which is the price of exact paging.
 *
 * `truncated` describes the *source*: it is true when the safety cap or the
 * transport cut the body, so `totalLength` is then a lower bound. "There is
 * more to read" is signalled by `nextOffset`, not by `truncated`.
 *
 * The end-of-chunk hint is generated here, in `output.render`, and is
 * deliberately **not** part of `content`: concatenating the `content` of every
 * chunk therefore reproduces the complete body character for character.
 *
 * Offsets and lengths are JavaScript string code units, matching `String.length`
 * and the existing fetch budget. A chunk boundary is moved back one code unit
 * when it would split a surrogate pair, so an emoji is never broken across two
 * chunks; `nextOffset` follows that adjusted boundary.
 *
 * @module @fangchenghao/dsh-web-search/read-page
 */
import { createFetchProvider } from "./fetch.js";
import { DEFAULT_FETCH_MAX_LENGTH, renderFetchText } from "./markdown.js";
import { DEFAULT_RENDER_TIMEOUT_MS } from "./render.js";
/** The name this tool prefers. */
export const READ_PAGE_TOOL_NAME = 'read_page';
/** The name used when another plugin already registered `read_page`. */
export const READ_PAGE_TOOL_FALLBACK_NAME = 'web_read_page';
/** Smallest chunk a caller may request, matching `fetchMaxLength`'s floor. */
export const READ_PAGE_MIN_LENGTH = 1_000;
/** Largest chunk a caller may request, matching `fetchMaxLength`'s ceiling. */
export const READ_PAGE_MAX_LENGTH = 200_000;
/** Default chunk size when neither the caller nor the config names one. */
export const READ_PAGE_DEFAULT_LENGTH = DEFAULT_FETCH_MAX_LENGTH;
/**
 * Largest body this tool will hold. A page beyond it is cut once, after
 * conversion, and reported as `truncated`; chunks never pay this cost.
 */
export const READ_PAGE_INTERNAL_MAX_CHARS = 2_000_000;
/**
 * Byte budget handed to the fetch ladder. Four bytes per UTF-8 code point is
 * the worst case, so this is large enough for the full character cap while
 * still bounding what one response can allocate.
 */
export const READ_PAGE_MAX_BYTES = READ_PAGE_INTERNAL_MAX_CHARS * 4;
/** How many converted pages stay cached per mounted tool. */
export const READ_PAGE_CACHE_ENTRIES = 8;
/** Internal fetch provider ids, one per output format. */
export const READ_PAGE_PROVIDER_ID = 'http-proxy-read-page';
/** True for a value usable as a record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The parameter schema, in the registry's raw JSON-Schema dialect. */
function parameterSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            url: {
                type: 'string',
                description: 'Absolute http(s) URL of the page to read.',
            },
            offset: {
                type: 'integer',
                description: 'First character to return, zero-based. Omit or use 0 for the first chunk; then pass the previous response\'s nextOffset.',
            },
            maxLength: {
                type: 'integer',
                description: `Characters to return, ${READ_PAGE_MIN_LENGTH}–${READ_PAGE_MAX_LENGTH}. Omit to use the configured fetchMaxLength.`,
            },
            format: {
                type: 'string',
                enum: ['markdown', 'text'],
                description: 'Output style: markdown keeps headings, lists, tables and links; text keeps only the words. Omit to use the configured fetchFormat.',
            },
        },
        required: ['url'],
    };
}
/** The output schema, in the same dialect. */
function outputSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            url: { type: 'string' },
            content: { type: 'string' },
            offset: { type: 'integer' },
            // A nullable integer is not expressible in the small dialect this module
            // uses, so this field deliberately carries no `type`: its description is
            // the contract.
            nextOffset: { description: 'Offset to pass on the next call, or null when the page is finished. A surrogate-pair boundary can make it one less than offset+maxLength.' },
            totalLength: { type: 'integer' },
            truncated: { type: 'boolean' },
            chunk: {
                type: 'object',
                description: 'Progress for this call\'s maxLength; index is 1-based.',
                additionalProperties: false,
                properties: {
                    index: { type: 'integer' },
                    count: { type: 'integer' },
                },
                required: ['index', 'count'],
            },
            failures: { type: 'array', items: { type: 'string' } },
            render: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mode: { type: 'string', enum: ['auto', 'always', 'off'] },
                    attempted: { type: 'boolean' },
                    applied: { type: 'boolean' },
                    reason: { type: 'string' },
                },
                required: ['mode', 'attempted', 'applied', 'reason'],
            },
        },
        required: ['url', 'content', 'offset', 'nextOffset', 'totalLength', 'truncated', 'chunk', 'failures'],
    };
}
/** Parse and validate the URL, throwing a message the model can act on. */
function parseUrl(raw) {
    if (typeof raw !== 'string')
        throw new Error('read_page requires a url string');
    const url = raw.trim();
    if (url.length === 0)
        throw new Error('read_page requires a non-empty url');
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`read_page: not a valid absolute URL: ${JSON.stringify(url)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`read_page: url must use http or https, got ${parsed.protocol}`);
    }
    if (parsed.hostname.length === 0) {
        throw new Error(`read_page: url has no host: ${JSON.stringify(url)}`);
    }
    return url;
}
/** Parse the optional zero-based character offset. */
function parseOffset(raw) {
    if (raw === undefined)
        return 0;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        throw new Error(`read_page offset must be a safe integer >= 0, got ${JSON.stringify(raw)}`);
    }
    return raw;
}
/** Normalise the config defaults, never throwing because of a bad config value. */
function defaultLength(settings) {
    const value = settings.maxLength;
    return Number.isSafeInteger(value) && value >= READ_PAGE_MIN_LENGTH && value <= READ_PAGE_MAX_LENGTH
        ? value
        : READ_PAGE_DEFAULT_LENGTH;
}
/** Normalise the configured default format. */
function defaultFormat(settings) {
    return settings.format === 'text' ? 'text' : 'markdown';
}
/** Parse the optional chunk size against the documented range. */
function parseMaxLength(raw, fallback) {
    if (raw === undefined)
        return fallback;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)
        || raw < READ_PAGE_MIN_LENGTH || raw > READ_PAGE_MAX_LENGTH) {
        throw new Error(`read_page maxLength must be an integer between ${READ_PAGE_MIN_LENGTH} and ${READ_PAGE_MAX_LENGTH}, got ${JSON.stringify(raw)}`);
    }
    return raw;
}
/** Parse the optional output style. */
function parseFormat(raw, fallback) {
    if (raw === undefined)
        return fallback;
    if (raw !== 'markdown' && raw !== 'text') {
        throw new Error(`read_page format must be "markdown" or "text", got ${JSON.stringify(raw)}`);
    }
    return raw;
}
/** Parse model arguments into a validated shape, throwing on nonsense. */
function parseArgs(args, settings) {
    if (!isRecord(args))
        throw new Error('read_page requires arguments');
    return {
        url: parseUrl(args['url']),
        offset: parseOffset(args['offset']),
        maxLength: parseMaxLength(args['maxLength'], defaultLength(settings)),
        format: parseFormat(args['format'], defaultFormat(settings)),
    };
}
/** A signature for everything that can change what the internal fetch returns. */
function fetchSignature(format, settings) {
    return [
        format,
        settings.renderJs ?? 'auto',
        settings.renderTimeoutMs ?? '',
        settings.timeoutMs ?? '',
        settings.proxy ?? '',
        settings.anysearchApiKey ?? '',
    ].join('\u0000');
}
/** Cut an over-long body once, without leaving half of a surrogate pair. */
function capBody(content) {
    if (content.length <= READ_PAGE_INTERNAL_MAX_CHARS)
        return { content, truncated: false };
    let cut = content.slice(0, READ_PAGE_INTERNAL_MAX_CHARS);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        cut = cut.slice(0, -1);
    return { content: cut, truncated: true };
}
/** Build the production provider: the same ladder, with an effectively unlimited budget. */
function createDefaultProvider(format, settings, readSettings) {
    const proxy = (settings.proxy ?? '').trim();
    const apiKey = (settings.anysearchApiKey ?? '').trim();
    const options = {
        id: `${READ_PAGE_PROVIDER_ID}-${format}`,
        format,
        // No per-request truncation: `read_page` applies one cap to the whole body
        // and then slices it. The huge budget makes `truncateFetchText` a no-op.
        maxLength: Number.MAX_SAFE_INTEGER,
        maxBytes: READ_PAGE_MAX_BYTES,
        // The renderer policy stays live for the lifetime of this provider.
        renderJs: () => readSettings().renderJs ?? 'auto',
        renderTimeoutMs: () => readSettings().renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
        ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
        ...(proxy.length === 0 ? {} : { proxy }),
        ...(apiKey.length === 0 ? {} : { anysearchApiKey: apiKey }),
    };
    return createFetchProvider(options);
}
/** Build the value reported for a fetch that failed. */
function failureValue(url, offset, failure, render) {
    const value = {
        url,
        content: '',
        offset,
        nextOffset: null,
        totalLength: 0,
        truncated: false,
        chunk: { index: 1, count: 1 },
        failures: [failure],
    };
    if (render !== undefined)
        value.render = render;
    return value;
}
/**
 * Build the end-of-chunk hint. This is the tool's own text, kept out of
 * `content` so chunk concatenation stays byte-for-byte exact.
 */
function endHint(value) {
    if (value.totalLength === 0)
        return '[the page has no readable text]';
    if (value.nextOffset === null) {
        return value.truncated
            ? `[end of page at the ${READ_PAGE_INTERNAL_MAX_CHARS}-character safety cap: ${value.totalLength} characters total]`
            : `[end of page: ${value.totalLength} characters total]`;
    }
    const remaining = value.totalLength - value.nextOffset;
    return value.truncated
        ? `[${remaining} characters remain; continue with offset=${value.nextOffset}; the source was truncated at the ${READ_PAGE_INTERNAL_MAX_CHARS}-character safety cap]`
        : `[${remaining} characters remain; continue with offset=${value.nextOffset}]`;
}
/** Format the model-facing result text: the chunk, then exactly one hint line. */
export function formatReadPageValue(value) {
    if (value.failures.length > 0) {
        return [
            `read_page could not read ${value.url}.`,
            ...value.failures.map((failure) => `- ${failure}`),
        ].join('\n');
    }
    const hint = endHint(value);
    return value.content.length === 0 ? hint : `${value.content}\n\n${hint}`;
}
/**
 * Build the tool definition the host registry accepts.
 * @param name - `read_page`, or the fallback when that name is taken.
 * @param readSettings - read the live config for every call.
 * @param options - test seams and diagnostics.
 * @returns a registry-ready definition.
 */
export function createReadPageDefinition(name, readSettings, options = {}) {
    /** Complete bodies, so walking a page chunk by chunk fetches it once. */
    const pages = new Map();
    /** Providers are per format and per fetch-affecting settings. */
    const providers = new Map();
    /** Remember a body, evicting the oldest entry when the small cache is full. */
    const remember = (key, page) => {
        if (pages.size >= READ_PAGE_CACHE_ENTRIES) {
            const oldest = pages.keys().next();
            if (!oldest.done)
                pages.delete(oldest.value);
        }
        pages.set(key, { ...page });
    };
    /** Fetch a page through the internal ladder, or reuse the cached body. */
    const load = async (url, format, settings, signal) => {
        const signature = fetchSignature(format, settings);
        const cacheKey = `${signature}\u0000${url}`;
        const cached = pages.get(cacheKey);
        if (cached !== undefined) {
            // Refresh insertion order: this is a tiny LRU, not a FIFO.
            pages.delete(cacheKey);
            pages.set(cacheKey, cached);
            return { ok: true, page: cached };
        }
        let provider = providers.get(signature);
        if (provider === undefined) {
            provider = options.createProvider !== undefined
                ? options.createProvider(format, settings)
                : createDefaultProvider(format, settings, readSettings);
            if (providers.size >= READ_PAGE_CACHE_ENTRIES) {
                const oldest = providers.keys().next();
                if (!oldest.done)
                    providers.delete(oldest.value);
            }
            providers.set(signature, provider);
        }
        let outcome;
        try {
            if (provider.available() === false) {
                return { ok: false, failure: `read_page: the fetch provider for ${url} is unavailable` };
            }
            outcome = await provider.fetch({ url }, signal);
        }
        catch (error) {
            // A caller cancellation is not a page failure; let it travel.
            if (signal?.aborted === true)
                throw error;
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, failure: `read_page: ${reason}` };
        }
        if (outcome.statusCode < 200 || outcome.statusCode >= 300) {
            return {
                ok: false,
                failure: `read_page: HTTP ${outcome.statusCode} for ${url}`,
                ...(outcome.render === undefined ? {} : { render: outcome.render }),
            };
        }
        // The provider normally finalises HTML to text already; the fallback keeps
        // this tool correct for a substituted provider that returns markup.
        const raw = outcome.body.kind === 'text'
            ? outcome.body.content
            : renderFetchText(outcome.body.content, {
                format,
                maxLength: Number.MAX_SAFE_INTEGER,
                baseUrl: outcome.url,
            }).content;
        const capped = capBody(raw);
        const page = {
            content: capped.content,
            truncated: outcome.truncated || capped.truncated,
            ...(outcome.render === undefined ? {} : { render: outcome.render }),
        };
        remember(cacheKey, page);
        return { ok: true, page };
    };
    return {
        name,
        description: 'Read a long web page in character chunks. Fetches the page once with the same fallback ladder as web_fetch, then returns characters [offset, offset+maxLength) of the converted text. Pass nextOffset back as offset to continue until nextOffset is null. A boundary is moved back one code unit when it would split a surrogate pair, so nextOffset can be one less than offset+maxLength. Use it instead of web_fetch when a page is longer than the fetch budget and you need the rest. A network, HTTP or blocked failure is reported in failures with empty content, never thrown.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: formatReadPageValue(value) }],
        },
        // A single fetch may try direct, tunnel, a browser and extraction in turn.
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const settings = readSettings();
            const parsed = parseArgs(args, settings);
            const loaded = await load(parsed.url, parsed.format, settings, exec.signal);
            if (!loaded.ok) {
                return failureValue(parsed.url, parsed.offset, loaded.failure, loaded.render);
            }
            const page = loaded.page;
            const totalLength = page.content.length;
            if (parsed.offset > totalLength) {
                throw new Error(`read_page: offset ${parsed.offset} is past the end of ${parsed.url} (totalLength ${totalLength}); use offset 0 to start over or ${totalLength} to read the tail`);
            }
            // Keep surrogate pairs intact at the cut point. `nextOffset` follows the
            // adjusted end, so the concatenated chunks still equal the full body.
            let end = Math.min(totalLength, parsed.offset + parsed.maxLength);
            if (end > parsed.offset && end < totalLength) {
                const last = page.content.charCodeAt(end - 1);
                if (last >= 0xd800 && last <= 0xdbff)
                    end -= 1;
            }
            const content = page.content.slice(parsed.offset, end);
            const nextOffset = end < totalLength ? end : null;
            const count = totalLength === 0 ? 1 : Math.ceil(totalLength / parsed.maxLength);
            const index = totalLength === 0
                ? 1
                : Math.min(count, Math.floor(parsed.offset / parsed.maxLength) + 1);
            const value = {
                url: parsed.url,
                content,
                offset: parsed.offset,
                nextOffset,
                totalLength,
                truncated: page.truncated,
                chunk: { index, count },
                failures: [],
            };
            if (page.render !== undefined)
                value.render = page.render;
            return value;
        },
    };
}
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickReadPageToolName(tools) {
    if (typeof tools.get !== 'function')
        return READ_PAGE_TOOL_NAME;
    try {
        return tools.get(READ_PAGE_TOOL_NAME) === undefined ? READ_PAGE_TOOL_NAME : READ_PAGE_TOOL_FALLBACK_NAME;
    }
    catch {
        return READ_PAGE_TOOL_NAME;
    }
}
/** Report a registration failure without throwing out of the plugin. */
function report(options, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
        options.warn?.(`read_page registration skipped: ${message}`);
    }
    catch {
        // A diagnostic callback must never break plugin loading.
    }
}
/**
 * Register the tool when a registry is available.
 *
 * The failure paths mirror `search_many`: a duplicate name falls back, and a
 * registry rejection is reported and swallowed so the other tools keep working.
 * The returned registration owns the host disposer, so plugin disposal removes
 * exactly the definition this call added.
 *
 * @param tools - the live registry.
 * @param readSettings - live config reader.
 * @param options - test seams and diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerReadPageTool(tools, readSettings, options = {}) {
    const name = pickReadPageToolName(tools);
    try {
        const registered = tools.register(createReadPageDefinition(name, readSettings, options));
        const disposeHost = typeof registered === 'function' ? registered : undefined;
        let disposed = false;
        return {
            name,
            dispose: () => {
                if (disposed)
                    return;
                disposed = true;
                try {
                    disposeHost?.();
                }
                catch {
                    // Disposal must stay contained; the plugin is already going away.
                }
            },
        };
    }
    catch (error) {
        report(options, error);
        return undefined;
    }
}
