/**
 * The model-facing `platform_search` tool.
 *
 * It is the community/video counterpart to `domain_search`: one call can ask
 * Bilibili, V2EX, Reddit, YouTube, Zhihu and Juejin for pages about a topic.
 * The transport and parser live in `platforms.ts`; this module owns only the
 * tool contract (arguments, validation, rendering, fallback name and
 * registration). That keeps the network adapters testable without the host
 * registry and keeps the tool definition in the same raw JSON-Schema dialect
 * as the other optional tools.
 *
 * @module @fangchenghao/dsh-web-search/platform-tool
 */
import type { Source } from './types.ts';
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
import { MAX_PLATFORM_LIMIT } from './platforms.ts';
import type { PlatformId } from './platforms.ts';
/** The name this tool prefers. */
export declare const PLATFORM_TOOL_NAME = "platform_search";
/** The name used when another plugin already registered `platform_search`. */
export declare const PLATFORM_TOOL_FALLBACK_NAME = "web_platform_search";
/** Default and maximum result count per call (merged across platforms). */
export declare const PLATFORM_DEFAULT_LIMIT = 5;
export declare const PLATFORM_MAX_LIMIT = 10;
/** What one platform call returns to the model. */
export interface PlatformToolValue {
    query: string;
    platforms: PlatformId[];
    sources: Source[];
    failures: string[];
    via: Partial<Record<PlatformId, 'api' | 'fallback'>>;
    truncated: boolean;
}
/** The network half, injectable so the tool definition can be tested offline. */
export type PlatformRunner = (query: string, ids: readonly PlatformId[], limit: number, signal?: AbortSignal) => Promise<Omit<PlatformToolValue, 'query' | 'platforms'>>;
/** A registry definition in the host's raw JSON-Schema dialect. */
export interface PlatformToolDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: PlatformToolValue) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<PlatformToolValue>;
}
/** The slice of the tool registry this module needs. */
export interface PlatformToolRegistryLike {
    register(definition: PlatformToolDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Parse and validate arguments. */
export declare function parsePlatformArgs(args: unknown): {
    query: string;
    ids: PlatformId[];
    limit: number;
};
/** Format the model-facing result, inside the untrusted boundary. */
export declare function formatPlatformValue(value: PlatformToolValue): string;
/**
 * Build the tool definition.
 * @param name - preferred or fallback name.
 * @param run - network runner, normally `searchPlatforms` with the live proxy
 *   and the plugin's normal search as the fallback.
 */
export declare function createPlatformToolDefinition(name: string, run: PlatformRunner): PlatformToolDefinition;
/** Pick the preferred name unless another tool already owns it. */
export declare function pickPlatformToolName(tools: PlatformToolRegistryLike): string;
/** Register the tool; any registry failure is contained. */
export declare function registerPlatformTool(tools: PlatformToolRegistryLike, run: PlatformRunner, options?: {
    warn?: (message: string) => void;
}): string | undefined;
export { MAX_PLATFORM_LIMIT };
