/**
 * The model-facing `advanced_search` tool: one search with a per-call date
 * window.
 *
 * `web_search` takes only a query and a result count, and the Settings
 * `timeRange` applies to every ordinary search. This tool is the narrow escape
 * hatch for the common case where only one question needs a window ("what
 * changed this week?"), without asking the user to change a global setting.
 *
 * It shares the engine, cache and cooldown path with `web_search`; the only
 * difference is the `timeRange` override, so an `off` call can reuse an ordinary
 * cached search and a `week` call gets its own cache key.
 *
 * @module @fangchenghao/dsh-web-search/advanced-search
 */
import { TIME_RANGES } from "./freshness.js";
import { wrapUntrustedContent } from "./untrusted.js";
/** The name this tool prefers. */
export const ADVANCED_SEARCH_TOOL_NAME = 'advanced_search';
/** The name used when another plugin already registered `advanced_search`. */
export const ADVANCED_SEARCH_FALLBACK_NAME = 'web_search_advanced';
/** Default result budget when the caller names none. */
export const ADVANCED_SEARCH_DEFAULT_LIMIT = 5;
/** Largest result budget the tool accepts; the deployment limit still caps it. */
export const ADVANCED_SEARCH_MAX_LIMIT = 20;
/**
 * Explain an undated row when a window is active.
 *
 * The engine path prefers dated results inside the window, but falls back to
 * undated rows when no dated result lands inside it. Saying so keeps the model
 * from presenting an undated row as a confirmed "this week" item.
 * @param sources - the rows returned by the search.
 * @param timeRange - the effective window.
 * @returns one sentence, or `undefined` when every row is dated or the window is off.
 */
export function undatedWindowNote(sources, timeRange) {
    if (timeRange === 'off')
        return undefined;
    const undated = sources.filter((source) => source.publishedAt === undefined).length;
    if (undated === 0)
        return undefined;
    return `The ${timeRange} publication window is on, but ${undated} of ${sources.length} result(s) have no publication date, so they are not proven to fall inside it.`;
}
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
            query: {
                type: 'string',
                description: 'The search query. Put the distinctive words in it; do not paste a whole document.',
            },
            maxResults: {
                type: 'integer',
                description: `Results wanted, 1–${ADVANCED_SEARCH_MAX_LIMIT}; defaults to ${ADVANCED_SEARCH_DEFAULT_LIMIT}. The deployment limit still caps it.`,
            },
            timeRange: {
                type: 'string',
                enum: [...TIME_RANGES],
                description: 'Publication window for this call: off, day, week, month or year. Omit to use the deployment setting; off disables the window for this query only.',
            },
        },
        required: ['query'],
    };
}
/** The output schema, in the same dialect. */
function outputSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string' },
            timeRange: { type: 'string', enum: [...TIME_RANGES] },
            sources: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        url: { type: 'string' },
                        title: { type: 'string' },
                        snippet: { type: 'string' },
                        publishedAt: { type: 'string' },
                    },
                    required: ['url'],
                },
            },
            failures: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
            truncated: { type: 'boolean' },
        },
        required: ['query', 'timeRange', 'sources', 'failures', 'truncated'],
    };
}
/** Parse model arguments into a validated shape, throwing on nonsense. */
function parseArgs(args) {
    if (!isRecord(args))
        throw new Error('advanced_search requires arguments');
    const rawQuery = args['query'];
    if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
        throw new Error('advanced_search requires a non-empty query');
    }
    const query = rawQuery.trim();
    const rawLimit = args['maxResults'];
    let maxResults = ADVANCED_SEARCH_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
        if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit)
            || rawLimit < 1 || rawLimit > ADVANCED_SEARCH_MAX_LIMIT) {
            throw new Error(`advanced_search maxResults must be an integer between 1 and ${ADVANCED_SEARCH_MAX_LIMIT}`);
        }
        maxResults = rawLimit;
    }
    const rawRange = args['timeRange'];
    if (rawRange === undefined)
        return { query, maxResults };
    if (typeof rawRange !== 'string' || !TIME_RANGES.includes(rawRange)) {
        throw new Error(`advanced_search timeRange must be one of ${TIME_RANGES.join(', ')}`);
    }
    return { query, maxResults, timeRange: rawRange };
}
/**
 * Remove a relative window phrase that the structured window already carries.
 * "过去 7 天内 Chrome…" searches for `7` and `内`, not for Chrome; with an
 * explicit `timeRange` the phrase is redundant and only adds noise.
 * @param query - the caller's query.
 * @returns the query without a relative-time phrase, or the original when the
 *   removal would leave nothing.
 */
