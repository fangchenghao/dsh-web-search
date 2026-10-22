# dsh-web-search-bing

给 DeepSeek Harness 的 `web_search` 工具接一个**不需要任何 API key** 的搜索后端：
在本地请求公开搜索结果页（DuckDuckGo、Bing、360）和一个匿名 JSON API（AnySearch），
解析出标题、链接、摘要，再按 `ctx.web` 的 provider 契约返回。只需要普通出网能力。

- [English README](README.md)
- [架构](docs/architecture.md) · [引擎与解析细节](docs/engines.md) · [排障](docs/troubleshooting.md)
- [更新日志](CHANGELOG.md)

> **状态：0.7.0 未发布。** 实现已迁到 `src/*.ts`，由 `npm run build` 编译到 `lib/`
> （`package.json` 的 `main` 指向那里）。从仓库直接挂载前请先构建，见「安装」。

## 它解决什么

产品自带的搜索后端是 `@deepseek-ai/dsh-web-search-deepseek`（provider id
`deepseek-official`）。它的检索并不在本地发生，而是把一次 Messages 请求发到 DeepSeek 的
Anthropic 兼容接口，由**服务端**原生 `web_search` 工具（`web_search_20250305` →
`web_search_tool_result`）执行，再把结果块映射成来源列表。因此：

- 没有 DeepSeek 凭据时，`apiKey()` 直接抛 `WEB_PROVIDER_CREDENTIAL_MISSING`，
  `web_search` 结构性失败；
- 换成第三方中转地址也救不了——搜索语义在服务端工具里，不在接口形状里。实测 gpugeek 的
  `/v1/messages` 收下 `tools` 声明但从不执行（Claude-4.5-Sonnet 900 秒无响应；
  DeepSeek-V4.1-Flash 只回 thinking 块并自述 "I don't have web search tool"），
  只会把凭据错误换成
  `WEB_PROVIDER_ERROR: DeepSeek returned no web_search_tool_result blocks`。

本插件把检索搬回本地：自己请求公开结果页，解析出标题、链接、摘要，再按 `ctx.web` 的
provider 契约返回。`web_fetch` 不经过本插件，行为不变。

## 接口契约

`apply(ctx, config)` 内调用 `ctx.web.registerSearchProvider({ id, available, search })`：

- `id`：`bing`，由 `web.searchProvider` 选中；
- `available()`：同步，恒为 `true`；
- `search(request, signal)`：返回 `{ sources, truncated }`，`sources` 元素形如
  `{ url, title?, snippet?, publishedAt? }`——空字段直接省略，不写空串；按 URL 去重。
  所有引擎都失败时抛 `Error`，消息里带每个引擎的失败原因；空 query 会被拒绝，
  调用方取消也以错误形式抛出，而不是返回空列表。

## 安装

要求：带 `web` 服务的 DSH profile；Node 22.18+（源码依赖原生 TypeScript 类型擦除，
本仓库参考运行时为 Node 24）。不涉及任何密钥。

从仓库安装时先构建——`main` 指向 `lib/index.js`，构建前它并不存在：

```sh
npm run build
```

bundle 自带 patch（`cordis.patch.yml`）：

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
```

然后在 profile 的 `cordis.patch.yml` 里覆盖 `web` 行：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http
```

修改 `src/*.ts` 后必须**重新构建并重启 DSH** 才会生效：Node 的 ESM 模块在进程内只
求值一次，运行中的宿主仍然跑着装入时的旧代码。

## 引擎

每个引擎声明档位、主导的查询语言侧、权重和出网方式。`primary` 档全部并发发出；
`fallback` 档只在 primary 一条结果都没有时才运行。

| id | 档位 | 区域 | 权重 | 出网方式 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `anysearch` | primary | both | 2 | 直连优先，JSON `POST` | `api.anysearch.com/v1/search`，可匿名。精度最高，中英文都主导；融合时每轮占两个槽位；匿名每次至多 10 条 |
| `ddg-html` | primary | global | 1 | 必须走隧道 | `html.duckduckgo.com/html/`，英文原版文档最全 |
| `cn.bing` | primary | cn | 1 | 直连优先，失败再走隧道 | `cn.bing.com/search`，中文查询主力，结果 URL 为直链 |
| `so` | primary | cn | 1 | 直连优先，失败再走隧道 | 360 搜索（`www.so.com/s`），中文相关性好，真实 URL 在锚点 `data-mdurl` 里 |
| `www.bing` | fallback | global | 1 | 必须走隧道 | Bing 国际版（`setmkt=en-US`）。**降级为兜底**，原因见下 |
| `ddg-lite` | fallback | global | 1 | 必须走隧道 | `lite.duckduckgo.com/lite/`，`ddg-html` 的备用端点 |

