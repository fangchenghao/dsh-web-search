# dsh-web-search-bing

给 DeepSeek Harness 的 `web_search` 工具接一个**不需要任何 API key** 的搜索后端。

## 它解决什么

产品自带的搜索后端是 `@deepseek-ai/dsh-web-search-deepseek`（provider id `deepseek-official`）。
它的检索并不在本地发生，而是把一次 Messages 请求发到 DeepSeek 的 Anthropic 兼容接口，
由**服务端**原生 `web_search` 工具（`web_search_20250305` → `web_search_tool_result`）执行，
再把结果块映射成来源列表。因此：

- 没有 DeepSeek 凭据时，`apiKey()` 直接抛 `WEB_PROVIDER_CREDENTIAL_MISSING`，`web_search` 结构性失败；
- 换成第三方中转地址也救不了——搜索语义在服务端工具里，不在接口形状里。
  实测 gpugeek 的 `/v1/messages` 收下 `tools` 声明但从不执行，响应里没有
  `web_search_tool_result` 块（Claude-4.5-Sonnet 900 秒无响应；DeepSeek-V4.1-Flash 只回
  thinking 块并自述 "I don't have web search tool"），只会把凭据错误换成
  `WEB_PROVIDER_ERROR: DeepSeek returned no web_search_tool_result blocks`。

本插件把检索搬回本地：自己请求公开搜索结果页，解析出标题、链接、摘要，
再按 `ctx.web` 的 provider 契约返回。只需要普通出网能力，不需要任何密钥。

## 接口契约

`apply(ctx, config)` 内调用 `ctx.web.registerSearchProvider({ id, available, search })`：

- `id`：`bing`，由 `web.searchProvider` 选中；
- `available()`：同步，恒为 `true`；
- `search(request, signal)`：返回 `{ sources, truncated }`，`sources` 元素形如
  `{ url, title?, snippet?, publishedAt? }`——空字段直接省略，不写空串；按 URL 去重。

`web_fetch` 不经过本插件，行为不变。

## 引擎（`engines.js`）

分两档，保证被墙或变慢的引擎不会拖累已经能出结果的引擎。每个引擎还带 `region`
（`global` / `cn`）决定合并顺序，以及 `weight` 决定它在合并时占的槽位比例：

| id | 档位 | 区域 | 权重 | 出网方式 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `anysearch` | primary | **both** | 2 | 直连优先 | AnySearch 官方 JSON API（`POST api.anysearch.com/v1/search`，可匿名）。**精度最高，中英文都主导**：英文给官方文档与深度文章，中文给原版文档/译本而不是 SEO 农场；且不依赖隧道 |
| `ddg-html` | primary | global | 1 | 必须走隧道 | DuckDuckGo HTML 端点。英文原版文档最全 |
| `cn.bing` | primary | cn | 1 | 直连优先 | 中文查询主力，中英混合也能用，结果 URL 为直链 |
| `so` | primary | cn | 1 | 直连优先 | 360 搜索。中文相关性好，真实 URL 在锚点 `data-mdurl` 里 |
| `www.bing` | fallback | global | 1 | 必须走隧道 | Bing 国际版（`setmkt=en-US`）。**降级为兜底**：实测它对含停用词的英文查询只匹配单个 token（`how to set up postgres logical replication` 返回了拼图游戏站），只有前面全空时才值得一试 |
| `ddg-lite` | fallback | global | 1 | 必须走隧道 | 仅在 primary 全部零结果时才走到；`ddg-html` 的备用端点 |

primary 档**全部并发发出**；差别只在「等多久」，不发出就永远拿不到。

前两个 global 引擎都**不需要密钥**；`anysearch` 还能直连，所以即使没挂代理，
英文查询也仍有结果（此时 `ddg-html` 因必须走隧道而被过滤掉，由 `anysearch` 单独承担）。
AnySearch 匿名调用每次返回至多 10 条；申请 key 后免费额度 1,000 次/天。

### 合并顺序：按查询语言分区域

先按 `region` 分成「主导区」和「补充区」，主导区的结果先按权重交错填满 `limit`，
只有主导区不够时才用补充区的结果补齐，最后按 URL 去重（`www.` 前缀与结尾 `/` 视为同一篇）：

