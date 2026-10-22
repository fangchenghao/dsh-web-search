/**
 * The plugin configuration, as a schema rather than a pile of `if` statements.
 *
 * The loader validates the mounted config against {@link Config} before `apply`
 * runs, so a typo fails loudly at load time with the offending path and the
 * accepted values instead of silently falling back to a default. Every key
 * also carries a description, because the same schema is what a settings
 * surface renders its fields from.
 *
 * @module dsh-web-search-bing/config
 */
import z from '@deepseek-ai/schemastery';
import type { RankOptions, WaitPolicy } from './types.ts';

/** Schema of the plugin's configuration section. */
export const Config = z.object({
  hosts: z
    .array(z.string())
    .default([])
    .description('Restrict the run to these engine ids (empty means every engine).'),
  timeoutMs: z.natural().min(500).default(15000).description('Per-engine request deadline in milliseconds.'),
  wait: z
    .union(['auto', 'all', 'fast'])
    .default('auto')
    .description('How long a tier waits: auto follows the query language, all waits for every engine, fast returns on the first answer.'),
  proxy: z
    .string()
    .default('')
    .description('Explicit tunnel URL such as http://127.0.0.1:7890. Empty means detect from the environment, then from the macOS system proxy.'),
  limit: z.natural().min(1).max(20).default(8).description('Upper bound on returned sources, applied on top of the caller budget.'),
  rrfConstant: z.natural().min(1).default(60).description('Reciprocal-rank-fusion constant; larger flattens the rank curve.'),
  authorityDomains: z
    .array(z.string())
    .default([])
    .description('Extra domains that earn the authority boost, on top of the built-in list.'),
  authorityBoost: z.number().min(0).max(10).default(0.25).description('Multiplier applied to sources on an authoritative domain.'),
  freshnessBoost: z.number().min(0).max(10).default(0.2).description('Multiplier applied to a result published today.'),
  freshnessDays: z.natural().min(1).default(30).description('Age in days at which the freshness boost has faded to zero.'),
  cacheTtlMs: z.natural().default(600000).description('Result cache lifetime in milliseconds; 0 disables the cache.'),
  cacheEntries: z.natural().default(100).description('Maximum cached queries before the least recently used one is evicted.'),
  anysearchApiKey: z
    .string()
    .default('')
    .description('AnySearch API key, sent as a Bearer token to api.anysearch.com only; empty means anonymous access.'),
  anysearchDomain: z
    .string()
    .default('')
    .description('Vertical domain for AnySearch (finance, academic, security, legal, code); a dotted value such as finance.us_stock selects a sub-domain.'),
  baseCooldownMs: z.natural().default(300000).description('Cooldown after a throttling failure that carried no wait hint.'),
  maxCooldownMs: z.natural().default(1800000).description('Ceiling for the exponential cooldown.'),
});

/** The resolved configuration object handed to `apply`. */
export type PluginConfig = ReturnType<typeof Config>;

/** Configuration normalised for the engine layer. */
export interface ResolvedConfig {
  /** Engine ids to allow, or `undefined` for all of them. */
  hostIds: string[] | undefined;
  /** Per-engine deadline. */
  timeoutMs: number;
  /** Explicit tunnel URL, or `undefined` to detect one. */
  proxy: string | undefined;
  /** Caller budget cap. */
  limit: number;
  /** Release policy, deciding how long a tier waits for slow engines. */
  wait: WaitPolicy;
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
  /** Base cooldown in milliseconds. */
  baseCooldownMs: number;
  /** Cooldown ceiling in milliseconds. */
  maxCooldownMs: number;
}

/**
 * Normalise the validated config into the shape the engine layer consumes.
 * @param config - the schema-validated plugin config.
 * @param callLimit - the caller's own budget, used when the config sets none.
 * @returns the normalised configuration.
 */
export function resolveConfig(config: PluginConfig | Readonly<Record<string, unknown>>, callLimit: number | undefined): ResolvedConfig {
  // The loader validates a row's config before activation, but this function is
  // also reachable from the settings card and from a hand-edited composition,
  // where the value can be a partial object. Running it through the schema first
  // makes the defaults apply instead of dereferencing an absent key.
  const settings = Config(config as PluginConfig);
  const hosts = settings.hosts.filter((id) => id.trim().length > 0);
  const proxy = settings.proxy.trim();
  const limit = Math.min(callLimit ?? settings.limit, settings.limit);
  return {
    hostIds: hosts.length > 0 ? hosts : undefined,
    timeoutMs: settings.timeoutMs,
    proxy: proxy.length > 0 ? proxy : undefined,
    limit,
    wait: settings.wait,
    anysearchApiKey: settings.anysearchApiKey.trim(),
    anysearchDomain: settings.anysearchDomain.trim(),
    rank: {
      rrfConstant: settings.rrfConstant,
      ...(settings.authorityDomains.length > 0 ? { authorityDomains: settings.authorityDomains } : {}),
      authorityBoost: settings.authorityBoost,
      freshnessBoost: settings.freshnessBoost,
      freshnessDays: settings.freshnessDays,
    },
    cacheTtlMs: settings.cacheTtlMs,
    cacheEntries: settings.cacheEntries,
    baseCooldownMs: settings.baseCooldownMs,
    maxCooldownMs: settings.maxCooldownMs,
  };
}
