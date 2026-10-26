/**
 * Browser half of `dsh-web-search-bing`.
 *
 * Registers one Settings page into the Settings surface's `settings.section`
 * slot, so this plugin's 22 configuration keys can be edited in the GUI instead
 * of the profile's `cordis.patch.yml`. The page reads and writes the plugin's
 * Loader entry (`web-search-bing`) through the shared `configForms` service,
 * which is the same path the shipped settings pages use.
 *
 * The entry is fail-safe by construction: the whole module sits inside a guard,
 * the factory is guarded, and registration is wrapped so a missing loader, a
 * missing slot, or a missing service leaves the rest of the page untouched.
 *
 * @module dsh-web-search-bing/client
 */
(function () {
  'use strict';

  /** Log without letting a console failure escape. */
  function warn(error) {
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn('[dsh-web-search-bing] client:', error);
      }
    } catch (ignored) {
      /* nothing to do */
    }
  }

  try {
    if (typeof window === 'undefined') return;
    var loader = window.__ModuleLoader__;
    if (loader === null || typeof loader !== 'object' || typeof loader.load !== 'function') return;

    loader.load({
      id: '@fffangchenghao/dsh-web-search',
      factory: function (require) {
        try {
          var React = require('react');
          var h = React.createElement;

          /** Compare dotted versions without treating a local build as older. */
          function isNewerVersion(candidate, current) {
            try {
              var a = String(candidate).split('-')[0].split('.').map(function (part) { return Number(part); });
              var b = String(current).split('-')[0].split('.').map(function (part) { return Number(part); });
              var length = Math.max(a.length, b.length);
              for (var i = 0; i < length; i += 1) {
                var left = a[i] === undefined || !isFinite(a[i]) ? 0 : a[i];
                var right = b[i] === undefined || !isFinite(b[i]) ? 0 : b[i];
                if (left !== right) return left > right;
              }
              return String(candidate).indexOf('-') === -1 && String(current).indexOf('-') !== -1;
            } catch (ignored) {
              return false;
            }
          }

          /** The one-click updater route only exists on the local desktop surface. */
          function isLocalPage() {
            try {
              var host = window.location.hostname;
              return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
            } catch (ignored) {
              return false;
            }
          }

          /** Dictionary namespace owned by this plugin. */
          var NS = 'webSearchBing';
          /** The Settings surface slot: one settings page per list entry. */
          var SLOT = 'settings.section';
          /** Loader entry id the Host projects this plugin's Config under. */
          var ENTRY = 'web-search-bing';
          var PACKAGE_NAME = 'dsh-web-search-bing';
          /** Keep in step with package.json; compared with the npm registry. */
          var VERSION = '0.22.0';
          /** Snapshot used while no configuration service is reachable. */
          var EMPTY_STATE = { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false };

          // English copy. Every label the page renders lives here.
          var en = {
            title: 'Web search (Bing)',
            description: 'Edit the key-free search provider: engine allow-list, wait policy, proxy, result budget, ranking, cache, cooldowns and dedicated sources. Model tools: web_search, web_fetch and one unified web_tools action tool (legacy eight-name mode is opt-in).',
            jumpTo: 'Jump to',
            latest: 'Latest on npm',
            upToDate: 'up to date',
            updateAvailable: 'update available',
            'group.engines': 'Engines and transport',
            'group.ranking': 'Results and ranking',
            'group.fetch': 'Fetching',
            'group.cache': 'Cache and cooldowns',
            'group.domain': 'Dedicated sources',
            'group.tools': 'Model tools',
            'field.toolSurface': 'Tool surface',
            'hint.toolSurface': 'unified exposes one web_tools with eight actions and is the recommended context-efficient mode; legacy keeps the old eight names for existing prompts. Restart the plugin after changing this.',
            'toolSurface.unified': 'Unified (one web_tools)',
            'toolSurface.legacy': 'Legacy (eight names)',
            'wait.auto': 'Auto (query language)',
            'wait.all': 'All engines',
            'wait.fast': 'Fastest answer',
            loading: 'Loading configuration…',
            unavailable: 'This plugin\'s settings are not available in this deployment yet.',
            servedNone: 'No settings namespace is served yet.',
            readOnly: 'This deployment stores settings read-only.',
            save: 'Save',
            saving: 'Saving…',
            discard: 'Discard changes',
            saved: 'Saved.',
            saveFailed: 'The deployment did not accept these values; they were kept for correction.',
            'field.hosts': 'Only these engines (8 total)',
            'hint.hosts': 'Four primary: anysearch, exa, ddg-html, cn.bing. Four fallback: firecrawl, www.bing, ddg-lite, so. Empty means all eight; a comma-separated list narrows the set.',
            'field.timeoutMs': 'Wait limit (ms)',
            'hint.timeoutMs': 'How long one engine may take; raise it on a slow network',
            'field.wait': 'How long to wait',
            'hint.wait': 'auto decides from the question language, all waits for everyone, fast takes the first answer',
            'field.proxy': 'Proxy (relay)',
            'hint.proxy': 'Relay address for blocked sites; empty auto-detects the system proxy',
            'field.fetchFormat': 'Fetched page style',
            'hint.fetchFormat': 'markdown keeps headings, lists, tables and links; text keeps words only',
            'field.fetchMaxLength': 'Fetched characters',
            'hint.fetchMaxLength': 'Characters returned per fetch (1000-200000); the rest is noted as truncated',
            'field.renderJs': 'JavaScript rendering',
            'hint.renderJs': 'auto renders only a page that looks like an empty script shell, always renders every page, off never does. Needs Playwright installed separately; without it the page is returned unrendered',
            'renderJs.auto': 'Auto (only shell pages)',
            'renderJs.always': 'Always render',
            'renderJs.off': 'Off',
            'field.renderTimeoutMs': 'Render wait limit (ms)',
            'hint.renderTimeoutMs': 'How long one browser render may take (1000-120000); 15000 normally, raise it for heavy pages',
            'field.limit': 'Results per search',
            'hint.limit': 'How many results come back, and how they are split across engines',
            'field.rrfConstant': 'Result blending',
            'hint.rrfConstant': 'How strongly engines are blended; 60 is a sane default',
            'field.authorityDomains': 'Trusted sites',
            'hint.authorityDomains': 'Sites you trust, comma separated; optional',
            'field.authorityBoost': 'Trusted-site boost',
            'hint.authorityBoost': 'How far trusted sites move up',
            'field.freshnessBoost': 'Freshness boost',
            'hint.freshnessBoost': 'How far recent pages move up',
            'field.freshnessDays': 'Freshness window (days)',
            'hint.freshnessDays': 'Older pages stop receiving the freshness boost',
            'field.timeRange': 'Time range',
            'hint.timeRange': 'Only keep results published inside this window; undated results stay but rank lower',
            'timeRange.off': 'Any time',
            'timeRange.day': 'Past 24 hours',
            'timeRange.week': 'Past 7 days',
            'timeRange.month': 'Past 30 days',
            'timeRange.year': 'Past year',
            'field.blockedDomains': 'Blocked sites',
            'hint.blockedDomains': 'Domains that must never appear (spam.example, ads.example); subdomains are blocked too. Empty blocks nothing.',
            'field.safeSearch': 'Safe search',
            'hint.safeSearch': 'Applies only to Bing and DuckDuckGo; off keeps each engine default',
            'safeSearch.off': 'Off (engine default)',
            'safeSearch.moderate': 'Moderate',
            'safeSearch.strict': 'Strict',
            'field.fallbackOn': 'Fallback on',
            'hint.fallbackOn': 'Failure classes that may switch to a fallback engine. Empty means never fall back; all six means search never fails just because one engine did.',
            'testTitle': 'Engine health',
            'testHint': 'Run one tiny query through each engine. This does not use the cache or change cooldowns.',
            'testButton': 'Test engines',
            'testRunning': 'Testing…',
            'testUnavailable': 'The test endpoint is not available in this deployment.',
            'testFailed': 'The test could not run.',
            'testSummary': 'OK / failed',
            'field.cacheTtlMs': 'Cache lifetime',
            'hint.cacheTtlMs': 'How long an identical question reuses its cached answer (ms)',
            'field.cacheEntries': 'Cache size',
            'hint.cacheEntries': 'How many answers are remembered before the least recently used goes',
            'field.cachePersist': 'Save cache to disk',
            'hint.cachePersist': 'Keep recent answers across restarts; turn it off to stay memory-only',
            'cachePersist.true': 'On (save to disk)',
            'cachePersist.false': 'Off (memory only)',
            'field.cacheFile': 'Cache file',
            'hint.cacheFile': 'Empty uses ~/.dsh/cache/dsh-web-search/cache.json',
            'field.anysearchApiKey': 'AnySearch key',
            'hint.anysearchApiKey': 'Leave empty to stay anonymous at a lower rate limit; only sent to api.anysearch.com. Separate several keys with commas and the plugin rotates them.',
            'field.anysearchDomain': 'Vertical domain',
            'hint.anysearchDomain': 'Restrict to one vertical (finance, academic, code…); leave empty normally',
            'field.baseCooldownMs': 'Cooldown (ms)',
            'hint.baseCooldownMs': 'How long an engine rests after it reports throttling (ms)',
            'field.maxCooldownMs': 'Max cooldown (ms)',
            'hint.maxCooldownMs': 'Ceiling for repeated throttling (ms); rarely worth changing',
            'field.domainSources': 'Dedicated sources',
            'hint.domainSources': 'Eight are on by default (github, npm, pypi, arxiv, wikipedia, hn, stackexchange, crates); 26 more exist. Empty means the default eight.',
            'field.domainLimit': 'Results per source',
            'hint.domainLimit': 'How many results each dedicated source returns (1-20); 5 is a sane default',
            'field.domainTimeoutMs': 'Source wait limit (ms)',
            'hint.domainTimeoutMs': 'How long one dedicated source may take; 8000 normally, 15000 on a slow network',
            invalidNumber: 'Enter a number within the allowed range, or leave blank for the default.'
                    };

          // Simplified Chinese copy.
          var zh = {
            title: '网页搜索（Bing）',
            jumpTo: '跳到',
            latest: 'npm 最新版',
            autoUpdateHint: '定时自动更新需要 profile 更新器（dsh-autoupdater）；「安装更新」按钮不依赖它：它会请 Host 插件管理器安装 npm 包，装完需重启。link:/file: 安装会被拒绝。',
            updateButton: '安装更新',
            updateInstalling: '正在安装…请保持此页打开。',
            updateDone: '更新已安装。',
            updateRestart: '更新已安装；重启 DeepSeek Harness 后生效。',
            updateFailed: '更新失败：',
            updateLocal: '当前是 link:/file: 安装。请先改成 npm 安装，再使用这个按钮。',
            updateRemote: '更新按钮只在本地桌面 App 中可用。',
            updateUnavailable: '当前部署没有内置插件管理器；请用 profile 的包管理器更新。',
            upToDate: '已是最新',
            updateAvailable: '有新版本',
            description: '编辑免密钥搜索提供方：引擎白名单、等待策略、代理、结果上限、排序、缓存、冷却与专用检索源。模型工具：web_search、web_fetch，以及一个统一的 web_tools action 工具（旧版八个工具名可选）。',
            'group.engines': '引擎与传输',
            'group.ranking': '结果与排序',
            'group.fetch': '抓取',
            'group.cache': '缓存与冷却',
            'group.domain': '专用检索',
            'group.tools': '模型工具',
            'field.toolSurface': '工具面',
            'hint.toolSurface': 'unified 只暴露一个 web_tools、用 action 调用八种能力，推荐且更省上下文；legacy 保留原来的八个工具名，兼容旧提示词。修改后需要重启插件。',
            'toolSurface.unified': '统一（一个 web_tools）',
            'toolSurface.legacy': '旧版（八个工具名）',
            'wait.auto': '自动（按提问语言）',
            'wait.all': '等待全部引擎',
            'wait.fast': '最快回答',
            loading: '正在读取配置…',
            unavailable: '当前部署尚未提供此插件的设置。',
            servedNone: 'Host 尚未服务任何设置命名空间。',
            readOnly: '本部署的设置为只读。',
            save: '保存',
            saving: '保存中…',
            discard: '放弃更改',
            saved: '已保存。',
            saveFailed: '本部署没有接受这些值，已保留供你修改。',
            'field.hosts': '只查哪些引擎（共 8 个）',
            'hint.hosts': '主引擎 4 个：anysearch、exa、ddg-html、cn.bing；兜底 4 个：firecrawl、www.bing、ddg-lite、so。留空表示全部八个，逗号分隔可只留几个。',
            'field.timeoutMs': '等待上限（毫秒）',
            'hint.timeoutMs': '单个引擎最多等多久；网络慢可加到 20000',
            'field.wait': '等多久',
            'hint.wait': 'auto 按提问语言自动决定，all 等全部，fast 先到先用',
            'field.proxy': '代理（中转站）',
            'hint.proxy': '上网中转站地址；留空自动识别系统代理',
            'field.fetchFormat': '抓取内容的样式',
            'hint.fetchFormat': 'markdown 保留标题、列表、表格和链接；text 只留纯文字',
            'field.fetchMaxLength': '抓取字符上限',
            'hint.fetchMaxLength': '一次抓取最多返回多少字符（1000-200000）；超出部分会注明已截断',
            'field.renderJs': 'JS 渲染',
            'hint.renderJs': 'auto 只在正文像空壳网页时才用浏览器渲染，always 每次抓取都渲染，off 从不渲染；需另装 Playwright，没装就跳过',
            'renderJs.auto': '自动（仅空壳页面）',
            'renderJs.always': '每次都渲染',
            'renderJs.off': '关闭',
            'field.renderTimeoutMs': '渲染等待上限（毫秒）',
            'hint.renderTimeoutMs': '一次浏览器渲染最多等多久（1000-120000）；平时 15000，页面很重可调大',
            'field.limit': '返回几条',
            'hint.limit': '一次最多返回几条，也决定各引擎分到几条',
            'field.rrfConstant': '结果混合力度',
            'hint.rrfConstant': '多引擎结果的混合力度；不想微调就保持 60',
            'field.authorityDomains': '可信网站名单',
            'hint.authorityDomains': '你认为更可信的网站，逗号分隔；不填也行',
            'field.authorityBoost': '可信网站加分',
            'hint.authorityBoost': '可信网站往上提多少；越大越明显',
            'field.freshnessBoost': '新内容加分',
            'hint.freshnessBoost': '较新的网页往上提多少；常查新闻可调大',
            'field.freshnessDays': '多少天内算新',
            'hint.freshnessDays': '超过这些天的结果不再享受时效加分',
            'field.timeRange': '时间范围',
            'hint.timeRange': '只保留这段时间内发布的结果；没有发布日期的结果会保留但排后面',
            'timeRange.off': '不限时间',
            'timeRange.day': '最近 24 小时',
            'timeRange.week': '最近 7 天',
            'timeRange.month': '最近 30 天',
            'timeRange.year': '最近 1 年',
            'field.blockedDomains': '屏蔽网站',
            'hint.blockedDomains': '永远不要出现在结果里的网站（如 spam.example、ads.example），子域名也会被屏蔽；留空表示不屏蔽。',
            'field.safeSearch': '安全搜索',
            'hint.safeSearch': '只影响 Bing 和 DuckDuckGo；off 保持引擎默认',
            'safeSearch.off': '关闭（引擎默认）',
            'safeSearch.moderate': '适中',
            'safeSearch.strict': '严格',
            'field.fallbackOn': '哪些失败可回退',
            'hint.fallbackOn': '允许切换到备用引擎的失败类别；留空表示任何失败都不回退，六类全选表示一个引擎失败不会让搜索失败。',
            'testTitle': '引擎健康',
            'testHint': '用一条短查询逐个测试引擎；不会使用缓存，也不会改变冷却状态。',
            'testButton': '测试引擎',
            'testRunning': '测试中…',
            'testUnavailable': '当前部署没有提供测试接口。',
            'testFailed': '测试没能执行。',
            'testSummary': '成功 / 失败',
            'field.cacheTtlMs': '缓存保留多久',
            'hint.cacheTtlMs': '同一问题复用旧结果多久（毫秒）；想更快见新内容就调小',
            'field.cacheEntries': '缓存条数上限',
            'hint.cacheEntries': '最多记住多少条旧结果，满了丢最久没用的',
            'field.cachePersist': '缓存保存到磁盘',
            'hint.cachePersist': '重启后仍复用最近结果；关闭则只在内存中保存',
            'cachePersist.true': '开启（保存到磁盘）',
            'cachePersist.false': '关闭（仅内存）',
            'field.cacheFile': '缓存文件路径',
            'hint.cacheFile': '留空使用 ~/.dsh/cache/dsh-web-search/cache.json',
            'field.anysearchApiKey': 'AnySearch 通行证',
            'hint.anysearchApiKey': '没有就留空，仍可用但速率较低；只发给 api.anysearch.com。有多个 key 用逗号分隔，插件会自动轮换。',
            'field.anysearchDomain': '专业领域',
            'hint.anysearchDomain': '只搜某类专业内容（finance/academic/code 等）；日常留空',
            'field.baseCooldownMs': '被拒后歇多久',
            'hint.baseCooldownMs': '某个引擎说太频繁后先歇多久（毫秒）；默认 5 分钟即可',
            'field.maxCooldownMs': '歇息上限',
            'hint.maxCooldownMs': '反复被拒时歇息时间的上限（毫秒）；一般不用改',
            'field.domainSources': '默认查哪些专用源',
            'hint.domainSources': '默认开八个（github、npm、pypi、arxiv、wikipedia、hn、stackexchange、crates），另有 26 个可用；留空即默认八个。',
            'field.domainLimit': '每个源返回几条',
            'hint.domainLimit': '每个专用源最多返回几条（1-20）；默认 5 条即可',
            'field.domainTimeoutMs': '每个源等待上限',
            'hint.domainTimeoutMs': '单个专用源最多等多久（毫秒）；平时 8000，网络慢可加到 15000',
            invalidNumber: '请填写允许范围内的数字；留空表示使用默认值。'
                    };

          /** Field descriptors: schema key, group, control kind and bounds. */
          var FIELDS = [
            { key: 'hosts', group: 'engines', kind: 'list' },
            { key: 'wait', group: 'engines', kind: 'select', options: ['auto', 'all', 'fast'] },
            { key: 'timeoutMs', group: 'engines', kind: 'number', integer: true, min: 500 },
            { key: 'proxy', group: 'engines', kind: 'text' },
            { key: 'fetchFormat', group: 'fetch', kind: 'select', options: ['markdown', 'text'] },
            { key: 'fetchMaxLength', group: 'fetch', kind: 'number', integer: true, min: 1000, max: 200000 },
            { key: 'renderJs', group: 'fetch', kind: 'select', options: ['auto', 'always', 'off'] },
            { key: 'renderTimeoutMs', group: 'fetch', kind: 'number', integer: true, min: 1000, max: 120000 },
            { key: 'anysearchApiKey', group: 'engines', kind: 'text' },
            { key: 'anysearchDomain', group: 'engines', kind: 'text' },
            { key: 'limit', group: 'ranking', kind: 'number', integer: true, min: 1, max: 20 },
            { key: 'rrfConstant', group: 'ranking', kind: 'number', integer: true, min: 1 },
            { key: 'authorityDomains', group: 'ranking', kind: 'list' },
            { key: 'authorityBoost', group: 'ranking', kind: 'number', min: 0, max: 10 },
            { key: 'freshnessBoost', group: 'ranking', kind: 'number', min: 0, max: 10 },
            { key: 'freshnessDays', group: 'ranking', kind: 'number', integer: true, min: 1 },
            { key: 'timeRange', group: 'ranking', kind: 'select', options: ['off', 'day', 'week', 'month', 'year'] },
            { key: 'blockedDomains', group: 'engines', kind: 'list' },
            { key: 'safeSearch', group: 'engines', kind: 'select', options: ['off', 'moderate', 'strict'] },
            { key: 'fallbackOn', group: 'engines', kind: 'list' },
            { key: 'cacheTtlMs', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'cacheEntries', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'cachePersist', group: 'cache', kind: 'select', options: ['true', 'false'], boolean: true },
            { key: 'cacheFile', group: 'cache', kind: 'text' },
            { key: 'baseCooldownMs', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'maxCooldownMs', group: 'cache', kind: 'number', integer: true, min: 0 },
            { key: 'domainSources', group: 'domain', kind: 'list' },
            { key: 'domainLimit', group: 'domain', kind: 'number', integer: true, min: 1, max: 20 },
            { key: 'domainTimeoutMs', group: 'domain', kind: 'number', integer: true, min: 500 },
            { key: 'toolSurface', group: 'tools', kind: 'select', options: ['unified', 'legacy'] }
          ];

          /** Groups in render order. */
          var GROUPS = ['engines', 'ranking', 'fetch', 'cache', 'domain', 'tools'].map(function (group) {
            return { key: group, fields: FIELDS.filter(function (field) { return field.group === group; }) };
          });

          var groupStyle = {
            display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-2)'
          };
          var gridStyle = {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '10px 14px'
          };
          var labelStyle = {
            display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 600,
            lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)'
          };
          var hintStyle = {
            display: 'block', marginTop: '4px', fontSize: '11px', lineHeight: 1.45,
            color: 'var(--dsw-alias-label-tertiary)'
          };
          var errorStyle = {
            display: 'block', marginTop: '4px', fontSize: '11px', lineHeight: 1.45,
            color: 'var(--dsw-alias-state-error-primary)'
          };
          var inputStyle = {
            boxSizing: 'border-box', width: '100%', padding: '6px 8px', fontSize: '13px',
            lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '6px'
          };
          var buttonStyle = {
            font: 'inherit', fontSize: '13px', lineHeight: 1.4, padding: '6px 14px',
            borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer'
          };
          var primaryStyle = Object.assign({}, buttonStyle, {
            background: 'var(--dsw-alias-button-primary-fill)',
            borderColor: 'var(--dsw-alias-button-primary-fill)',
            color: 'var(--dsw-alias-label-primary-foreground)'
          });

          /** A state snapshot that never changes, for the no-service case. */
          function emptySnapshot() { return EMPTY_STATE; }

          /** React 18's external-store hook, with a small fallback. */
          var useSync = typeof React.useSyncExternalStore === 'function'
            ? React.useSyncExternalStore
            : function (subscribe, getSnapshot) {
              var pair = React.useState(getSnapshot);
              React.useEffect(function () {
                return subscribe(function () { pair[1](getSnapshot()); });
              }, [subscribe, getSnapshot]);
              return pair[0];
            };

          /** True when the deployment exposes the shared settings-form service. */
          function hasFormService(ctx) {
            var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
            return forms !== undefined && forms !== null && typeof forms.get === 'function';
          }

          /**
           * The namespaces the Host currently serves, as one stable string.
           * `configForms.get` only answers for a namespace the Host has projected,
           * and that projection arrives asynchronously, so the page has to watch
           * this instead of reading it once at mount.
           * @param ctx - the plugin context.
           * @returns served namespace names joined by `|`.
           */
          function servedKeyOf(ctx) {
            try {
              var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
              var mirror = forms === undefined || forms === null ? undefined : forms.mirror;
              var snapshot = mirror !== undefined && mirror !== null && typeof mirror.getSnapshot === 'function' ? mirror.getSnapshot() : null;
              var view = snapshot === null || snapshot === undefined ? undefined : snapshot.view;
              var namespaces = view === undefined || view === null || !Array.isArray(view.namespaces) ? [] : view.namespaces;
              var names = [];
              for (var i = 0; i < namespaces.length; i += 1) {
                var ns = namespaces[i] === undefined || namespaces[i] === null ? undefined : namespaces[i].ns;
                if (typeof ns === 'string' && ns.length > 0) names.push(ns);
              }
              return names.join('|');
            } catch (error) {
              warn(error);
              return '';
            }
          }

          /**
           * Watch the settings mirror; `ensure()` starts the read, so subscribing
           * is enough to make the projection arrive.
           * @param ctx - the plugin context.
           * @param listener - called on every settings change.
           * @returns the unsubscribe function.
           */
          function subscribeForms(ctx, listener) {
            try {
              var forms = ctx === undefined || ctx === null ? undefined : ctx.configForms;
              var mirror = forms === undefined || forms === null ? undefined : forms.mirror;
              if (mirror !== undefined && mirror !== null && typeof mirror.subscribe === 'function') {
                var off = mirror.subscribe(listener);
                if (typeof mirror.ensure === 'function') mirror.ensure();
                return typeof off === 'function' ? off : function () {};
              }
            } catch (error) {
              warn(error);
            }
            return function () {};
          }

          /**
           * Candidate namespaces, most specific first: the patch id, the full
           * Loader entry id, the package name, and finally a suffix match so a
           * prefixed namespace still resolves.
           * @param served - the served namespace names.
           * @returns the namespace to read, or null when none matches.
           */
          function pickNamespace(served) {
            var wanted = [ENTRY, 'include:' + ENTRY, PACKAGE_NAME];
            for (var i = 0; i < wanted.length; i += 1) {
              if (served.indexOf(wanted[i]) >= 0) return wanted[i];
            }
            for (var j = 0; j < served.length; j += 1) {
              if (served[j].length > 0 && served[j].indexOf(ENTRY) >= 0) return served[j];
            }
            return null;
          }

          /** Field values as editable text. */
          function toDraft(values) {
            var draft = {};
            for (var i = 0; i < FIELDS.length; i += 1) {
              var field = FIELDS[i];
              var value = values === undefined ? undefined : values[field.key];
              draft[field.key] = field.kind === 'list'
                ? (Array.isArray(value) ? value.join(', ') : (typeof value === 'string' ? value : ''))
                : (value === undefined || value === null ? '' : String(value));
            }
            return draft;
          }

          /** Split a comma/whitespace separated list. */
          function splitList(text) {
            return String(text === undefined || text === null ? '' : text)
              .split(/[\s,]+/)
              .filter(function (part) { return part.length > 0; });
          }

          /** Convert one draft value into a form operation, or record an error. */
          function operation(field, raw, current, errors, t) {
            var key = field.key;
            if (field.kind === 'list') {
              var list = splitList(raw);
              var previous = Array.isArray(current) ? current : [];
              if (JSON.stringify(list) === JSON.stringify(previous)) return null;
              return { op: 'set', path: [key], value: list };
            }
            if (field.kind === 'select') {
              var next = field.boolean === true ? raw === 'true' : raw;
              if (next === current) return null;
              return raw === '' ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value: next };
            }
            if (field.kind === 'text') {
              var text = String(raw === undefined || raw === null ? '' : raw);
              if (text === current) return null;
              return { op: 'set', path: [key], value: text };
            }
            var trimmed = String(raw === undefined || raw === null ? '' : raw).trim();
            if (trimmed === '') {
              return current === undefined ? null : { op: 'unset', path: [key] };
            }
            var numeric = Number(trimmed);
            var invalid = !isFinite(numeric)
              || (field.integer === true && Math.floor(numeric) !== numeric)
              || (field.min !== undefined && numeric < field.min)
              || (field.max !== undefined && numeric > field.max);
            if (invalid) {
              errors[key] = t('invalidNumber');
              return null;
            }
            if (numeric === current) return null;
            return { op: 'set', path: [key], value: numeric };
          }

          /** One page of the Settings surface. */
          function SettingsPage(props) {
            var t = props.t;
            // Read through on every render: the namespace may become served after
            // the page first mounts, and a captured handle would stay stale.
            // Watch the served namespaces first: the Host projects this row's
            // settings asynchronously, so a form read at mount time is absent.
            var surface = props.surface;
            var servedKey = useSync(
              function (listener) { return surface.subscribe(listener); },
              function () { return surface.servedKey(); }
            );
            var served = servedKey.length === 0 ? [] : servedKey.split('|');
            var namespace = surface.hasService() ? pickNamespace(served) : null;
            var form = namespace === null ? null : surface.form(namespace);
            var subscribe = React.useCallback(function (listener) {
              return form && typeof form.subscribe === 'function' ? form.subscribe(listener) : function () {};
            }, [form]);
            var getSnapshot = React.useCallback(function () {
              return form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : emptySnapshot();
            }, [form]);
            var state = useSync(subscribe, getSnapshot);
            var draftPair = React.useState(null);
            var draft = draftPair[0];
            var setDraft = draftPair[1];
            var savePair = React.useState('idle');
            var phase = savePair[0];
            var setPhase = savePair[1];
            var errorPair = React.useState({});
            var errors = errorPair[0];
            var setErrors = errorPair[1];
            var latestPair = React.useState(null);
            var latest = latestPair[0];
            var setLatest = latestPair[1];
            var testPair = React.useState({ phase: 'idle', value: null, error: null });
            var test = testPair[0];
            var setTest = testPair[1];
            var installPair = React.useState({ phase: 'idle', message: '', version: '' });
            var installation = installPair[0];
            var setInstallation = installPair[1];

            // Ask the npm registry once per mount. A failure (offline, proxy
            // down, registry error) hides the line instead of showing an
            // invented version; the page must never lie about an update.
            React.useEffect(function () {
              var alive = true;
              try {
                fetch('https://registry.npmjs.org/@fffangchenghao%2Fdsh-web-search/latest', { headers: { accept: 'application/json' } })
                  .then(function (response) { return response.ok ? response.json() : null; })
                  .then(function (body) {
                    if (alive && body !== null && typeof body.version === 'string') setLatest(body.version);
                  })
                  .catch(function () {});
              } catch (ignored) {
                /* fetch unavailable: the page simply omits the line */
              }
              return function () { alive = false; };
            }, []);

            React.useEffect(function () {
              setDraft(null);
              setPhase('idle');
              setErrors({});
            }, [state.revision]);

            function installUpdate() {
              if (installation.phase === 'working') return;
              setInstallation({ phase: 'working', message: '', version: '' });
              try {
                fetch('/api/dsh-web-search/update', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}'
                }).then(function (response) {
                  return response.json().then(function (body) {
                    return { status: response.status, body: body };
                  }, function () {
                    return { status: response.status, body: null };
                  });
                }).then(function (out) {
                  var body = out.body;
                  if (out.status === 200 && body !== null && body.ok === true) {
                    setInstallation({
                      phase: body.restartRequired === true ? 'restart' : 'done',
                      message: '',
                      version: typeof body.version === 'string' ? body.version : ''
                    });
                    return;
                  }
                  var code = body === null ? '' : body.code;
                  var message = code === 'local-install'
                    ? t('updateLocal')
                    : code === 'manager-unavailable' || out.status === 404 || out.status === 405
                      ? t('updateUnavailable')
                      : body !== null && typeof body.message === 'string'
                        ? body.message
                        : t('updateFailed') + 'HTTP ' + out.status;
                  setInstallation({ phase: 'failed', message: message, version: '' });
                }, function (error) {
                  setInstallation({ phase: 'failed', message: String(error), version: '' });
                });
              } catch (error) {
                setInstallation({ phase: 'failed', message: String(error), version: '' });
              }
            }

            var ready = form !== null && form !== undefined && state.status === 'ready';
            var values = ready && state.value !== null && typeof state.value === 'object' ? state.value : {};
            var current = draft === null ? toDraft(values) : draft;

            function edit(key, text) {
              var next = Object.assign({}, current);
              next[key] = text;
              setDraft(next);
              setPhase('idle');
              if (errors[key] !== undefined) {
                var cleared = Object.assign({}, errors);
                delete cleared[key];
                setErrors(cleared);
              }
            }

            function runEngineTest() {
              if (test.phase === 'running') return;
              setTest({ phase: 'running', value: null, error: null });
              var request;
              try {
                request = fetch('/api/dsh-web-search/engine-test', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', accept: 'application/json' },
                  body: JSON.stringify({ query: 'DeepSeek Harness' })
                });
              } catch (error) {
                setTest({ phase: 'failed', value: null, error: t('testUnavailable') });
                return;
              }
              Promise.resolve(request).then(function (response) {
                return Promise.resolve(response.text()).then(function (text) {
                  var body = null;
                  try {
                    body = text.length === 0 ? null : JSON.parse(text);
                  } catch (ignored) {
                    body = null;
                  }
                  if (!response.ok || body === null || body.ok !== true || body.value === undefined) {
                    var fallback = response.status === 404 || response.status === 405
                      ? t('testUnavailable')
                      : t('testFailed');
                    throw new Error(body !== null && typeof body.message === 'string' ? body.message : fallback);
                  }
                  setTest({ phase: 'done', value: body.value, error: null });
                });
              }).catch(function (error) {
                setTest({ phase: 'failed', value: null, error: error instanceof Error ? error.message : t('testUnavailable') });
              });
            }

            function save() {
              if (!ready || state.writable === false || phase === 'saving') return;
              var nextErrors = {};
              var operations = [];
              for (var i = 0; i < FIELDS.length; i += 1) {
                var op = operation(FIELDS[i], current[FIELDS[i].key], values[FIELDS[i].key], nextErrors, t);
                if (op !== null) operations.push(op);
              }
              if (Object.keys(nextErrors).length > 0) {
                setErrors(nextErrors);
                setPhase('idle');
                return;
              }
              if (operations.length === 0) {
                setDraft(null);
                setPhase('saved');
                return;
              }
              setPhase('saving');
              setErrors({});
              Promise.resolve(form.mutate(operations, state.revision)).then(function (accepted) {
                if (accepted === false) {
                  setPhase('failed');
                  return;
                }
                setDraft(null);
                setPhase('saved');
              }, function (error) {
                warn(error);
                setPhase('failed');
              });
            }

            var children = [
              h('h3', { key: 'title', style: { margin: 0, fontSize: '16px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, t('title')),
              h('p', { key: 'description', style: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('description'))
            ];
            if (latest !== null) {
              var newer = isNewerVersion(latest, VERSION);
              children.push(h('p', {
                key: 'latest',
                style: { margin: 0, fontSize: '12px', color: newer ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)' },
                role: 'status'
              }, t('latest') + ': ' + latest + (newer ? ' — ' + t('updateAvailable') : ' — ' + t('upToDate'))));
              children.push(h('p', {
                key: 'auto-update', style: { margin: 0, fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }, role: 'note'
              }, t('autoUpdateHint')));
              if (newer) {
                if (isLocalPage()) {
                  children.push(h('button', {
                    key: 'install-update',
                    type: 'button',
                    disabled: installation.phase === 'working',
                    onClick: installUpdate,
                    style: {
                      alignSelf: 'flex-start',
                      padding: '5px 10px',
                      borderRadius: '6px',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                      cursor: installation.phase === 'working' ? 'wait' : 'pointer',
                      fontSize: '12px'
                    }
                  }, installation.phase === 'working' ? t('updateInstalling') : t('updateButton')));
                } else {
                  children.push(h('p', {
                    key: 'update-remote', style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }
                  }, t('updateRemote')));
                }
              }
              if (installation.phase === 'working') {
                children.push(h('p', {
                  key: 'update-status', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }, role: 'status', 'aria-live': 'polite'
                }, t('updateInstalling')));
              } else if (installation.phase === 'restart' || installation.phase === 'done') {
                children.push(h('p', {
                  key: 'update-status', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))' }, role: 'status'
                }, t(installation.phase === 'restart' ? 'updateRestart' : 'updateDone') + (installation.version === '' ? '' : ' (' + installation.version + ')')));
              } else if (installation.phase === 'failed') {
                children.push(h('p', {
                  key: 'update-status', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)' }, role: 'alert'
                }, t('updateFailed') + installation.message));
              }
            }

            if (!ready) {
              if (!surface.hasService()) {
                children.push(h('p', { key: 'note', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }, role: 'status' }, t('unavailable')));
              } else if (namespace === null) {
                // The service is here but this row's namespace is not among the
                // ones the Host serves; show them, so the mismatch names itself.
                children.push(h('p', { key: 'note', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }, role: 'status' }, t('loading')));
                children.push(h('p', { key: 'served', style: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' }, 'data-dsw-probe': 'served' }, served.length === 0 ? t('servedNone') : served.join(' · ')));
              } else {
                children.push(h('p', { key: 'note', style: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }, role: 'status' }, t('loading')));
              }
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' } }, children);
            }

            if (state.writable === false) {
              children.push(h('p', { key: 'readonly', style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('readOnly')));
            }

            var jump = GROUPS.map(function (group) {
              return h('a', {
                key: group.key,
                href: '#dsh-ws-group-' + group.key,
                onClick: function (event) {
                  event.preventDefault();
                  try {
                    var target = document.getElementById('dsh-ws-group-' + group.key);
                    if (target !== null) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  } catch (ignored) {
                    /* older engines still jump through the href */
                  }
                },
                style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', whiteSpace: 'nowrap' }
              }, t('group.' + group.key));
            });
            children.push(h('nav', {
              key: 'toc',
              'aria-label': t('jumpTo'),
              style: {
                position: 'sticky', top: 0, zIndex: 1,
                display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                padding: '6px 0',
                background: 'var(--dsw-alias-bg-base)',
                borderBottom: '1px solid var(--dsw-alias-border-l1)'
              }
            }, [h('span', { key: 'label', style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('jumpTo'))].concat(jump)));

            children.push(h('div', { key: 'groups', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, GROUPS.map(function (group) {
              return h('section', { key: group.key, id: 'dsh-ws-group-' + group.key, style: groupStyle }, [
                h('h4', { key: 'title', style: { margin: 0, fontSize: '13px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, t('group.' + group.key)),
                h('div', { key: 'grid', style: gridStyle }, group.fields.map(function (field) {
                  var key = field.key;
                  var disabled = state.writable === false || phase === 'saving';
                  var control;
                  if (field.kind === 'select') {
                    control = h('select', {
                      value: current[key],
                      disabled: disabled,
                      style: inputStyle,
                      onChange: function (event) { edit(key, event.target.value); }
                    }, field.options.map(function (option) {
                      return h('option', { key: option, value: option }, t(field.key + '.' + option));
                    }));
                  } else {
                    control = h('input', {
                      type: field.kind === 'number' ? 'number' : 'text',
                      value: current[key],
                      disabled: disabled,
                      inputMode: field.kind === 'number' ? 'decimal' : undefined,
                      min: field.min,
                      max: field.max,
                      step: field.kind === 'number' && field.integer === true ? 1 : undefined,
                      placeholder: field.kind === 'number' ? 'default' : undefined,
                      spellCheck: false,
                      style: inputStyle,
                      onChange: function (event) { edit(key, event.target.value); }
                    });
                  }
                  return h('label', { key: key, style: { display: 'block', minWidth: 0 } }, [
                    h('span', { key: 'label', style: labelStyle }, t('field.' + key)),
                    control,
                    errors[key] !== undefined
                      ? h('span', { key: 'error', style: errorStyle, role: 'alert' }, errors[key])
                      : h('span', { key: 'hint', style: hintStyle }, t('hint.' + key))
                  ]);
                }))
              ]);
            })));

            var testStatus = null;
            if (test.phase === 'running') {
              testStatus = h('p', { key: 'test-running', style: hintStyle, role: 'status' }, t('testRunning'));
            } else if (test.phase === 'failed') {
              testStatus = h('p', { key: 'test-failed', style: errorStyle, role: 'alert' }, test.error === null ? t('testFailed') : test.error);
            } else if (test.phase === 'done' && test.value !== null) {
              var rows = (Array.isArray(test.value.results) ? test.value.results : []).map(function (result) {
                var kind = result.ok === true ? 'OK' : 'FAIL';
                var detail = result.ok === true
                  ? String(result.latencyMs) + 'ms · ' + String(result.count) + ' result(s)'
                  : (typeof result.failureKind === 'string' ? '[' + result.failureKind + '] ' : '') + (typeof result.reason === 'string' ? result.reason : '');
                return h('li', { key: result.engine, style: { margin: '2px 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' } },
                  result.engine + ': ' + kind + ' · ' + detail);
              });
              testStatus = h('div', { key: 'test-done' }, [
                h('p', { key: 'summary', style: hintStyle, role: 'status' }, t('testSummary') + ': ' + String(test.value.ok) + ' / ' + String(test.value.failed)),
                h('ul', { key: 'rows', style: { margin: 0, paddingLeft: '18px' } }, rows)
              ]);
            }
            children.push(h('section', { key: 'engine-test', style: groupStyle }, [
              h('h4', { key: 'title', style: { margin: 0, fontSize: '13px', lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' } }, t('testTitle')),
              h('p', { key: 'hint', style: hintStyle }, t('testHint')),
              h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'run', type: 'button', style: buttonStyle,
                  disabled: test.phase === 'running',
                  onClick: runEngineTest
                }, t(test.phase === 'running' ? 'testRunning' : 'testButton')),
                testStatus
              ])
            ]));

            var footer = [
              h('button', {
                key: 'save', type: 'button', style: primaryStyle,
                disabled: state.writable === false || phase === 'saving',
                onClick: save
              }, t(phase === 'saving' ? 'saving' : 'save')),
              h('button', {
                key: 'discard', type: 'button', style: buttonStyle,
                disabled: state.writable === false || phase === 'saving' || draft === null,
                onClick: function () {
                  setDraft(null);
                  setErrors({});
                  setPhase('idle');
                }
              }, t('discard'))
            ];
            if (phase === 'saved') footer.push(h('span', { key: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' }, role: 'status' }, t('saved')));
            if (phase === 'failed') footer.push(h('span', { key: 'status', style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, t('saveFailed')));
            children.push(h('div', { key: 'footer', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, footer));

            return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)' } }, children);
          }

          /** At most one live registration; the slot may appear more than once. */
          var live = null;
          var applied = false;

          /**
           * Mount the settings page.
           * @param ctx - the browser plugin context.
           */
          function apply(ctx) {
            if (applied) return;
            try {
              if (ctx === null || ctx === undefined) return;
              if (ctx.slots === undefined || ctx.locale === undefined) return;
              if (typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return;
              if (typeof ctx.locale.register !== 'function') return;
              applied = true;

              var t = ctx.locale.bind(NS);
              if (typeof ctx.effect === 'function') {
                ctx.effect(function () {
                  return ctx.locale.register(NS, { zh: zh, en: en });
                }, 'web-search-bing: settings dictionaries');
              } else {
                ctx.locale.register(NS, { zh: zh, en: en });
              }

              /**
               * The form handle for this plugin's namespace, read on demand.
               * Reading it at mount time would cache a not-yet-served handle,
               * because the namespace is only served once the Host projects it.
               * @returns the form handle, or null when the service is absent.
               */
              function getForm() {
                try {
                  var forms = ctx.configForms;
                  if (forms === undefined || forms === null || typeof forms.get !== 'function') return null;
                  // The Host projects this row under its patch id; older
                  // projections use the full Loader entry id. Ask for both so a
                  // naming change cannot blank the page again.
                  var form = forms.get(ENTRY);
                  if (form !== undefined && form !== null) return form;
                  return forms.get('include:' + ENTRY);
                } catch (error) {
                  warn(error);
                  return null;
                }
              }

              /** The settings surface this page binds to. */
              var surface = {
                hasService: function () { return hasFormService(ctx); },
                subscribe: function (listener) { return subscribeForms(ctx, listener); },
                servedKey: function () { return servedKeyOf(ctx); },
                form: function (namespace) { return nsForm(namespace); }
              };

              /**
               * The form controller for a served namespace.
               * @param namespace - a namespace the Host serves.
               * @returns the controller, or null when it cannot be read.
               */
              function nsForm(namespace) {
                try {
                  var forms = ctx.configForms;
                  if (forms === undefined || forms === null || typeof forms.get !== 'function') return null;
                  var form = forms.get(namespace);
                  return form === undefined ? null : form;
                } catch (error) {
                  warn(error);
                  return null;
                }
              }

              mountWhenServed(ctx);

              /**
               * Register the page once the Host serves the config namespace, and
               * again if it starts serving later. `whileServed` is the shipped
               * contract for that; without it, fall back to registering now.
               */
              function mountWhenServed(context) {
                // Register now so the section appears even if the namespace is
                // still settling, then register again once it is served — the
                // second call is a no-op because mounting is guarded.
                mountSlots(context);
                var forms = context.configForms;
                if (forms === undefined || forms === null || typeof forms.whileServed !== 'function') return;
                try {
                  forms.whileServed([ENTRY, 'include:' + ENTRY], function () {
                    mountSlots(context);
                    return function () {};
                  });
                } catch (error) {
                  warn(error);
                }
              }

              /** Bind the settings page to the settings surface. */
              function mountSlots(context) {
              context.slots.inject(SLOT, function () {
                if (live !== null) return live;
                var dispose;
                try {
                  dispose = context.slots.register({
                    name: SLOT,
                    id: ENTRY,
                    order: 40,
                    label: function () { return t('title'); },
                    locale: NS
                  }, function (props) {
                    return h(SettingsPage, Object.assign({}, props, { t: t, surface: surface }));
                  });
                } catch (error) {
                  warn(error);
                  return function () {};
                }
                if (typeof dispose !== 'function') return function () {};
                live = function () {
                  try {
                    dispose();
                  } catch (error) {
                    warn(error);
                  } finally {
                    live = null;
                  }
                };
                return live;
              });
              }
            } catch (error) {
              warn(error);
            }
          }

          // `configForms` must be declared: Cordis only exposes a service on the
          // context when the module asks for it, so an undeclared one reads as
          // undefined and the page would fall back to "not available".
          return { inject: ['slots', 'locale', 'configForms'], apply: apply };
        } catch (error) {
          warn(error);
          return { inject: ['slots', 'locale', 'configForms'], apply: function () {} };
        }
      }
    });
  } catch (error) {
    warn(error);
  }
})();