除 `viaProxy` 之外的引擎都先直连（更快，也是站点期望的路径），直连失败才改走隧道。
三个 `viaProxy` 引擎只在有代理时参与，所以没挂代理时仍由 `anysearch`、`cn.bing`、`so`
承担检索。

## 合并顺序：按查询语言分区域

`region` 与查询语言同侧（或为 `both`）的引擎组成「主导区」，先填满 `limit`；只有主导区
不够时才用另一侧补齐。这样英文查询不会被按单个词匹配出的词典页占位：

- `how does tokio schedule tasks` 的国内结果是 "does" 的词典页；
- `how to set up postgres logical replication` 的 Bing 结果是拼图游戏站。

| 查询语言 | 主导区 | 实测效果 |
| --- | --- | --- |
| 纯 ASCII（英文） | global + both | 前 8 条 8/8 全是国外、且全在题上（Postgres 官方文档、`tokio.rs`、`corrode.dev`、K8s 官方文档） |
| 含中日文（CJK） | cn + both | 前 8 条以中文资源为主，含 AnySearch 的原版文档/译本 |

### 为什么中文查询也要等 AnySearch（A/B 实测）

同一查询跑两次：A 组只用国内引擎（`cn.bing` + 360），B 组加上 AnySearch。

| 查询 | A（只用国内引擎） | B（+AnySearch） |
| --- | --- | --- |
| `如何配置 postgres 逻辑复制` | 百度百科「如何（汉语词语）」、张悬《如何》歌词解析、知乎无关帖 ❌ | Cloud SQL 官方文档、cnblogs 配置教程、AWS 规范指导、Azure 文档、腾讯云、淘宝数据库月报 ✅ |
| `Python GIL 是什么` | python.org 首页、下载页、菜鸟教程 —— **没有一条讲 GIL** ❌ | 知乎《谈谈 python 的 GIL》、`cenalulu.github.io` GIL 详解、CSDN 什么是 GIL、JetBrains 中文博客、维基「全域直譯器鎖」✅ |
| `DeepSeek Harness 插件开发` | deepseek.com 首页、百度百科、App Store、GitHub 组织页 —— 全是首页噪声 ❌ | 知乎实战教程、`github.com/deepseek-ai/deepseek-harness`、官方 harness 页、dev.to 教程、bilibili 视频 ✅ |
| `Rust 所有权 借用检查` | rust-lang 首页、菜鸟教程、百度百科 | `colobu.com` Effective Rust 中文版、reddit 讨论、rustwiki 绕例学 Rust、`rust-book.junmajinlong.com` ✅ |

差别最大的正是**疑问句和含停用词**的中文查询：国内引擎会把「如何」「是什么」当检索词，
返回词典页和百科页。代价是中文查询从 0.2–0.7s 变成 1.4–2.3s。

## 等待策略（`wait`）

一档的结束条件是四者之一：所有引擎都返回、主导区所有引擎都已返回（无论成败）、
已凑够 `limit` 条且够「贡献者数」、或软截止到点。到点仍在跑的引擎会被中止，并在失败
列表里记为 `still running at deadline`（提前释放时记为 `aborted once enough results had arrived`）。

| `wait` | 行为 | 软截止 | 实测耗时 |
| --- | --- | --- | --- |
| `auto`（默认） | 英文等主导区（global）全部，中文等主导区（cn）全部 | 英文 6000ms / 中文 3500ms | 英文 2.6–3.8s / 中文 1.4–2.3s |
| `fast` | 1 家引擎有结果即返回 | 3500ms | 最快，跨引擎合并最少 |
| `all` | 等一档内**所有**引擎都返回 | 10000ms | 最全，但要等最慢的那家 |