| 查询 | 主导区 | 效果（实测） |
| --- | --- | --- |
| 纯 ASCII（英文） | global + both | 前 8 条 8/8 全是国外资源，且全在题上（Postgres 官方文档、`tokio.rs`、`corrode.dev`、K8s 官方文档） |
| 含中日文（CJK） | cn + both | 前 8 条含 AnySearch 的原版文档/译本，中文资源为主 |

这样英文查询不会被按单个词匹配出的词典页/百科页/无关站占位——实测
`how does tokio schedule tasks` 的国内结果是 "does" 的词典页，
`how to set up postgres logical replication` 的 Bing 结果是拼图游戏站。

### 为什么中文查询也要等 AnySearch（A/B 实测）

同一查询跑两次：A 组只用国内引擎（`cn.bing` + `360`），B 组加上 AnySearch。

| 查询 | A（只用国内引擎） | B（+AnySearch） |
| --- | --- | --- |
| `如何配置 postgres 逻辑复制` | 百度百科「如何（汉语词语）」、张悬《如何》歌词解析、知乎无关帖 ❌ | Cloud SQL 官方文档、cnblogs 配置教程、AWS 规范指导、Azure 文档、腾讯云、淘宝数据库月报 ✅ |
| `Python GIL 是什么` | python.org 首页、下载页、菜鸟教程 —— **没有一条讲 GIL** ❌ | 知乎《谈谈 python 的 GIL》、`cenalulu.github.io` GIL 详解、CSDN 什么是 GIL、JetBrains 中文博客、维基「全域直譯器鎖」✅ |
| `DeepSeek Harness 插件开发` | deepseek.com 首页、百度百科、App Store、GitHub 组织页 —— 全是首页噪声 ❌ | 知乎实战教程、`github.com/deepseek-ai/deepseek-harness`、官方 harness 页、dev.to 教程、bilibili 视频 ✅ |
| `Rust 所有权 借用检查` | rust-lang 首页、菜鸟教程、百度百科 | `colobu.com` Effective Rust 中文版、reddit 讨论、rustwiki 绕例学 Rust、`rust-book.junmajinlong.com` ✅ |

差别最大的正是**疑问句和含停用词**的中文查询：国内引擎会把「如何」「是什么」当检索词，
返回词典页和百科页。代价是中文查询从 0.2–0.7s 变成 1.4–2.3s。

### 等待策略（`wait`）

一档的结束条件是四者之一：所有引擎都返回、主导区所有引擎都已返回（无论成败）、
已凑够 `limit` 条且够「贡献者数」、或软截止到点。到点仍在跑的引擎会被中止。

| `wait` | 行为 | 软截止 | 实测耗时 |
| --- | --- | --- | --- |
| `auto`（默认） | 英文等主导区（global）全部，中文等主导区（cn）全部 | 英文 6000ms / 中文 3500ms | 英文 2.6–3.8s / 中文 1.4–2.3s |
| `fast` | 1 家引擎有结果即返回 | 3500ms | 最快，跨引擎合并最少 |
| `all` | 等到**所有** primary 都返回 | 10000ms | 最全，但要等最慢的那家 |

英文查询多等两秒换来的是文档覆盖率翻倍（实测 16–30 条、12–21 个域名），值得；中文查询
多等一秒多换掉整页的词典页噪声，同样值得。

## 被拦引擎的冷却

抓公开结果页不是官方接口，请求密集时对方会回验证页（实测 360 回 `访问异常页面`
+ captcha，神马回 `x5sec` punish 页）。这类失败会记入 5 分钟冷却，冷却期内该引擎
不参与（失败列表里显示 `cooling down after a block page`），避免每次搜索都白试一遍
并反复触发对方风控。冷却不会让引擎集合变空——全都在冷却时仍会照常尝试。

国内引擎仍先直连、失败才改走隧道，所以挂着梯子时它们不会被绕道拖慢。

### 反「限流页」校验

