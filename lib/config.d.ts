/**
 * The plugin configuration, as a schema rather than a pile of `if` statements.
 *
 * The loader validates the mounted config against {@link Config} before `apply`
 * runs, so a typo fails loudly at load time with the offending path and the
 * accepted values instead of silently falling back to a default. Every key
 * also carries a description, because the same schema is what a settings
 * surface renders its fields from.
 *
 * Every field is `.volatile()`: `dsh-settings` serves a namespace only when
 * {@link Config} holds at least one volatile field, and a volatile field is
 * what the Settings page can write without remounting the plugin. A marked
 * array is not special — it resolves to a live reference wrapping the array,
 * whose *JSON* form is `{}`; `plainConfig` unwraps it before the form is
 * rendered, so the list fields survive the round trip. See
 * {@link resolveConfig} for the one rule the marks impose on the reader: the
 * Loader hands a marked field over as a live `{ get }` reference, never as the
 * value.
 *
 * @module @fangchenghao/dsh-web-search/config
 */
import z from '@deepseek-ai/schemastery';
import type { RenderMode } from './render.ts';
import type { FailureKind, RankOptions, SafeSearch, TimeRange, WaitPolicy } from './types.ts';
/** Schema of the plugin's configuration section. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    hosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    fetchFormat: z<"text" | "markdown", "text" | "markdown", "volatile-defined">;
    fetchMaxLength: z<number, number, "volatile-defined">;
    renderJs: z<"off" | "auto" | "always", "off" | "auto" | "always", "volatile-defined">;
    renderTimeoutMs: z<number, number, "volatile-defined">;
    wait: z<"auto" | "all" | "fast", "auto" | "all" | "fast", "volatile-defined">;
    proxy: z<string, string, "volatile-defined">;
    limit: z<number, number, "volatile-defined">;
    rrfConstant: z<number, number, "volatile-defined">;
    authorityDomains: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    authorityBoost: z<number, number, "volatile-defined">;
    freshnessBoost: z<number, number, "volatile-defined">;
    freshnessDays: z<number, number, "volatile-defined">;
    timeRange: z<"off" | "day" | "week" | "month" | "year", "off" | "day" | "week" | "month" | "year", "volatile-defined">;
    blockedDomains: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    safeSearch: z<"off" | "moderate" | "strict", "off" | "moderate" | "strict", "volatile-defined">;
    fallbackOn: z<NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, "volatile-defined">;
    cacheTtlMs: z<number, number, "volatile-defined">;
    cacheEntries: z<number, number, "volatile-defined">;
    cachePersist: z<boolean, boolean, "volatile-defined">;
    cacheFile: z<string, string, "volatile-defined">;
    anysearchApiKey: z<string, string, "volatile-defined">;
    anysearchDomain: z<string, string, "volatile-defined">;
    baseCooldownMs: z<number, number, "volatile-defined">;
    maxCooldownMs: z<number, number, "volatile-defined">;
    domainSources: z<NoInfer<string | string[]>, NoInfer<string | string[]>, "volatile-defined">;
    domainLimit: z<number, number, "volatile-defined">;
    domainTimeoutMs: z<number, number, "volatile-defined">;
    toolSurface: z<"unified" | "legacy", "unified" | "legacy", "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    hosts: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    timeoutMs: z<number, number, "volatile-defined">;
    fetchFormat: z<"text" | "markdown", "text" | "markdown", "volatile-defined">;
    fetchMaxLength: z<number, number, "volatile-defined">;
    renderJs: z<"off" | "auto" | "always", "off" | "auto" | "always", "volatile-defined">;
    renderTimeoutMs: z<number, number, "volatile-defined">;
    wait: z<"auto" | "all" | "fast", "auto" | "all" | "fast", "volatile-defined">;
    proxy: z<string, string, "volatile-defined">;
    limit: z<number, number, "volatile-defined">;
    rrfConstant: z<number, number, "volatile-defined">;
    authorityDomains: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    authorityBoost: z<number, number, "volatile-defined">;
    freshnessBoost: z<number, number, "volatile-defined">;
    freshnessDays: z<number, number, "volatile-defined">;
    timeRange: z<"off" | "day" | "week" | "month" | "year", "off" | "day" | "week" | "month" | "year", "volatile-defined">;
    blockedDomains: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    safeSearch: z<"off" | "moderate" | "strict", "off" | "moderate" | "strict", "volatile-defined">;
    fallbackOn: z<NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, NoInfer<("quota" | "auth" | "bot-wall" | "transient" | "invalid-response" | "unknown")[]>, "volatile-defined">;
    cacheTtlMs: z<number, number, "volatile-defined">;
    cacheEntries: z<number, number, "volatile-defined">;
    cachePersist: z<boolean, boolean, "volatile-defined">;
    cacheFile: z<string, string, "volatile-defined">;
    anysearchApiKey: z<string, string, "volatile-defined">;
    anysearchDomain: z<string, string, "volatile-defined">;
    baseCooldownMs: z<number, number, "volatile-defined">;
    maxCooldownMs: z<number, number, "volatile-defined">;
    domainSources: z<NoInfer<string | string[]>, NoInfer<string | string[]>, "volatile-defined">;
    domainLimit: z<number, number, "volatile-defined">;
    domainTimeoutMs: z<number, number, "volatile-defined">;
    toolSurface: z<"unified" | "legacy", "unified" | "legacy", "volatile-defined">;
}>>, "plain">;
/** What the schema resolves a field to: a live reference, not the value. */
export interface LiveRef<T> {
    /** @returns the value the Loader's last commit for this field holds. */
    get: () => T;
}
/** The plain value behind a schema field. */
type Plain<T> = T extends LiveRef<infer V> ? V : T;
/** The validated section, with volatile fields still wrapped. */
export type PluginConfig = ReturnType<typeof Config>;
/** The section with every live reference read out on demand. */
export type PlainConfig = {
    [K in keyof PluginConfig]: Plain<PluginConfig[K]>;
};
/**
 * A config section as it can arrive here: the Loader's resolved object (volatile
 * fields are live references), a partial plain object from a test or a
 * hand-edited composition, or the patch's raw values.
 */
