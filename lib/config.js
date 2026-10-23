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
import { DEFAULT_FETCH_MAX_LENGTH } from "./markdown.js";
import { DEFAULT_VERTICAL_IDS, VERTICAL_IDS, isVerticalId } from "./verticals.js";
/** Schema of the plugin's configuration section. */
export const Config = z.object({
    hosts: z
        .array(z.string())
        .default([])
        .description('只启用列出的搜索引擎（如 anysearch、cn.bing），多个用逗号分隔；留空表示全部。不想限制就留空。')
        .volatile(),
    timeoutMs: z.natural().min(500).default(15000).description('每次向搜索引擎要结果，最多等它多久（毫秒，1000 = 1 秒）。网络慢可加到 20000；平时保持 15000 就行。').volatile(),
    fetchFormat: z
        .union(['markdown', 'text'])
        .default('markdown')
        .description('抓取网页后返回什么样式：markdown 保留标题、列表、表格和链接，最适合阅读；text 只留纯文字、去掉所有标记。一般保持 markdown。')
        .volatile(),
    fetchMaxLength: z
        .natural()
        .min(1000)
        .max(200000)
        .default(DEFAULT_FETCH_MAX_LENGTH)
        .description('一次抓取最多返回多少个字符（1000-200000）；超出会在末尾注明原始长度。想一次多读可调到 50000，日常保持 20000 即可。')
        .volatile(),
    renderJs: z
        .union(['auto', 'always', 'off'])
        .default('auto')
        .description('脚本渲染页面的处理方式：auto 只在正文像空壳网页时才用浏览器渲染（推荐），always 每次抓取都渲染（更慢），off 从不渲染。需要另外安装 Playwright；没装就静默跳过，不影响抓取。')
        .volatile(),
    renderTimeoutMs: z
        .natural()
        .min(1000)
        .max(120000)
        .default(15000)
        .description('用浏览器渲染一个页面最多等多久（毫秒，1000-120000）。页面很重可加到 30000；平时保持 15000 即可。')
        .volatile(),
    wait: z
        .union(['auto', 'all', 'fast'])
        .default('auto')
        .description('等结果等多久：auto 按提问语言自动决定，all 等所有搜索引擎答完，fast 谁先答完就用谁。不确定保持 auto。').volatile(),
    proxy: z
        .string()
        .default('')
        .description('上网中转站（代理）：替你转发请求的机器，如 http://127.0.0.1:7890；留空自动认系统代理，不懂就别填。').volatile(),
    limit: z.natural().min(1).max(20).default(8).description('一次最多返回几条结果，也决定各搜索引擎分到几条。想多看可调到 10 到 20；一般保持 8。').volatile(),
    rrfConstant: z.natural().min(1).default(60).description('多个搜索引擎结果的混合力度：调大更偏“只有一家推荐”的冷门链接，调小更像“大家都推荐的前几名”。不想微调就保持 60。').volatile(),
    authorityDomains: z
        .array(z.string())
        .default([])
        .description('你认为更可信的网站名单（如 docs.python.org），命中会往前排。多个用逗号分隔；不填也没关系。')
        .volatile(),
    authorityBoost: z.number().min(0).max(10).default(0.25).description('上面那份网站名单能让结果往前排多少（0 到 10，0 = 不加强）。觉得好网站排得不够前就调大；不确定保持 0.25。').volatile(),
    freshnessBoost: z.number().min(0).max(10).default(0.2).description('新发布的网页能额外往前排多少（0 到 10，0 = 不看新旧）。常查新闻可调到 0.5；不确定保持 0.2。').volatile(),
    freshnessDays: z.natural().min(1).default(30).description('多新的网页才算新（单位：天）。查新闻可调小到 7，查资料可调大到 365；不确定保持 30。').volatile(),
    timeRange: z
        .union(['off', 'day', 'week', 'month', 'year'])
        .default('off')
        .description('只保留多久以内发布的结果：off 不限时间、day 最近 24 小时、week 最近 7 天、month 最近 30 天、year 最近 1 年。开启后只返回窗口内发布的结果；若一条带日期的都没落进窗口，会退回无日期的结果避免空手；不确定保持 off。')
        .volatile(),
    cacheTtlMs: z.natural().default(600000).description('同一问题多久内复用上次结果（缓存，即存一份备用），毫秒。想早点看到新内容就调小；保持 600000（10 分钟）即可。').volatile(),
    cacheEntries: z.natural().default(100).description('最多存多少条旧结果备用（缓存，即存起来省得重复查）。存满后先丢最久没用的；一般保持 100 即可。').volatile(),
    cachePersist: z
        .boolean()
        .default(true)
        .description('是否把缓存保存到硬盘，重启后还能复用上次结果。默认开启（true）；不想留痕或磁盘只读时改成 false。')
        .volatile(),
    cacheFile: z
        .string()
        .default('')
        .description('缓存文件放哪；留空用默认 ~/.dsh/cache/dsh-web-search/cache.json。一般不用填，换位置时再写绝对路径。')
        .volatile(),
    anysearchApiKey: z
        .string()
        .default('')
        .description('AnySearch 通行证（API Key）：留空则匿名（慢一些）；填了更稳且只发 api.anysearch.com。有多个 key 用逗号分隔，插件会轮流使用，某个被限流就自动换下一个。').volatile(),
    anysearchDomain: z
        .string()
        .default('')
        .description('只搜某一类专业内容（如 finance 财经、academic 学术、code 代码）。要专查某类才填；日常搜索留空。').volatile(),
    baseCooldownMs: z.natural().default(300000).description('搜索引擎说“你查得太频繁了”后，先歇多久（毫秒）。歇太久会少一个引擎，太短易被再拒；保持 300000（5 分钟）即可。').volatile(),
    maxCooldownMs: z.natural().default(1800000).description('它反复被拒时，最长让它歇多久（毫秒），也就是等待一步步加长的封顶值。一般不用改；保持 1800000（30 分钟）即可。').volatile(),
    domainSources: z
        .union([z.array(z.string()), z.string()])
        .default([...DEFAULT_VERTICAL_IDS])
        .description('默认查哪些专用源，逗号分隔；留空表示默认的 8 个（github、npm、pypi、arxiv、wikipedia、hn、stackexchange、crates）。其余源可用 sources 参数按需指定。')
        .volatile(),
    domainLimit: z.natural().min(1).max(20).default(5).description('domain_search 一次最多返回几条（1-20）；默认 5 条，想多看可调到 10。').volatile(),
    domainTimeoutMs: z.natural().min(500).default(8000).description('每个专用源最多等多久（毫秒）；网络慢可加到 15000，平时 8000 即可。').volatile(),
});
/**
 * Read one field, whichever shape it arrived in.
 * @param field - a live reference, a plain value, or nothing.
 * @param fallback - value to use when the field is absent.
 * @returns the current plain value.
 */