英文查询多等两秒换来的是文档覆盖率翻倍（实测 16–30 条、12–21 个域名），值得；
中文查询多等一秒多换掉整页的词典页噪声，同样值得。

## 排序（RRF）

各引擎没有可比的分数，只有自己的顺序。权重不能直接乘到 RRF 分数上：`rrfConstant = 60`
时第 1 名与第 10 名的差距是 `1/61` 对 `1/70`，权重 2 会在每个名次上都压过其他引擎、独占
整个列表——实测就曾如此：CJK 查询下 AnySearch（权重 2）拿满 8 条，中文引擎一条都没有。

所以权重决定的是**入选名额**，不是分数。各引擎列表按加权轮转交错（权重 2 的引擎每轮取
连续两条，约占两倍槽位），这个交错顺序给每个候选一个 1 起始的 `position`，分数为：

```
score(source) = votes / (rrfConstant + position)
```

`votes` 是返回该结果的**不同引擎数**：跨引擎一致会叠加，单个引擎的权重不会；`rrfConstant`
（默认 60）越大曲线越平。实测权重 2/1/1、三个列表分别 10/10/4 条、`limit: 8` 时，名额是
4/2/2；旧的「权重乘分数」规则会得到 8/0/0。分数之上再乘两个修正：

- **权威度**：命中官方文档域名时乘 `1 + authorityBoost`（默认 0.25）。内置列表覆盖
  PostgreSQL、Kubernetes、Rust、SQLite、Python、Node.js、MDN、AWS、Microsoft Learn、
  Google Cloud、W3C、RFC Editor、man7、Docker、Git、MySQL、Redis、nginx；可用
  `authorityDomains` 追加。
- **新鲜度**：发布时间在 `freshnessDays`（默认 30）内时乘
  `1 + freshnessBoost × (1 − ageDays / freshnessDays)`（默认 0.2）；日期解析失败则忽略，
  不惩罚。

平局时依次比较引擎顺序、该引擎内排名、URL 字符串，结果确定。区域策略在融合之前生效，
所以非主导区永远不会打乱主导区已经排好的头部。

> 目前没有任何引擎写 `publishedAt`：结果页没有稳定日期字段，所以来源不带日期，
> 新鲜度加成要等某个引擎提供日期后才会实际生效。

## 缓存

成功且非空的结果按「逻辑请求」缓存。键为
`lead|wait|limit|排序后的引擎 id|归一化 query`：query 去首尾空白、转小写、压缩内部空白，
引擎顺序无关。引擎 id 取冷却过滤**之前**、本次运行会用的集合，所以某引擎进入或离开冷却
都不会让刚写入的条目失效。条目在 `cacheTtlMs`（默认 10 分钟）后过期，超过 `cacheEntries`（默认 100）
时淘汰最久未使用的一条；`cacheTtlMs: 0` 关闭缓存。存入和取出的数组都是副本，调用方改不动
缓存。命中时不再发任何请求，因此失败列表里只有命中前已收集到的冷却提示。

## 被拦引擎的冷却

抓公开结果页不是官方接口，请求密集时对方会回验证页。失败会按业务码分类，冷却规则如下：

- `SEARCH_THROTTLED`（HTTP 429）、`SEARCH_BLOCKED`（HTTP 403 或回显校验不通过）、
  `SEARCH_TIMEOUT`、`SEARCH_NETWORK` 会让引擎进入冷却；
- `SEARCH_PARSE`（上游改版，重试无用）和 `SEARCH_ABORTED`（调用方取消）**不冷却**。

冷却时长优先用对方自己的 `Retry-After`（秒数或 HTTP 日期，取自最后一次跳转的响应头），
没有则用 `baseCooldownMs` 按连续失败次数翻倍，上限 `maxCooldownMs`——默认 5 分钟到
30 分钟。成功一次即清零连续失败计数。冷却不会让引擎集合变空：全都在冷却时仍会照常尝试。
被跳过的引擎在失败列表里显示为 `cooling down for another 2m 10s after SEARCH_THROTTLED`。

### 反「限流页」校验