搜索引擎对短时间内的连续无人值守请求可能不回结果页，而回一个「热门推荐」页——
里面的条目属于别人的查询。实测中这些条目曾被当成用户查询的结果。
每页都会回显查询词（搜索框里），所以每个引擎在解析前都要求页面里出现查询词的
任一 ≥3 字符片段；不出现的页面记为失败，让位给下一个引擎。

## 代理（`proxy.js`）

`fetch` 不读 macOS 系统代理，也不读 `HTTPS_PROXY`：undici 只在进程以
`NODE_USE_ENV_PROXY=1`（或 `--use-env-proxy`）启动时才认代理环境变量，
而这个开关在进程启动后无法再打开（实测进程内设置变量后仍然 `ECONNRESET`），
`undici.ProxyAgent` 也不可达（Node 不把 `undici` 暴露为模块）。
所以需要代理时本插件自己连代理：发 `CONNECT`、对 `https:` 目标做 TLS 升级、
再手写 HTTP 请求并解析响应（含 `Content-Length`/`chunked`/`gzip` 与 ≤4 次跳转）。
代理只作用于本插件，应用其它流量走原来路径。

代理来源顺序（`proxy.js` 的 `resolveProxy`）：

1. 插件配置里的 `proxy`（形如 `http://127.0.0.1:7890`，需为 HTTP 代理）；
2. 环境变量 `DSH_WEB_SEARCH_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`；
3. macOS 系统代理（`scutil --proxy`）——即 Clash 等「设为系统代理」时写入的地址；
   仅在端口可连通时采用，结果缓存 60 秒。

所以：**梯子开着且设为系统代理时，无需任何配置**；梯子关掉时端口连不上，
自动退回直连，不会让搜索失败。也可以显式固定：

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    proxy: "http://127.0.0.1:7890"
```

TUN / 增强模式下由内核透明接管 TCP，这个模块不会介入，行为与直连一致。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `web` 行：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http
```

插件自身可选字段：`hosts`（允许的引擎 id 数组）、`timeoutMs`（单引擎超时，默认 15000）、
`wait`（`auto` | `all` | `fast`，默认 `auto`）、`proxy`（见上）。
`limit` 与 `softMs` 由调用方/引擎内部决定，正常不需要配。

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    wait: auto
    proxy: "http://127.0.0.1:7890"   # 省略则自动探测 macOS 系统代理
```

修改 `index.js`/`engines.js`/`proxy.js` 后必须**重启 DSH** 才会生效：
Node 的 ESM 模块在进程内只求值一次，运行中的宿主仍然跑着装入时的旧代码。

## 已知限制

- 相关性取决于上游结果页，整体不如商业搜索 API；免密钥抓取会被上游限流
  （实测 360 触发 `访问异常页面`、神马触发 `x5sec` 惩罚页），靠冷却与多引擎互补兜住。
- Google 抓不到：走隧道请求 `www.google.com/search` 只回 JS 空壳（94KB、1–3 个链接），
  无头 Chrome 则被重定向到 `google.com.hk` 并回 recaptcha 反爬页；`gbv=1`、consent
  cookie、移动端 UA 均无法绕过。公共 SearXNG 实例同样不可用（8 个全部 429/403/非 JSON）。
- 依赖上游 HTML 结构。上游改版会让解析失败——此时该引擎记一条失败原因并让位给下一个，
  `web_search` 报出「试过的引擎及各自失败原因」，而不是静默返回空列表。
- 结果里只有标题、链接、摘要，不含正文；正文交给 `web_fetch`。
- 不会解析 `publishedAt`：结果页日期格式不稳定，宁缺勿错。
- 代理只支持 HTTP 代理（`CONNECT`）；`socks5://` 需换成客户端的 HTTP/mixed 端口。

## 自测

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE -e "
import('file://$HOME/.dsh/plugins/dsh-web-search-bing/index.js').then(async (m) => {
  let p; m.apply({ web: { registerSearchProvider: (x) => { p = x } } }, {});
  console.log(p.id, p.available());
  const r = await p.search({ query: 'DeepSeek Harness 插件开发', maxResults: 3 });
  for (const s of r.sources) console.log('-', s.title, s.url);
});"
```