export type ConfigInput = {
    readonly [K in keyof PluginConfig]?: Plain<PluginConfig[K]> | PluginConfig[K];
};
/** Configuration normalised for the engine layer. */
export interface ResolvedConfig {
    /** Engine ids to allow, or `undefined` for all of them. */
    hostIds: string[] | undefined;
    /** Per-engine deadline. */
    timeoutMs: number;
    /** `web_fetch` output style. */
    fetchFormat: 'markdown' | 'text';
    /** `web_fetch` character budget. */
    fetchMaxLength: number;
    /** Browser rendering policy for `web_fetch`. */
    renderJs: RenderMode;
    /** Browser-render deadline in milliseconds. */
    renderTimeoutMs: number;
    /** Explicit tunnel URL, or `undefined` to detect one. */
    proxy: string | undefined;
    /** Caller budget cap. */
    limit: number;
    /** Release policy, deciding how long a tier waits for slow engines. */
    wait: WaitPolicy;
    /** Rolling publication window; `off` disables time filtering. */
    timeRange: TimeRange;
    /** Domains the caller never wants in a result list. */
    blockedDomains: string[];
    /** Content-filter level forwarded to engines that support it. */
    safeSearch: SafeSearch;
    /** Failure classes that may trigger the fallback tier. */
    fallbackOn: FailureKind[];
    /** AnySearch credential, or an empty string for anonymous access. */
    anysearchApiKey: string;
    /** AnySearch vertical domain, or an empty string for the open web. */
    anysearchDomain: string;
    /** Ranking knobs. */
    rank: RankOptions;
    /** Cache lifetime in milliseconds. */
    cacheTtlMs: number;
    /** Cache capacity in entries. */
    cacheEntries: number;
    /** Whether the cache snapshot is written to disk. */
    cachePersist: boolean;
    /** Custom snapshot path, or `undefined` for the default one. */
    cacheFile: string | undefined;
    /** Base cooldown in milliseconds. */
    baseCooldownMs: number;
    /** Cooldown ceiling in milliseconds. */
    maxCooldownMs: number;
    /** Vertical sources `domain_search` queries by default. */
    domainSourceIds: string[];
    /** Default result budget per vertical source. */
    domainLimit: number;
    /** Per-source deadline for vertical requests. */
    domainTimeoutMs: number;
    /** Whether the model sees one unified tool or the legacy eight names. */
    toolSurface: 'unified' | 'legacy';
}
/**
 * Normalise the validated config into the shape the engine layer consumes.
 *
 * The Loader already ran {@link Config} over the patch values through
 * `Config['~standard'].validate` (`@deepseek-ai/cordis` `resolveConfig`), and
 * that call resolves every `.volatile()` field to a live `{ get }` reference.
 * Feeding that object back into the schema would hand a `{ get }` to the
 * field's own validator — `$.timeoutMs expected number but got [object Object]`
 * — so the values are read out first, validated, and then the caller's
 * references win: a Settings commit mutates them in place
 * (`cordis-plugin-loader` `Entry._commitVolatile`), which is what makes an
 * edit reach a running plugin.
 *
 * @param config - the config section, resolved by the Loader or raw.
 * @param callLimit - the caller's own budget, used when the config sets none.
 * @returns the normalised configuration.
 */
export declare function resolveConfig(config: ConfigInput | undefined, callLimit: number | undefined): ResolvedConfig;
export {};
