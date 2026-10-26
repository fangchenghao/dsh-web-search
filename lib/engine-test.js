import { wrapUntrustedContent } from "./untrusted.js";
import { HOSTS } from "./engines.js";
/** The name this tool prefers. */
export const ENGINE_TEST_TOOL_NAME = 'engine_test';
/** The name used when another plugin already registered `engine_test`. */
export const ENGINE_TEST_FALLBACK_NAME = 'web_engine_test';
/** Default query; broad enough that every engine has an answer. */
export const ENGINE_TEST_DEFAULT_QUERY = 'DeepSeek Harness';
/** How many engines one run may ask at the same time. */
const ENGINE_TEST_CONCURRENCY = 3;
/** True for a value usable as a record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** One short error line for the tool output. */
function failureReason(outcome) {
    return outcome.failureDetails[0]?.reason ?? outcome.failures[0];
}
/** Run `worker` over items with at most `limit` in flight, preserving order. */
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
/** The parameter schema, in the registry's raw JSON-Schema dialect. */
function parameterSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            engine: {
                type: 'string',
                description: `Optional engine id to test alone, e.g. anysearch, exa, or ddg-html. Omit to test all ${HOSTS.length} engines.`,
            },
            query: {
                type: 'string',
                description: `Optional probe query; defaults to ${JSON.stringify(ENGINE_TEST_DEFAULT_QUERY)}.`,
            },
        },
    };
}
/** The output schema, in the same dialect. */
function outputSchema() {
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            query: { type: 'string' },
            ok: { type: 'integer' },
            failed: { type: 'integer' },
            results: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        engine: { type: 'string' },
                        ok: { type: 'boolean' },
                        latencyMs: { type: 'integer' },
                        count: { type: 'integer' },
                        failureKind: { type: 'string' },
                        code: { type: 'string' },
                        status: { type: 'integer' },
                        reason: { type: 'string' },
                        sample: { type: 'string' },
                    },
                    required: ['engine', 'ok', 'latencyMs', 'count'],
                },
            },
        },
        required: ['query', 'ok', 'failed', 'results'],
    };
}
/** Format the model-facing result text. */
export function formatEngineTestValue(value) {
    const head = `Engine test (${value.query}): ${value.ok} OK, ${value.failed} failed.`;
    const lines = value.results.map((result) => {
        if (result.ok) {
            const sample = result.sample === undefined ? '' : ` — ${result.sample}`;
            return `- ${result.engine}: OK (${result.latencyMs}ms, ${result.count} result(s))${sample}`;
        }
        const kind = result.failureKind === undefined ? '' : ` [${result.failureKind}]`;
        const reason = result.reason === undefined ? 'no result' : result.reason;
        return `- ${result.engine}: FAIL${kind} (${result.latencyMs}ms) ${reason}`;
    });
    return [head, '', ...lines].join('\n');
}
/** Parse model arguments into a validated shape, throwing on nonsense. */
function parseArgs(args) {
    if (!isRecord(args))
        throw new Error('engine_test requires arguments');
    const rawEngine = args['engine'];
    let engine;
    if (rawEngine !== undefined) {
        if (typeof rawEngine !== 'string' || rawEngine.trim().length === 0) {
            throw new Error('engine_test engine must be a non-empty string');
        }
        engine = rawEngine.trim();
        if (!HOSTS.some((host) => host.id === engine)) {
            throw new Error(`engine_test unknown engine ${JSON.stringify(engine)}; expected one of ${HOSTS.map((host) => host.id).join(', ')}`);
        }
    }
    const rawQuery = args['query'];
    let query = ENGINE_TEST_DEFAULT_QUERY;
    if (rawQuery !== undefined) {
        if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
            throw new Error('engine_test query must be a non-empty string');
        }
        query = rawQuery.trim();
    }
    return { engine, query };
}
/**
 * Run a list of engines and assemble the tool value.
 *
 * Exported so the Settings bridge and the model tool share one implementation
 * of latency, sample and failure reporting.
 *
 * @param runTest - tests one engine through the normal search path.
 * @param engines - engine ids to test, in display order.
 * @param query - probe query.
 * @param signal - cancellation from the caller.
 * @returns per-engine results plus counts.
 */
