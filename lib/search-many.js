/** The name this tool prefers. */
export const SEARCH_MANY_TOOL_NAME = 'search_many';
/** The name used when another plugin already registered `search_many`. */
export const SEARCH_MANY_FALLBACK_NAME = 'web_search_many';
/** How many queries run at the same time; deliberately below the engine count. */
export const SEARCH_MANY_CONCURRENCY = 3;
/** Queries accepted in one call. */
export const SEARCH_MANY_MIN_QUERIES = 1;
/** Queries accepted in one call. */
export const SEARCH_MANY_MAX_QUERIES = 5;
/** Default result budget for a query that names none. */
export const SEARCH_MANY_DEFAULT_LIMIT = 5;
/** Largest per-query budget the tool accepts. */
export const SEARCH_MANY_MAX_LIMIT = 20;
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
            queries: {
                type: 'array',
                items: { type: 'string' },
                description: `The searches to run, ${SEARCH_MANY_MIN_QUERIES}–${SEARCH_MANY_MAX_QUERIES} independent queries. Each runs as its own \`web_search\`.`,
            },
            limit: {
                type: 'integer',
                description: `Results wanted per query, 1–${SEARCH_MANY_MAX_LIMIT}; defaults to ${SEARCH_MANY_DEFAULT_LIMIT}.`,
            },
            withSites: {
                type: 'boolean',
                description: 'Attach the result hostname to every source. Defaults to false.',
            },
        },
        required: ['queries'],
    };
}
/** The output schema, in the same dialect. */
function outputSchema() {
    const sourceSchema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            snippet: { type: 'string' },
            publishedAt: { type: 'string' },
            site: { type: 'string' },
        },
        required: ['url'],
    };
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            results: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        query: { type: 'string' },
                        sources: { type: 'array', items: sourceSchema },
                        failures: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['query', 'sources', 'failures'],
                },
            },
            truncated: { type: 'boolean' },
        },
        required: ['results', 'truncated'],
    };
}
/** Parse model arguments into a validated shape, throwing on nonsense. */
function parseArgs(args) {
    if (!isRecord(args))
        throw new Error('search_many requires arguments');
    const rawQueries = args['queries'];
    if (!Array.isArray(rawQueries)) {
        throw new Error(`search_many requires a queries array with ${SEARCH_MANY_MIN_QUERIES}–${SEARCH_MANY_MAX_QUERIES} entries`);
    }
    if (rawQueries.length < SEARCH_MANY_MIN_QUERIES || rawQueries.length > SEARCH_MANY_MAX_QUERIES) {
        throw new Error(`search_many accepts ${SEARCH_MANY_MIN_QUERIES}–${SEARCH_MANY_MAX_QUERIES} queries, got ${rawQueries.length}`);
    }
    const queries = [];
    for (const raw of rawQueries) {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
            throw new Error('search_many requires every query to be a non-empty string');
        }
        queries.push(raw.trim());
    }
    const rawLimit = args['limit'];
    let limit = SEARCH_MANY_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
        if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit)
            || rawLimit < 1 || rawLimit > SEARCH_MANY_MAX_LIMIT) {
            throw new Error(`search_many limit must be an integer between 1 and ${SEARCH_MANY_MAX_LIMIT}`);
        }
        limit = rawLimit;
    }
    const rawSites = args['withSites'];
    if (rawSites !== undefined && typeof rawSites !== 'boolean') {
        throw new Error('search_many withSites must be a boolean');
    }
    return { queries, limit, withSites: rawSites === true };
}
/** Return the hostname a source is served from, or `undefined` for a bad URL. */
function siteOf(url) {
    try {
        const host = new URL(url).hostname.trim().toLowerCase();
        return host.length === 0 ? undefined : host;
    }
    catch {
        return undefined;
    }
}
/** Attach the hostname without mutating the cached source object. */
function withSite(source) {
    const site = siteOf(source.url);
    return site === undefined ? { ...source } : { ...source, site };
}
/**
 * Run `worker` over items with at most `limit` in flight, preserving order.
 * A dedicated helper keeps the concurrency contract visible instead of relying
 * on an unstated promise-pool behaviour.
 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
/** Format the model-facing result text. */
export function formatSearchManyValue(value) {
    const total = value.results.reduce((sum, result) => sum + result.sources.length, 0);
    const failed = value.results.reduce((sum, result) => sum + result.failures.length, 0);
    const head = `Batch search: ${value.results.length} quer${value.results.length === 1 ? 'y' : 'ies'}, `
        + `${total} result(s)${failed === 0 ? '' : `, ${failed} failure(s)`}${value.truncated ? ' (truncated)' : ''}.`;
    const sections = value.results.map((result, index) => {
        const lines = [`${index + 1}. ${JSON.stringify(result.query)} — ${result.sources.length} result(s)`];
        for (const [position, source] of result.sources.entries()) {
            const title = source.title !== undefined && source.title.length > 0 ? source.title : source.url;
            lines.push(`   ${position + 1}. ${title}`);
            lines.push(`      ${source.url}${source.site === undefined ? '' : ` [${source.site}]`}`);
            if (source.snippet !== undefined && source.snippet.length > 0)
                lines.push(`      ${source.snippet}`);
            if (source.publishedAt !== undefined && source.publishedAt.length > 0) {
                lines.push(`      ${source.publishedAt}`);
            }
        }
        if (result.failures.length > 0)
            lines.push(`   failures: ${result.failures.join('; ')}`);
        return lines.join('\n');
    });
    return [head, '', ...sections].join('\n').trimEnd();
}
/**
 * Build the tool definition the host registry accepts.
 * @param name - `search_many`, or the fallback when that name is taken.
 * @param runQuery - executes one search through the plugin's normal path.
 * @returns a registry-ready definition.
 */