搜索引擎对短时间内的连续无人值守请求可能不回结果页，而回一个「热门推荐」页——里面的条目
属于别人的查询。实测中这些条目曾被当成用户查询的结果。每页都会回显查询词（搜索框里），
所以抓取型引擎在解析前都要求页面里出现查询词的任一 ≥3 字符片段；不出现的页面记为失败
（`SEARCH_BLOCKED`），让位给下一个引擎。JSON API 用自己的信封校验，不做回显检查。

## 在受限网络里抓取页面

`web_search` 和 `web_fetch` 是两件事：搜索负责"发现 URL"，抓取负责"读取页面"。本插件两边都提供，
因为受限网络里坏掉的是后半段。本机实测：

| 站点 | 直连 | 经本地隧道 |
| --- | --- | --- |
| `github.com` | 超时 | 200，3.5 秒 |
| `html.duckduckgo.com` | 超时 | 202，1.2 秒 |
| `api.anysearch.com` | 200（2.1 秒） | 200（1.0 秒） |
| `cn.bing.com`、`www.so.com` | 200 | 200 |

也就是说，搜到一条 GitHub 链接曾经是死路：看得见、读不到。把 `web` 服务指向本 provider 后按三级
落梯处理——直连优先，其次隧道，配置了 AnySearch 密钥时最后再用它的提取接口：

```yaml
- id: web
  config:
    searchProvider: bing
    fetchProvider: http-proxy
```

## 配置

loader 会在 `apply` 之前用 schemastery schema 校验配置段：非法值会在加载时报出具体
路径（例如 `$.timeoutMs expected number >= 500 but got 10`），而不是静默回落到默认值。
未知键不会被拒绝，键名请严格照下表拼写。

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `hosts` | `string[]` | `[]`（全部） | 只允许这些引擎 id 参与 |
| `timeoutMs` | 整数 ≥ 500 | `15000` | 单引擎请求超时 |
| `wait` | `auto` / `all` / `fast` | `auto` | 一档等多久 |
| `proxy` | string | `''`（自动探测） | 显式隧道地址，如 `http://127.0.0.1:7890` |
| `limit` | 整数 1–20 | `8` | 返回条数上限；调用方 `maxResults` 更小时以它为准 |
| `rrfConstant` | 整数 ≥ 1 | `60` | RRF 常数，越大排名曲线越平 |
| `authorityDomains` | `string[]` | `[]` | 在内置列表之外追加的权威域名 |
| `authorityBoost` | 数值 0–10 | `0.25` | 权威域名加成：`× (1 + boost)` |
| `freshnessBoost` | 数值 0–10 | `0.2` | 当天发布结果的加成，随时间线性衰减到 0 |
| `freshnessDays` | 整数 ≥ 1 | `30` | 新鲜度加成衰减到 0 的天数 |
| `anysearchApiKey` | 字符串 | `''` | 发给 `api.anysearch.com` 的 Bearer 令牌；空值表示匿名访问 |
| `anysearchDomain` | 字符串 | `''` | AnySearch 垂直索引（`finance`、`academic`、`security`、`legal`、`code`）；带点号的值选择子域 |
| `cacheTtlMs` | 整数 ≥ 0 | `600000` | 缓存有效期；`0` 关闭缓存 |
| `cacheEntries` | 整数 ≥ 0 | `100` | 缓存条目上限，超出淘汰最久未用 |
| `baseCooldownMs` | 整数 ≥ 0 | `300000` | 无等待提示时的基础冷却 |
| `maxCooldownMs` | 整数 ≥ 0 | `1800000` | 指数冷却上限 |

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    wait: auto
    limit: 8
    proxy: "http://127.0.0.1:7890"   # 省略则自动探测
    anysearchApiKey: ''       # 放在 profile，别放进仓库
    anysearchDomain: ''       # 或 finance / academic / security / legal / code
    cacheTtlMs: 600000
