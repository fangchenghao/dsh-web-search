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
 * @module dsh-web-search-bing/config
 */
import z from '@deepseek-ai/schemastery';
import type { RankOptions, WaitPolicy } from './types.ts';

/** Schema of the plugin's configuration section. */
export const Config = z.object({
  hosts: z
    .array(z.string())
    .default([])
    .description('引擎白名单：只运行列出的引擎 id，留空表示全部（如 anysearch、ddg-html、cn.bing）。数组字段，请在配置文件中编辑。')
    .volatile(),
  timeoutMs: z.natural().min(500).default(15000).description('单个引擎的请求超时（毫秒）。').volatile(),
  wait: z
    .union(['auto', 'all', 'fast'])
    .default('auto')
    .description('等待策略：auto 跟随查询语言，all 等全部引擎返回，fast 首个结果即返回。').volatile(),
  proxy: z
    .string()
    .default('')
    .description('代理地址，例如 http://127.0.0.1:7890；留空则自动探测系统代理。').volatile(),
  limit: z.natural().min(1).max(20).default(8).description('返回结果数上限，同时决定引擎之间的名额分配。').volatile(),
  rrfConstant: z.natural().min(1).default(60).description('RRF 融合常数：越大越平均，越小越偏向各引擎的头部结果。').volatile(),
  authorityDomains: z
    .array(z.string())
    .default([])
    .description('权威域名列表，命中后提升排名。数组字段，请在配置文件中编辑。')
    .volatile(),
  authorityBoost: z.number().min(0).max(10).default(0.25).description('权威域名加成强度。').volatile(),
  freshnessBoost: z.number().min(0).max(10).default(0.2).description('时效加成强度。').volatile(),
  freshnessDays: z.natural().min(1).default(30).description('时效窗口（天），超出窗口的结果不享受时效加成。').volatile(),
  cacheTtlMs: z.natural().default(600000).description('缓存有效期（毫秒）。').volatile(),
  cacheEntries: z.natural().default(100).description('缓存条数上限（超出按最久未用淘汰）。').volatile(),
  anysearchApiKey: z
    .string()
    .default('')
    .description('AnySearch API Key：留空则匿名调用（速率较低）；有 key 时仅发送到 api.anysearch.com。').volatile(),
  anysearchDomain: z
    .string()
    .default('')
    .description('AnySearch 垂直域：finance / academic / security / legal / code，可带子域如 finance.us_stock；留空为通用搜索。').volatile(),
  baseCooldownMs: z.natural().default(300000).description('触发限流后的基础冷却时间（毫秒）。').volatile(),
  maxCooldownMs: z.natural().default(1800000).description('指数退避冷却的上限（毫秒）。').volatile(),
});

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
export type PlainConfig = { [K in keyof PluginConfig]: Plain<PluginConfig[K]> };

/**
 * A config section as it can arrive here: the Loader's resolved object (volatile
 * fields are live references), a partial plain object from a test or a
 * hand-edited composition, or the patch's raw values.
 */
export type ConfigInput = {
  readonly [K in keyof PluginConfig]?: Plain<PluginConfig[K]> | PluginConfig[K];
};

/**
 * Read one field, whichever shape it arrived in.
 * @param field - a live reference, a plain value, or nothing.
 * @param fallback - value to use when the field is absent.
 * @returns the current plain value.
 */
function read<T>(field: Plain<T> | LiveRef<Plain<T>> | undefined, fallback: Plain<T>): Plain<T> {
  const holder = field as LiveRef<Plain<T>> | undefined;
  const value = typeof holder?.get === 'function' ? holder.get() : (field as Plain<T> | undefined);
  return value === undefined ? fallback : value;
}

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
export function resolveConfig(config: ConfigInput | undefined, callLimit: number | undefined): ResolvedConfig {
  const supplied = (config ?? {}) as Readonly<Record<string, unknown>>;
  const plain = Object.fromEntries(
    Object.entries(supplied).map(([key, value]) => [key, read(value as never, undefined)]),
  );
  const validated = Config(plain as unknown as Parameters<typeof Config>[0]) as unknown as PluginConfig;
  const keys = Object.keys(validated) as (keyof PluginConfig)[];
  const settings = Object.fromEntries(
    keys.map((key) => [key, read(supplied[key], read(validated[key] as never, undefined))]),
  ) as unknown as PlainConfig;

  // A volatile reference hands out a frozen snapshot, so the two list fields
  // are copied before they leave: a caller may sort or splice what it gets.
  const hosts = [...settings.hosts].filter((id) => id.trim().length > 0);
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
      ...(settings.authorityDomains.length > 0 ? { authorityDomains: [...settings.authorityDomains] } : {}),
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