export function createSearchManyDefinition(name, runQuery) {
    return {
        name,
        description: 'Run 1–5 independent web searches in one call and return each query\'s results separately. Use it when one question needs several distinct queries; a failed query does not stop the others. For a single query use web_search.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: formatSearchManyValue(value) }],
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseArgs(args);
            const outcomes = await mapLimit(parsed.queries, SEARCH_MANY_CONCURRENCY, async (query) => {
                try {
                    const outcome = await runQuery(query, parsed.limit, exec.signal);
                    const mapped = parsed.withSites
                        ? outcome.sources.map(withSite)
                        : outcome.sources.map((source) => ({ ...source }));
                    const truncated = outcome.truncated || mapped.length > parsed.limit;
                    return {
                        result: {
                            query,
                            sources: mapped.slice(0, parsed.limit),
                            failures: [...outcome.failures],
                        },
                        truncated,
                    };
                }
                catch (error) {
                    return {
                        result: {
                            query,
                            sources: [],
                            failures: [error instanceof Error ? error.message : String(error)],
                        },
                        truncated: false,
                    };
                }
            });
            return {
                results: outcomes.map((entry) => entry.result),
                truncated: outcomes.some((entry) => entry.truncated),
            };
        },
    };
}
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickSearchManyToolName(tools) {
    if (typeof tools.get !== 'function')
        return SEARCH_MANY_TOOL_NAME;
    try {
        return tools.get(SEARCH_MANY_TOOL_NAME) === undefined ? SEARCH_MANY_TOOL_NAME : SEARCH_MANY_FALLBACK_NAME;
    }
    catch {
        return SEARCH_MANY_TOOL_NAME;
    }
}
/** Report a registration failure without throwing out of the plugin. */
function report(options, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
        options.warn?.(`search_many registration skipped: ${message}`);
    }
    catch {
        // A diagnostic callback must never break plugin loading.
    }
}
/**
 * Register the tool when a registry is available.
 *
 * Every failure path is contained: a duplicate name falls back, and any
 * registry rejection is reported and swallowed so `web_search` keeps working.
 * The returned registration owns the host disposer, so plugin disposal removes
 * exactly the definition this call added.
 *
 * @param tools - the live registry.
 * @param runQuery - executes one search through the plugin's normal path.
 * @param options - diagnostics.
 * @returns the registered name and its disposer, or `undefined` when skipped.
 */
export function registerSearchManyTool(tools, runQuery, options = {}) {
    const name = pickSearchManyToolName(tools);
    try {
        const registered = tools.register(createSearchManyDefinition(name, runQuery));
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
