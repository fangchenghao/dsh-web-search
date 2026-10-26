/**
 * One model-facing entry point for the plugin's optional capabilities.
 *
 * The plugin used to register eight separate tools. That made every capability
 * visible all the time, which is expensive in a long system prompt and makes
 * the model choose between near-synonyms before it has even read the question.
 * This module keeps the same handlers but exposes them as one `web_tools`
 * definition with an `action` discriminator:
 *
 * - `search_many`
 * - `advanced_search`
 * - `domain_search`
 * - `platform_search`
 * - `read_page`
 * - `research`
 * - `cache_search`
 * - `engine_test`
 *
 * The sub-definitions are still the source of truth for validation, execution
 * and rendering. This adapter only validates the envelope, dispatches to the
 * matching definition and forwards its rendered text. A host that wants the
 * old eight names can opt in with `toolSurface: "legacy"`; the default is the
 * unified surface.
 *
 * @module @fangchenghao/dsh-web-search/tool-suite
 */
import type { ToolContent, ToolJsonSchema } from './domain-tool.ts';
/** Preferred name for the unified tool. */
export declare const UNIFIED_TOOL_NAME = "web_tools";
/** Name used when another plugin already owns {@link UNIFIED_TOOL_NAME}. */
export declare const UNIFIED_TOOL_FALLBACK_NAME = "web_search_tools";
/** Every action the unified tool accepts, in prompt-friendly order. */
export declare const UNIFIED_ACTIONS: readonly ["search_many", "advanced_search", "domain_search", "platform_search", "read_page", "research", "cache_search", "engine_test"];
/** One accepted action name. */
export type UnifiedAction = (typeof UNIFIED_ACTIONS)[number];
/** Runtime test for an action name. */
export declare function isUnifiedAction(value: unknown): value is UnifiedAction;
/** The subset of a sub-tool definition this adapter needs. */
export interface SubToolDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: never) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<unknown>;
}
/** A registry-shaped adapter, matching the host's raw tool dialect. */
export interface UnifiedToolDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    output: {
        schema: ToolJsonSchema;
        render: (args: unknown, value: unknown) => ToolContent[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
    execute: (args: unknown, exec: {
        signal?: AbortSignal;
    }) => Promise<UnifiedValue>;
}
/** The value returned by the unified tool. */
export interface UnifiedValue {
    action: UnifiedAction;
    result: unknown;
}
/** The registry slice used for registration. */
export interface UnifiedToolRegistryLike {
    register(definition: UnifiedToolDefinition): unknown;
    get?(name: string, scope?: unknown): unknown;
}
/** Registration options. */
export interface UnifiedToolOptions {
    /** Diagnostics for a rejected registration. */
    warn?: (message: string) => void;
}
/**
 * Build the single unified definition.
 * @param name - preferred or fallback name.
 * @param definitions - the eight sub-definitions, in registration order.
 * @returns a registry-ready tool definition.
 */
export declare function createUnifiedToolDefinition(name: string, definitions: readonly SubToolDefinition[]): UnifiedToolDefinition;
/** Choose the preferred name unless another plugin already owns it. */
export declare function pickUnifiedToolName(tools: UnifiedToolRegistryLike): string;
/**
 * Register the unified tool. A rejection is reported and swallowed so the
 * search provider and fetch provider keep working.
 * @returns the registered name, or undefined when registration was skipped.
 */
export declare function registerUnifiedTool(tools: UnifiedToolRegistryLike, definitions: readonly SubToolDefinition[], options?: UnifiedToolOptions): string | undefined;