export function stripRelativeWindow(query) {
    const cleaned = query
        .replace(/(?:过去|最近)\s*(?:\d+|一|几|半)\s*(?:天|日|周|星期|个月|月|年)(?:内|里|以内)?/gu, ' ')
        .replace(/\b(?:in\s+the\s+)?(?:past|last)\s+\d+\s+(?:days?|weeks?|months?|years?)\b/giu, ' ')
        .replace(/\s+/gu, ' ')
        .replace(/^[\s,，。.;；:：]+|[\s,，。.;；:：]+$/gu, '')
        .trim();
    return cleaned.length > 0 ? cleaned : query;
}
/** Format the model-facing result text. */
export function formatAdvancedSearchValue(value) {
    const head = `Search: ${JSON.stringify(value.query)} (timeRange=${value.timeRange}) — `
        + `${value.sources.length} result(s)${value.truncated ? ' (truncated)' : ''}.`;
    const lines = value.sources.map((source, index) => {
        const title = source.title !== undefined && source.title.length > 0 ? source.title : source.url;
        const parts = [`${index + 1}. ${title}`, `   ${source.url}`];
        if (source.snippet !== undefined && source.snippet.length > 0)
            parts.push(`   ${source.snippet}`);
        if (source.publishedAt !== undefined && source.publishedAt.length > 0)
            parts.push(`   ${source.publishedAt}`);
        return parts.join('\n');
    });
    if (value.note !== undefined && value.note.length > 0)
        lines.push(`Note: ${value.note}`);
    if (value.failures.length > 0)
        lines.push(`failures: ${value.failures.join('; ')}`);
    return [head, '', ...lines].join('\n').trimEnd();
}
/**
 * Build the tool definition the host registry accepts.
 * @param name - `advanced_search`, or the fallback when that name is taken.
 * @param runSearch - executes one search through the plugin's normal path.
 * @returns a registry-ready definition.
 */
export function createAdvancedSearchDefinition(name, runSearch) {
    return {
        name,
        description: 'Search the web with an optional publication-time window for this call. Use it instead of web_search when one query needs results from the last day, week, month or year. Returns ranked candidates (URL, title, snippet, date), not page bodies.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: wrapUntrustedContent(formatAdvancedSearchValue(value)) }],
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseArgs(args);
            const searchQuery = parsed.timeRange === undefined || parsed.timeRange === 'off'
                ? parsed.query
                : stripRelativeWindow(parsed.query);
            const outcome = await runSearch(searchQuery, parsed.maxResults, parsed.timeRange, exec.signal);
            return {
                query: parsed.query,
                timeRange: outcome.timeRange,
                sources: outcome.sources.slice(0, parsed.maxResults).map((source) => ({ ...source })),
                failures: [...outcome.failures],
                ...(outcome.note === undefined ? {} : { note: outcome.note }),
                truncated: outcome.truncated || outcome.sources.length > parsed.maxResults,
            };
        },
    };
}
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickAdvancedSearchToolName(tools) {
    if (typeof tools.get !== 'function')
        return ADVANCED_SEARCH_TOOL_NAME;
    try {
        return tools.get(ADVANCED_SEARCH_TOOL_NAME) === undefined
            ? ADVANCED_SEARCH_TOOL_NAME
            : ADVANCED_SEARCH_FALLBACK_NAME;
    }
    catch {
        return ADVANCED_SEARCH_TOOL_NAME;
    }
}
/** Report a registration failure without throwing out of the plugin. */
function report(options, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
        options.warn?.(`advanced_search registration skipped: ${message}`);
    }
    catch {
        // A diagnostic callback must never break plugin loading.
    }
}
/**
 * Register the tool when a registry is available.
 * @param tools - the live registry.
 * @param runSearch - executes one search through the plugin's normal path.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerAdvancedSearchTool(tools, runSearch, options = {}) {
    const name = pickAdvancedSearchToolName(tools);
    try {
        const registered = tools.register(createAdvancedSearchDefinition(name, runSearch));
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