```

## 代理

Node 的全局 `fetch` 不读 macOS 系统代理，也不读 `HTTPS_PROXY`：undici 只在进程以
`NODE_USE_ENV_PROXY=1`（或 `--use-env-proxy`）启动时才认代理环境变量，而这个开关在进程
启动后无法再打开（实测进程内设置变量后仍然 `ECONNRESET`），`undici.ProxyAgent` 也不可达
（Node 不把 `undici` 暴露为模块）。所以需要代理时本插件自己连代理：发 `CONNECT`、对
`https:` 目标做 TLS 升级、再手写 HTTP 请求并解析响应（含 `Content-Length`/chunked/gzip/
deflate/brotli 与 ≤4 次跳转）。`307`/`308` 保留方法与请求体，其他 `3xx` 把 `POST` 降级为
无 body 的 `GET`。代理只作用于本插件，应用其它流量走原来路径。

代理来源顺序：

1. 插件配置里的 `proxy`（形如 `http://127.0.0.1:7890`，需为 HTTP 代理）；
2. 环境变量 `DSH_WEB_SEARCH_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`（大小写皆可）；
3. macOS 系统代理（`scutil --proxy`）——即 Clash 等「设为系统代理」时写入的地址；
   仅在端口可连通（400ms TCP 探测）时采用，结果缓存 60 秒。

所以：**梯子开着且设为系统代理时，无需任何配置**；梯子关掉时端口连不上，自动退回直连，
不会让搜索失败。TUN / 增强模式下由内核透明接管 TCP，这个模块不会介入，行为与直连一致。
只支持 HTTP 代理（`CONNECT`）；`socks5://` 需换成客户端的 HTTP/mixed 端口。
探测不到代理时见[排障](docs/troubleshooting.md)。

## 开发

```sh
node --test test/*.test.ts     # 全部测试
node --test test/proxy.test.ts # 单个文件
npm run typecheck              # 对 src/**/*.ts 做 tsc --noEmit
npm run build                  # 编译 src/ 到 lib/
npm run check                  # typecheck + 测试
```

测试全程离线：解析器测试回放 `test/fixtures/` 里抓下来的真实响应，传输测试不开 socket，
代理测试只验 `parseProxy`、`proxyFromEnv` 和纯函数式的响应分帧。

CI（`.github/workflows/ci.yml`）在 Node 24 的 Ubuntu 与 macOS 上跑同样的步骤：
`npm ci`、`npm run typecheck`、`npm test`、`npm run build`，并检查构建确实产出了
`lib/index.js` 入口。

### 自测（注册是否成功）

```sh
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE -e "
import('file://$HOME/.dsh/plugins/dsh-web-search-bing/lib/index.js').then((m) => {
  let p; m.apply({ web: { registerSearchProvider: (x) => { p = x } } }, m.Config({}));
  console.log(p.id, p.available());
});"
```

## 已知限制

- 相关性取决于上游结果页，整体不如商业搜索 API；免密钥抓取会被上游限流（实测 360 回
  `访问异常页面` + captcha，另一家国内引擎回 `x5sec` 惩罚页），靠冷却与多引擎互补兜住。
- **Google 在本网络下不可达**：走隧道请求 `www.google.com/search` 只回 JS 空壳
  （94KB、1–3 个链接），无头 Chrome 则被重定向到 `google.com.hk` 并回 reCAPTCHA 反爬页；
  `gbv=1`、consent cookie、移动端 UA 均无法绕过。公共 SearXNG 实例同样不可用
  （8 个全部 429/403/非 JSON）。
- 依赖上游 HTML 结构。上游改版会让解析失败——此时该引擎记一条失败原因并让位给下一个，
  `web_search` 报出「试过的引擎及各自失败原因」，而不是静默返回空列表。
- 结果里只有标题、链接、摘要，不含正文；正文交给 `web_fetch`。
- 目前不产出 `publishedAt`（见「排序」）。
- AnySearch 匿名调用每次至多 10 条。
- 代理只支持 HTTP 代理（`CONNECT`）。
- `limit` 上限 20。

## 文档

- [docs/architecture.md](docs/architecture.md)：模块划分与从 `web` 缝到来源列表的数据流
- [docs/engines.md](docs/engines.md)：各引擎的请求形状、解析怪癖与实测结论
- [docs/troubleshooting.md](docs/troubleshooting.md)：没有结果、代理没探测到、provider 没被选中、冷却卡住
- [README.md](README.md)：英文说明

## 许可

MIT © 2026 fangchenghao，见 [LICENSE](LICENSE)。

## 文档

- [让配置出现在「设置」里：四层判定链](docs/plugin-settings-form.md) —— 写给插件作者，也写给下次调试这个问题的自己。
