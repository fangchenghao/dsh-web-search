/**
 * The model-facing `engine_test` tool: ask every configured engine one tiny
 * query and report which ones answered, how quickly, and why the others did
 * not.
 *
 * This is deliberately separate from `web_search`: a test must not cool an
 * engine down, must not fill the result cache, and must not fall through to a
 * different engine. The caller gets one row per engine, with the same
 * `FailureKind` the fallback policy uses, so "why is my search slow?" has a
 * concrete answer instead of a long `failures` string.
 *
 * @module @fangchenghao/dsh-web-search/engine-test
 */
import type { EngineFailure, FailureKind, Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** The name this tool prefers. */
export declare const ENGINE_TEST_TOOL_NAME = "engine_test";
/** The name used when another plugin already registered `engine_test`. */
export declare const ENGINE_TEST_FALLBACK_NAME = "web_engine_test";
/** Default query; broad enough that every engine has an answer. */
export declare const ENGINE_TEST_DEFAULT_QUERY = "DeepSeek Harness";
/** One engine's test result. */
export interface EngineTestResult {
    engine: string;
    ok: boolean;
    latencyMs: number;
    count: number;
    failureKind?: FailureKind;
    code?: string;
    status?: number;
    reason?: string;
    sample?: string;
}
/** What the runner reports for one engine. */
export interface EngineTestOutcome {
    sources: Source[];
    failureDetails: EngineFailure[];
    failures: string[];
}
/** Run one engine through the normal search path with no cache or fallback. */
export type EngineTestRunner = (engine: string, query: string, signal?: AbortSignal) => Promise<EngineTestOutcome>;
/** A tool definition in the host registry's native shape. */
export interface EngineTestDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: EngineTestValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<EngineTestValue>;
}
/** What the tool returns to the model. */
export interface EngineTestValue {
    query: string;
    results: EngineTestResult[];
    ok: number;
    failed: number;
}
/** The slice of the tool registry this module needs. */
export interface EngineTestRegistryLike {
    register(definition: EngineTestDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Construction seams. */
export interface EngineTestOptions {
    /** Registration diagnostics. */
    warn?: (message: string) => void;
}
/** A successful registration plus the exact way to undo it. */
export interface EngineTestRegistration {
    name: string;
    dispose: () => void;
}
/** Format the model-facing result text. */
export declare function formatEngineTestValue(value: EngineTestValue): string;
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
export declare function runEngineTestValue(runTest: EngineTestRunner, engines: readonly string[], query: string, signal?: AbortSignal): Promise<EngineTestValue>;
/**
 * Build the tool definition the host registry accepts.
 * @param name - `engine_test`, or the fallback when that name is taken.
 * @param runTest - tests one engine through the normal search path.
 * @returns a registry-ready definition.
 */
export declare function createEngineTestDefinition(name: string, runTest: EngineTestRunner): EngineTestDefinition;
/**
 * Pick the tool name this deployment can accept.
 * @param tools - the live registry.
 * @returns the preferred or fallback name.
 */
export declare function pickEngineTestToolName(tools: EngineTestRegistryLike): string;
/** Report a registration failure without throwing out of the plugin. */
export declare function warnEngineTest(message: string): void;
/**
 * Register the tool and return its undo handle.
 * @param tools - the host tool registry.
 * @param runTest - tests one engine.
 * @param options - diagnostics hook.
 * @returns the registration, or `undefined` when the registry refused it.
 */
export declare function registerEngineTestTool(tools: EngineTestRegistryLike, runTest: EngineTestRunner, options?: EngineTestOptions): EngineTestRegistration | undefined;