export async function runEngineTestValue(runTest, engines, query, signal) {
    const results = await mapLimit(engines, ENGINE_TEST_CONCURRENCY, async (engine) => {
        const started = Date.now();
        try {
            const outcome = await runTest(engine, query, signal);
            const latencyMs = Date.now() - started;
            if (outcome.sources.length > 0) {
                const first = outcome.sources[0];
                return {
                    engine,
                    ok: true,
                    latencyMs,
                    count: outcome.sources.length,
                    ...(first.title === undefined || first.title.length === 0 ? {} : { sample: first.title }),
                };
            }
            const detail = outcome.failureDetails[0];
            const reason = failureReason(outcome) ?? 'no result';
            return {
                engine,
                ok: false,
                latencyMs,
                count: 0,
                ...(detail?.kind === undefined ? {} : { failureKind: detail.kind }),
                ...(detail?.code === undefined ? {} : { code: detail.code }),
                ...(detail?.status === undefined ? {} : { status: detail.status }),
                reason,
            };
        }
        catch (error) {
            return {
                engine,
                ok: false,
                latencyMs: Date.now() - started,
                count: 0,
                failureKind: 'unknown',
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    });
    const ok = results.filter((result) => result.ok).length;
    return { query, results, ok, failed: results.length - ok };
}
/**
 * Build the tool definition the host registry accepts.
 * @param name - `engine_test`, or the fallback when that name is taken.
 * @param runTest - tests one engine through the normal search path.
 * @returns a registry-ready definition.
 */
export function createEngineTestDefinition(name, runTest) {
    return {
        name,
        description: 'Test the available search engines with one probe each and report which answered, their latency, and a failure class (quota, auth, bot-wall, transient, invalid-response) for the rest. Use it when search fails or is slow; it never changes the cache, fallback or cooldown state.',
        parameters: parameterSchema(),
        output: {
            schema: outputSchema(),
            render: (_args, value) => [{ type: 'text', text: wrapUntrustedContent(formatEngineTestValue(value)) }],
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseArgs(args);
            const engines = parsed.engine === undefined ? HOSTS.map((host) => host.id) : [parsed.engine];
            return runEngineTestValue(runTest, engines, parsed.query, exec.signal);
        },
    };
}
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export function pickEngineTestToolName(tools) {
    if (typeof tools.get !== 'function')
        return ENGINE_TEST_TOOL_NAME;
    try {
        return tools.get(ENGINE_TEST_TOOL_NAME) === undefined ? ENGINE_TEST_TOOL_NAME : ENGINE_TEST_FALLBACK_NAME;
    }
    catch {
        return ENGINE_TEST_TOOL_NAME;
    }
}
/** Report a registration failure without throwing out of the plugin. */
export function warnEngineTest(message) {
    try {
        console.warn(`[dsh-web-search-bing] ${message}`);
    }
    catch {
        // Logging must never break plugin loading.
    }
}
/**
 * Register the tool and return its undo handle.
 * @param tools - the host tool registry.
 * @param runTest - tests one engine.
 * @param options - diagnostics hook.
 * @returns the registration, or `undefined` when the registry refused it.
 */
export function registerEngineTestTool(tools, runTest, options = {}) {
    const warn = options.warn ?? warnEngineTest;
    const name = pickEngineTestToolName(tools);
    const definition = createEngineTestDefinition(name, runTest);
    try {
        const handle = tools.register(definition);
        const unregister = typeof handle === 'function' ? handle : undefined;
        return {
            name,
            dispose: () => {
                try {
                    unregister?.();
                }
                catch (error) {
                    warn(`engine_test unregister failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        };
    }
    catch (error) {
        warn(`engine_test registration skipped: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