function read(field, fallback) {
    const holder = field;
    const value = typeof holder?.get === 'function' ? holder.get() : field;
    return value === undefined ? fallback : value;
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
export function resolveConfig(config, callLimit) {
    const supplied = (config ?? {});
    const plain = Object.fromEntries(Object.entries(supplied).map(([key, value]) => [key, read(value, undefined)]));
    const validated = Config(plain);
    const keys = Object.keys(validated);
    const settings = Object.fromEntries(keys.map((key) => [key, read(supplied[key], read(validated[key], undefined))]));
    // A volatile reference hands out a frozen snapshot, so the list fields are
    // copied before they leave: a caller may sort or splice what it gets.
    const hosts = [...settings.hosts].filter((id) => id.trim().length > 0);
    // The field accepts an array or the comma separated form the Settings card
    // writes; both normalise to the ids the tool understands.
    const rawDomainSources = settings.domainSources;
    const domainList = Array.isArray(rawDomainSources)
        ? rawDomainSources
        : String(rawDomainSources).split(/[\s,]+/);
    const domainSources = domainList.map((id) => id.trim()).filter(isVerticalId);
    const proxy = settings.proxy.trim();
    const cacheFile = settings.cacheFile.trim();
    const limit = Math.min(callLimit ?? settings.limit, settings.limit);
    return {
        hostIds: hosts.length > 0 ? hosts : undefined,
        timeoutMs: settings.timeoutMs,
        fetchFormat: settings.fetchFormat,
        fetchMaxLength: settings.fetchMaxLength,
        renderJs: settings.renderJs,
        renderTimeoutMs: settings.renderTimeoutMs,
        proxy: proxy.length > 0 ? proxy : undefined,
        limit,
        wait: settings.wait,
        timeRange: settings.timeRange,
        anysearchApiKey: settings.anysearchApiKey.trim(),
        anysearchDomain: settings.anysearchDomain.trim(),
        domainSourceIds: domainSources.length > 0 ? domainSources : [...DEFAULT_VERTICAL_IDS],
        domainLimit: settings.domainLimit,
        domainTimeoutMs: settings.domainTimeoutMs,
        rank: {
            rrfConstant: settings.rrfConstant,
            ...(settings.authorityDomains.length > 0 ? { authorityDomains: [...settings.authorityDomains] } : {}),
            authorityBoost: settings.authorityBoost,
            freshnessBoost: settings.freshnessBoost,
            freshnessDays: settings.freshnessDays,
        },
        cacheTtlMs: settings.cacheTtlMs,
        cacheEntries: settings.cacheEntries,
        cachePersist: settings.cachePersist,
        cacheFile: cacheFile.length > 0 ? cacheFile : undefined,
        baseCooldownMs: settings.baseCooldownMs,
        maxCooldownMs: settings.maxCooldownMs,
    };
}
