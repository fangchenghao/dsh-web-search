# dsh-web-search-bing

**给 DeepSeek Harness 加一双「自己上网」的手：模型不用你贴链接，就能先搜索、再打开网页读正文。**

- [English README](README.md)
- [更新日志](CHANGELOG.md) · [设置页为什么不显示：四层判定链](docs/plugin-settings-form.md)

> 当前版本 0.9.1。下面先讲「它跟我有什么关系」，技术细节放在后面的附录。

## 一句话说明

装好这个插件，你在对话里问「上周发布的那版怎么配置」，模型可以自己调用 `web_search` 去公开搜索引擎查，拿回排好序的标题、链接和摘要；摘要不够用时，它还能调用 `web_fetch` 打开其中一条链接，把网页正文读进对话。

对你的实际影响就两条：

- 问题里带「搜一下」「最新」「官网」「文档」时，模型真的有机会去查，而不是回你一句「我的知识截止到某年」。
- 你不需要准备搜索 API key，也不需要为搜索单独付费。

说白了就一句话：它给 Harness 的 `web` 服务插上两个「提供方」——搜索用 `bing`，抓网页用 `http-proxy`。这两个名字后面会反复出现，先混个脸熟就行。

## 它解决什么问题

### 一个很常见的场景

你刚把一个库升到新版本，配置文件里某个字段改了名。你问模型：

> 「v1.2 之后 `timeout` 是不是改成 `timeoutMs` 了？帮我确认下官方文档。」

**没有这个插件时**，模型只有三种反应：

1. 凭训练时记住的旧文档回答，可能对，也可能一本正经地错；
2. 说「我无法访问互联网，建议你查官方文档」；
3. 直接报错——如果用的是 Harness 自带的搜索后端（`deepseek-official`），它需要 DeepSeek 的凭据才能工作，没有凭据时 `web_search` 会直接失败。

**有了这个插件之后**：

1. 模型调用 `web_search`，插件同时问几家搜索引擎，把重复的网址去掉，按「是不是多家都排得靠前、是不是官方文档、是否够新」重新排序，返回 8 条左右的候选；
2. 模型看到某条是 `kubernetes.io` 的文档，调用 `web_fetch` 把这一页的正文读回来；
3. 它拿着正文回答你，还能顺手把链接给你。

### 前后对比

| 场景 | 没有它 | 有它 |
| --- | --- | --- |
| 问最近几周才发布的东西 | 只能靠记忆，容易过时 | 现搜现读，能给出处 |
| 你扔给它一条链接说「读一下」 | 直连超时（如 `github.com`）就失败 | 先直连，再走本地代理，还能用 AnySearch 抽取正文 |
| 搜索结果来源 | 单一后端，取决于凭据 | 最多六个来源交叉验证，去重后排序 |
| 中文提问 | 容易返回词典页、百科页 | 中文问题优先用中文来源，英文文档也不会被挤掉 |
| 被搜索引擎限流 | 每次都失败，每次都重试 | 让这家先歇 5–30 分钟，其余照常工作 |

### 它不解决什么

它不会让模型变聪明，也不会替你做判断。它只是把「查」和「读」这两件事接上了。搜到的内容仍然可能不准、可能过期，模型仍可能理解错——这一点和你自己用搜索引擎没有本质区别。

## 概念科普

这一节解释后面会用到的词。每个词三五句话，配一个类比，不需要任何技术背景。

### 大模型，以及它为什么会「不知道」

大模型（就是 ChatGPT、DeepSeek 背后那类 AI）是把海量文字读完之后，学会「下一个词最可能是什么」的程序。它记住的是训练那一刻之前的内容，这个时间点叫**知识截止**（knowledge cutoff）。

它本身不联网。你问它昨天发生的事，它不是「查了没查到」，而是**根本没有这个信息的入口**。类比：一位读遍图书馆、但三年前就搬进山里不再收快递的学者——问他三年前的事很靠谱，问他上周的新闻，他只能凭推理猜。

### Agent（智能体），以及它为什么需要「工具」

Agent 就是「会自己决定下一步做什么」的 AI。普通聊天是问一句答一句；Agent 会先想「我该不该查一下」，再决定调用哪个工具，看到结果后继续想下一步。

**工具**（tool）是给 Agent 用的固定功能，比如「搜索」「读取网页」「执行命令」。模型不能自己上网，但它可以请求 Harness：「帮我跑一下 `web_search`，参数是这些」。Harness 跑完，把结果塞回对话，模型再继续。类比：你不是让厨师亲自去菜市场，而是给他一个电话，让他打给采购。

### web_search 和 web_fetch 的区别

这是最容易混的一对。它们解决的是两个不同的问题：

- **`web_search`：找网址。** 你给关键词，它给一张清单，每条有标题、链接、一两句摘要。
- **`web_fetch`：读正文。** 你给一个具体网址，它把那一页的内容抓回来。

| | `web_search` | `web_fetch` |
| --- | --- | --- |
| 你给它什么 | 一句话关键词 | 一个具体网址（`http://` 或 `https://`） |
| 它给你什么 | 8 条左右的候选：标题 + 链接 + 摘要 | 那一页的正文（HTML 或纯文本） |
| 能不能直接回答你 | 只能看摘要，常常不够 | 能，正文就在里面 |
| 什么时候用 | 不知道去哪找、要比较多个来源 | 已经知道该读哪一页 |
| 走哪个提供方 | `bing`（本插件） | `http-proxy`（本插件） |
| 典型耗时 | 1.4–3.8 秒（有缓存时几乎瞬间） | 取决于站点，直连最多等 5 秒再换路子 |

生活化的说法：

> **search 像图书管理员给你一张书单**：书名、书架号、一句话简介，三十秒就能拿到。但书单不是书，简介也可能写得不准。
>
> **fetch 像你按书架号把书借回来、翻到正文**：内容全了，但可能被人借走（网站拒绝访问）、可能是一本需要会员才能看的书（付费墙），也可能目录写错了（链接 404）。

所以两个要配合：先 search 拿到书单，再 fetch 挑中的那本。只 search 不 fetch，模型看到的永远是简介；只 fetch 不 search，模型得先知道网址——而它往往不知道。

### DeepSeek message 和会话（session）

模型本身没有记忆。每次请求，Harness 都会把**整串消息**重新发给它：系统提示、你之前说的话、模型之前的回答，以及工具的结果。这一串就叫 messages；一次连续的对话存在一个 session（会话）里。

一次工具调用的往返长这样：

1. 模型说「我要调 `web_search`，query 是 xxx」——这是一条 assistant 消息，里面带 tool call；
2. Harness 真的去搜，把结果作为一条 **tool result 消息**追加到消息列表；
3. 下一次请求，模型看到的是「用户问题 + 自己的工具请求 + 搜索结果」这一整串，于是接着回答。

类比：点菜。你点单，服务员把单子递进厨房，做好的菜作为新的一盘端回桌上。模型每次看到的都是「桌上现有的所有盘子」，而不是只看到最后端上来的那盘。这也解释了一个常见现象：搜索结果太长会占地方——它占的是模型的上下文，也就是桌子的面积。

### provider（提供方）

Harness 里有个叫 `web` 的**服务**，它自己不会搜索，只负责「把请求转给某个提供方」。提供方（provider）就是真正干活的那个实现。

类比：墙上的插座是 `web` 服务，插件是插头。你换插头，墙不用动，电器也不用换。这个插件插了两个插头：

- 搜索插头，id 叫 `bing`，由配置里的 `searchProvider: bing` 选中；
- 抓网页插头，id 叫 `http-proxy`，由 `fetchProvider: http-proxy` 选中。

换掉它能改变什么？比如换回官方的 `deepseek-official`，`web_search` 就又需要 DeepSeek 凭据；换成别的抓取实现，`web_fetch` 的超时和代理策略就跟着变。工具名不变，工具背后的手艺变了。

### 插件和插件包（bundle）

插件是一段装进 Harness 的代码。插件包（bundle）是它的打包形式：一个 npm 包，里面除了代码，还带一份 `cordis.patch.yml`，告诉 Harness「启动时把我这行配置插进去」。

装在哪里？装在你当前 **profile** 的依赖里。profile 可以理解成「一套独立的 Harness 配置」——本机就有 `desktop`、`web`、`headless` 几套。插件代码、以及你在 profile 的 `cordis.patch.yml` 里写的配置，共同决定它怎么跑。

为什么改代码要重启？因为 Node.js 的模块在一个进程里只加载一次，正在运行的 Harness 手里是启动那一刻的旧代码。类比：换灯泡得先关灯再开，热插拔不会亮。**在设置页保存不用重启**（例外情况和缓存的影响见「设置页怎么用」），但改 `src/*.ts` 一定得重新构建并重启。

### 顺手解释几个会碰到的词

- **引擎（engine）**：一个具体的搜索来源，比如 Bing 中国站、360、DuckDuckGo。它返回的是一张网页，不是一个标准接口。
- **抓取与解析（scrape / parse）**：把网页下载下来，再从 HTML 里把标题、链接、摘要抠出来。上游一改版，抠法就可能失效。
- **代理 / 隧道（proxy / tunnel）**：让请求先经过一个本地程序（比如 Clash）再出网。有些站点直连不通，走它才通。
- **缓存（cache）**：把刚搜过的结果记十分钟。同一个问题再问一次，直接拿记录，不再打扰搜索引擎。
- **限流与冷却（rate limit / cooldown）**：搜索引擎不喜欢短时间大量自动请求，会回一个验证页。插件会让这家「歇一会儿」，默认 5 分钟起，最多 30 分钟。
- **RRF 排序**：一种把多家搜索结果的排名「投票合并」的算法。某条结果在几家都排前面，就往上提；只有一家说好，说服力就弱一些。
- **API key**：访问某个服务要出示的通行证。这个插件默认不需要；AnySearch 的 key 是可选的，填了额度更高。

## 能力清单

每条都是「人话 + 技术补充」。技术补充可以跳过，不影响使用。

1. **同时问好几家搜索引擎。**
   主力四家一起查（AnySearch、DuckDuckGo HTML、Bing 中国站、360）；如果四家一条都没给，再让 Bing 国际站和 DuckDuckGo Lite 兜底。一共六个来源。
   *技术补充：`HOSTS` 里 `tier: primary` / `fallback` 两档；`viaProxy` 的三家（`ddg-html`、`www.bing`、`ddg-lite`）只在检测到代理时参与。*

2. **完全不需要 API key。**
   AnySearch 匿名就能用，国内引擎和 DuckDuckGo 都是抓公开结果页，不需要注册。
   *技术补充：AnySearch 走 `POST https://api.anysearch.com/v1/search`，`max_results` 固定 10；抓取型引擎会校验页面里有没有回显查询词，防止把「热门推荐」当成你的结果。*

3. **重复的网址只留一条。**
   同一个页面被三家返回，也只出现一次，并且位置会更靠前。
   *技术补充：按 URL 去重，忽略 `www.` 和末尾斜杠；RRF 里 `votes` 统计「多少个不同引擎返回过它」。*

4. **排序不只看排名，还看「是不是官方」和「够不够新」。**
   `kubernetes.io`、`developer.mozilla.org`、`rfc-editor.org` 这类域名会被加权；30 天内发布的内容也会被加权。
   *技术补充：`score = votes / (rrfConstant + position)`，再乘 `1 + authorityBoost` 和新鲜度系数；默认 `rrfConstant: 60`、`authorityBoost: 0.25`、`freshnessBoost: 0.2`、`freshnessDays: 30`。*

5. **中英文分开处理。**
   英文问题先看国外来源，中文问题先看中文来源，避免「how to …」被某个中文引擎按单词 `how` 匹配成词典页。
   *技术补充：查询含 CJK 字符时 `lead = cn`，纯 ASCII 时 `lead = global`；非主导区只在主导区凑不够条数时才追加。*

6. **快慢可以选。**
   默认 `auto`：英文最多等 6 秒、中文最多等 3.5 秒；`fast` 谁先回就用谁；`all` 等所有引擎，最多 10 秒。
   *技术补充：`wait` 三值，软截止分别是 `auto` 6000/3500 ms、`fast` 3500 ms、`all` 10000 ms；单引擎硬超时默认 `timeoutMs: 15000`。*

7. **同一个问题不重复打扰搜索引擎。**
   十分钟内问同一个问题，直接用上次的结果，几乎瞬间返回。
   *技术补充：TTL + LRU 缓存，`cacheTtlMs: 600000`（10 分钟）、`cacheEntries: 100`；键是 `lead|wait|limit|排序后的引擎 id|归一化 query`。*

8. **被限流会自己歇一会儿。**
   某家回了验证页，就先不用它，过几分钟再试，其他家照常。
   *技术补充：`baseCooldownMs: 300000` 起，按连续失败次数翻倍，上限 `maxCooldownMs: 1800000`；对方给了 `Retry-After` 就听对方的；解析失败和主动取消不冷却。*

9. **能把网页正文读回来。**
   搜索给链接，`web_fetch` 给正文；直连不通时自动换路。
   *技术补充：三级梯队——直连（最多 5 秒）→ 本地隧道 → AnySearch 抽取（需要 key）；单页最多保留 1 MiB（`1048576` 字节），超出部分截断并标记。*

10. **受限网络下也能用。**
    梯子开着并且设为系统代理时，不用配置任何东西；关掉梯子会自动退回直连，不会因此报错。
    *技术补充：代理来源依次是配置里的 `proxy`、环境变量 `DSH_WEB_SEARCH_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`、macOS 的 `scutil --proxy`；只支持 HTTP 代理（`CONNECT`），不支持 `socks5://`。*

11. **所有设置都能在界面上改，不用编辑文件。**
    设置页有 16 个控件，分三组；保存后下一次搜索就生效。
    *技术补充：16 个字段全部标了 `.volatile()`，Host 以 live commit 方式原地更新，不重挂载插件。*

12. **失败会解释原因，不会静默返回空。**
    一家都没成功时，报错里会列出「试过哪些引擎、各自为什么失败」。
    *技术补充：失败按 `SEARCH_THROTTLED` / `SEARCH_BLOCKED` / `SEARCH_TIMEOUT` / `SEARCH_NETWORK` / `SEARCH_PARSE` / `SEARCH_ABORTED` 分类；失败是返回值，不是异常，只有调用方取消才抛出。*

## 安装与启用

### 你需要什么

- 一个带 `web` 服务的 DeepSeek Harness profile；
- Node 22.18 以上（源码用了 Node 原生的 TypeScript 类型擦除；本仓库的 CI 跑的是 Node 24）；
- 能正常出网。没有梯子也能用，只是可用的引擎少一两个。

### 第一步：构建

仓库里的 `main` 指向 `lib/index.js`，构建之前它并不存在：

```sh
cd ~/.dsh/plugins/dsh-web-search-bing
npm run build
```

### 第二步：确认 bundle 的 patch

插件包自带 `cordis.patch.yml`，内容是一行插入：

```yaml
- insert:
    - id: web-search-bing
      name: dsh-web-search-bing
```

如果你是通过 `pnpm install` / `link:` 装进 profile 的，这一行会自动生效，不用手抄。仓库里这份 patch 还带了一个空的 `config: {}`，作用是让设置页能发现这一行、显示卡片而不是「当前部署尚未提供此插件的设置」。

还没装进 profile 的话，在该 profile 的 `package.json` 里加一条依赖，再安装：

```json
"dependencies": {
  "dsh-web-search-bing": "link:/Users/dp/.dsh/plugins/dsh-web-search-bing"
}
```

```sh
cd ~/.dsh/profiles/desktop
pnpm install
```

路径换成你本机的仓库位置；本机的 profile 用 pnpm 管理依赖，换用别的包管理器时照你自己的习惯来。

### 第三步：在 profile 里选中提供方

打开你正在用的 profile 的 `cordis.patch.yml`。本机是：

```
~/.dsh/profiles/desktop/cordis.patch.yml
```

别的机器上把 `desktop` 换成你实际用的 profile 名（`web`、`headless` 等）。加上这一段：

```yaml
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: bing
    fetchProvider: http-proxy
```

`bing` 和 `http-proxy` 都是本插件注册的 id。如果你只想换搜索、不想让抓网页也走插件，把 `fetchProvider` 写成 `http`（Harness 自带的直连实现）。

再往下可以加一段可选配置，比如：

```yaml
- id: web-search-bing
  name: dsh-web-search-bing
  config:
    limit: 8
    wait: auto
    proxy: ""            # 留空自动探测
    anysearchApiKey: ""  # 留空表示匿名访问
    anysearchDomain: ""  # 或 finance / academic / security / legal / code
```

**密钥放哪**：放在 profile 的 `cordis.patch.yml` 里，不要放进仓库。仓库里 bundle 的默认配置是空的，这样发布出去不会带上你的凭据。

### 第四步：完全重启

改完代码或 profile 配置后，**完全退出 DSH 再打开**（macOS 上不是只关窗口，要从菜单退出，或按 `Cmd+Q`）。原因是模块在每个进程里只求值一次，热改文件不会被已运行的进程看见。

只改设置页里的值不需要重启，见下一节。

### 第五步：确认生效

三个办法，任选：

1. **看设置页**：设置 → 「网页搜索（Bing）」，能看到三组控件，说明插件被加载了，schema 也被 Host 收录了。
2. **看日志**：启动日志里没有 `1 entry did not activate` 这类警告。
3. **直接试**：问一个明显需要联网的问题，比如「帮我搜一下 DSH 插件开发教程，给我链接」。看模型有没有调用 `web_search`，返回的链接是不是真实可达。

如果设置页有卡片但搜索还是失败，先看排障文档：[docs/troubleshooting.md](docs/troubleshooting.md)。

## 设置页怎么用

打开 设置 → 「网页搜索（Bing）」。页面上一共 16 个控件，按三组排列。每组只管一类事：

| 组 | 控件数 | 这组管什么 |
| --- | --- | --- |
| 引擎与传输 | 6 | 用哪些搜索引擎、等多久、走不走代理、AnySearch 的凭据和垂直域 |
| 结果与排序 | 6 | 返回几条、怎么合并排序、官方文档和新内容加权多少 |
| 缓存与冷却 | 4 | 结果记多久、记多少条、被限流后歇多久 |

### 引擎与传输（6 个）

| 控件 | 配置键 | 默认 | 人话 |
| --- | --- | --- | --- |
| 引擎白名单 | `hosts` | 空（全部） | 只让列出的引擎参与，逗号分隔，如 `anysearch, cn.bing` |
| 等待策略 | `wait` | `auto` | `auto` 按提问语言等；`all` 等全部；`fast` 谁先回用谁 |
| 超时（毫秒） | `timeoutMs` | `15000` | 单个引擎最多等多久，最小 500 |
| 代理地址 | `proxy` | 空（自动探测） | 如 `http://127.0.0.1:7890`；留空先读环境变量再读系统代理 |
| AnySearch 密钥 | `anysearchApiKey` | 空（匿名） | 可选项。只发给 `api.anysearch.com`，用于提高额度、解锁正文抽取 |
| AnySearch 垂直域 | `anysearchDomain` | 空（通用） | `finance` / `academic` / `security` / `legal` / `code`，可带子域如 `finance.us_stock` |

> 如果最后两项的标题显示成 `field.anysearchApiKey` 这样的原始键名，是这一版漏了两行翻译，功能不受影响。

### 结果与排序（6 个）

| 控件 | 配置键 | 默认 | 人话 |
| --- | --- | --- | --- |
| 结果上限 | `limit` | `8` | 最多返回几条，1–20；调用方要得更少时以调用方为准 |
| RRF 常数 | `rrfConstant` | `60` | 越大越平均，越小越偏向各引擎的头部结果 |
| 权威域名 | `authorityDomains` | 空（用内置列表） | 在内置的官方文档域名之外，追加你想加权的域名 |
| 权威加权 | `authorityBoost` | `0.25` | 命中权威域名时乘 `1 + 这个值`，0–10 |
| 新鲜度加权 | `freshnessBoost` | `0.2` | 新发布内容的加成，0–10；随时间线性衰减到 0 |
| 新鲜度窗口（天） | `freshnessDays` | `30` | 超过这个天数就不再加成 |

### 缓存与冷却（4 个）

| 控件 | 配置键 | 默认 | 人话 |
| --- | --- | --- | --- |
| 缓存有效期（毫秒） | `cacheTtlMs` | `600000` | 10 分钟；填 `0` 关闭缓存 |
| 缓存条目上限 | `cacheEntries` | `100` | 最多记多少个问题，超出淘汰最久没用的 |
| 基础冷却（毫秒） | `baseCooldownMs` | `300000` | 被限流后第一次歇多久，5 分钟 |
| 最大冷却（毫秒） | `maxCooldownMs` | `1800000` | 连续失败时冷却翻倍的上限，30 分钟 |

### 给你的建议

**只想正常用：16 个控件全都别改，默认值就是调过的。**

只有两种情况值得动：

- **代理没被自动探测到**：在 `proxy` 里填上你的本地代理地址，比如 `http://127.0.0.1:7890`。只支持 HTTP 代理，`socks5://` 要换成客户端的 HTTP/mixed 端口。
- **你想要 AnySearch 的更高额度或正文抽取**：填 `anysearchApiKey`；想只搜某个垂直领域再填 `anysearchDomain`。

两个提醒：

- 保存是即时的，下一次搜索就按新值走，不用重启。
- 但**排序类的改动可能被缓存挡住**：缓存键里只有 `lead|wait|limit|引擎集合|query`，没有排序参数。同一个问题十分钟内再问，拿到的还是旧顺序。换个问法，或者等十分钟。

## 常见问题 FAQ

### 需要 API key 吗？

不需要。搜索默认全部走公开渠道：AnySearch 匿名访问、Bing 和 360 抓结果页、DuckDuckGo 抓 HTML 页。`anysearchApiKey` 是可选的，填了额度更高，也能在 `web_fetch` 直连和隧道都失败时启用第三级「服务端抽取」。

### 会不会花我的钱？

插件本身是 MIT 开源、免费的，不调用任何付费搜索 API，也不含购买入口。有两件事和钱有关，但都不是插件收的：

- 你自己填的 AnySearch key，用量和计费按 AnySearch 的规则算在你账号上；
- 搜索产生的网络流量算你自己的。

### 会不会把我的搜索内容发给别人？

会发给本次参与的搜索引擎——这是搜索本身的意思。具体是 `api.anysearch.com`、`cn.bing.com`、`www.so.com`，有代理时还包括 DuckDuckGo 和 Bing 国际站；配了 key 时，抓取失败的页面可能被发给 `api.anysearch.com` 的抽取接口。插件没有自己的服务器，代码里也没有上报使用情况的逻辑。

### 为什么某个网站抓不到？

常见原因有四类：

1. **站点拒绝自动访问**：回 403 或验证页。直连、隧道都过不去时，只有配了 AnySearch key 才会尝试服务端抽取。
2. **正文靠 JavaScript 渲染**：抓回来的是空壳 HTML，看不到内容。
3. **要登录或付费**：抓取没有你的登录态。
4. **直连超时**：会先在 5 秒内试直连，失败转隧道；两个都不通、又没配 key 时报错，配了 key 还会再试服务端抽取。报错里会写清楚每一级失败的原因。

### 为什么搜索结果和我手动搜的不一样？

因为这不是同一件事：

- 它抓的是**多个引擎的结果页**，不是某个引擎的官方接口，各家的排序本来就不一样；
- 它按 URL 去重，再按跨引擎投票、官方文档、新鲜度重新排序；
- 它优先用和提问语言同侧的来源，中文问题会先看中文站点；
- 它可能用到十分钟前的缓存，也可能某家正在冷却没参与；
- 它没有你的账号、位置、浏览历史，不会个性化。

### 改了设置为什么没生效？

分三种情况：

- **在设置页改的**：保存即生效，但下一次搜索才读新值。如果问的是同一个问题、十分钟内又问了一遍，可能命中了缓存，看起来像没变——换个问法试试。
- **改的是 profile 里的 `cordis.patch.yml`**：需要完全重启 Harness。
- **改的是 `src/*.ts`**：需要 `npm run build` 再重启。只改源码不构建，跑的还是 `lib/` 里的旧代码。

### 会不会拖慢模型？

会多一点等待，但通常值得：

- 一次搜索实测 1.4–3.8 秒（英文多等一会儿，中文快一些）；命中缓存时几乎瞬间。
- 这段时间模型在等工具结果，不是卡死；等不到会按软截止返回已经拿到的部分。
- 真正的成本在上下文：搜索结果和网页正文都会占用模型的输入长度，读的页面越长，这一轮越贵、越容易挤掉别的内容。所以它默认只返回 8 条，单页最多保留 1 MiB。

### 为什么模型有时候还是不搜？

搜不搜是模型自己决定的，插件只负责「被调用时把活干好」。它可能觉得自己知道答案，可能觉得问题不需要联网，也可能上一轮已经拿到了足够信息。你可以直接说「先搜一下再回答」，通常就会触发。

## 技术说明（附录）

这一节给要改代码或排查问题的人。日常使用可以跳过。

### 一次搜索的管道

```
web_search 调用
  → 读配置（每次调用重读，所以设置页改动立即生效）
  → 解析代理（配置 → 环境变量 → 系统代理）
  → 按 hosts 白名单过滤；没有代理时丢掉 viaProxy 引擎
  → 跳过正在冷却的引擎（但绝不会一个都不剩）
  → 按查询语言决定主导区（ASCII → global，CJK → cn）
  → 查缓存（键：lead|wait|limit|排序后的引擎 id|归一化 query）
  → primary 档并发请求，达到释放条件即返回
  → 一条结果都没有时，跑 fallback 档
  → 按区域融合 + RRF 排序，截到 limit
  → 写入缓存，返回 { sources, failures, proxy }
```

一档的释放条件是四者之一：所有引擎都落定；主导区所有引擎都落定（无论成败）；已凑够 `limit` 条且贡献者数达标；软截止到点。到点还在跑的引擎会被中止，并在失败列表里记为 `still running at deadline` 或 `aborted once enough results had arrived`。

单引擎失败会被分类，构造成 `SearchError` 返回，而不是抛出去——一家挂了不该拖垮整次搜索。

### 排序公式

```
score(source) = votes / (rrfConstant + position)
                × (命中权威域名 ? 1 + authorityBoost : 1)
                × 新鲜度系数
```

- `position`：各引擎列表按加权轮转交错后，这条结果的 1 起始位置。权重 2 的引擎每轮占两个连续槽位（AnySearch 是 2，其余是 1）。
- `votes`：返回过这条结果的**不同引擎数**。两家都说好，分数翻倍；一家权重再高也不会。
- 权重只影响「入选名额」，不乘到分数上。这一点是实测修正的：早期版本把权重当分数乘子，`rrfConstant = 60` 时权重 2 会在每个名次上压过其他引擎，CJK 查询直接变成 AnySearch 独占 8 条、中文引擎一条不剩。现在权重 2/1/1、三个列表 10/10/4 条、`limit: 8` 时，名额是 4/2/2。
- 新鲜度系数：`1 + freshnessBoost × (1 − ageDays / freshnessDays)`，超过窗口就是 1；日期解析失败也按 1 处理，不惩罚。
- 平局依次比较：引擎顺序 → 该引擎内的排名 → URL 字符串，所以同样的输入永远得到同样的顺序。

**目前空转的一项**：没有任何引擎产出 `publishedAt`（结果页没有稳定的日期字段），所以新鲜度加成还没真正起作用。等某个引擎能给出日期，它才会开始生效。

### 缓存与冷却

**缓存**是 TTL + LRU：条目在 `cacheTtlMs`（默认 `600000`，即 10 分钟）后过期，超过 `cacheEntries`（默认 `100`）条时淘汰最久未使用的一条；`cacheTtlMs: 0` 直接关闭。存取都会拷贝数组和每个对象，调用方改不动缓存。缓存键里的引擎集合取的是**冷却过滤之前**、这次运行会用的集合，所以某家进入或离开冷却不会让刚写进去的条目失效。

**冷却**针对「抓公开结果页被拦」这件事：`SEARCH_THROTTLED`（429）、`SEARCH_BLOCKED`（403、其他 4xx、回显校验不通过）、`SEARCH_TIMEOUT`、`SEARCH_NETWORK` 会让引擎休息；`SEARCH_PARSE`（上游改版，重试没用）和 `SEARCH_ABORTED`（调用方取消）不冷却。时长优先用对方给的 `Retry-After`（秒数或 HTTP 日期，取最后一次跳转的响应头），没有就 `baseCooldownMs × 2^(连续失败次数−1)`，封顶 `maxCooldownMs`。成功一次清零。全都在冷却时仍然照常尝试，不会让引擎集合空掉。

### web_fetch 的三级梯队

`web_fetch` 的提供方 `http-proxy` 按顺序试三条路，前一条失败才走下一跳：

| 级别 | 做什么 | 超时 | 什么时候有用 |
| --- | --- | --- | --- |
| 1. 直连 | 直接请求目标网址 | 最多 5 秒（`DIRECT_DEADLINE_MS = 5000`） | 网络通畅时最快，也不浪费隧道的往返 |
| 2. 本地隧道 | 通过 HTTP `CONNECT` 代理请求 | 用 `timeoutMs`，默认 15 秒 | `github.com`、`html.duckduckgo.com` 这类直连超时的站点 |
| 3. AnySearch 抽取 | `POST https://api.anysearch.com/v1/extract`，服务端渲染后回正文 | 同上，默认 15 秒 | 需要 key。能救回对裸请求回 403 的页面 |

直连的截止时间故意比隧道短：被墙的站点通常表现成超时，把整个预算花在一条不可能成功的路上，后面能成功的路就没时间了。

其他细节：只接受 `http(s)` URL；单页最多保留 `1 MiB`（`1048576` 字节），超出截断并标记 `truncated`；非 2xx 是**结果**不是失败（会原样带回状态码和响应体）；三级全失败才抛错，错误消息里带每一级的原因。

### 代理

Node 的全局 `fetch` 既不读 macOS 系统代理，也不读 `HTTPS_PROXY`——除非进程启动时带了 `NODE_USE_ENV_PROXY=1`，而这个开关在进程跑起来之后打不开。所以需要代理时，插件自己连：发 `CONNECT`、对 `https:` 目标做 TLS 升级、手写请求、自己解析 `Content-Length` / chunked / gzip / deflate / brotli，最多跟 4 次跳转。`307`/`308` 保留方法和请求体，其他 `3xx` 把 `POST` 降级成无 body 的 `GET`。

代理来源顺序：配置里的 `proxy` → 环境变量 `DSH_WEB_SEARCH_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`（大小写都认）→ macOS `scutil --proxy`（带 400 ms TCP 探测，结果缓存 60 秒）。只支持 HTTP 代理；`socks5://` 请换成客户端的 HTTP/mixed 端口。代理只作用于本插件，应用其他流量走原来的路。

### 已知限制

- **相关性受上游结果页限制**，整体不如商业搜索 API。免密钥抓取会碰到限流：实测 360 会回 `访问异常页面` 加验证码，另一家国内引擎回 `x5sec` 惩罚页。靠冷却和多引擎互补兜着，但兜不住全部。
- **Google 在本网络下不可达**：走隧道请求 `www.google.com/search` 只回 JS 空壳（94 KB、1–3 个链接），无头 Chrome 被重定向到 `google.com.hk` 并回 reCAPTCHA；`gbv=1`、consent cookie、移动端 UA 都试过，均无效。8 个公共 SearXNG 实例同样不可用（429/403/非 JSON）。
- **依赖上游 HTML 结构**。上游改版会让解析失败，此时该引擎记一条原因并让位，不会静默返回空列表。
- **结果里只有标题、链接、摘要，没有正文**。正文要 `web_fetch`。
- **目前不产出发布日期**，新鲜度加成处于空转状态。
- **AnySearch 匿名调用每次最多 10 条。**
- **只支持 HTTP 代理**，不支持 `socks5://`。
- **`limit` 上限 20。**

### 默认值速查

| 项 | 值 |
| --- | --- |
| 返回条数 `limit` | `8`（1–20） |
| 缓存有效期 `cacheTtlMs` | `600000` 毫秒 = 600 秒 |
| 缓存条数 `cacheEntries` | `100` |
| 单引擎超时 `timeoutMs` | `15000` 毫秒 |
| `web_fetch` 直连截止 | `5000` 毫秒 |
| 单页字节上限 | `1048576`（1 MiB） |
| RRF 常数 `rrfConstant` | `60` |
| 基础冷却 `baseCooldownMs` | `300000` 毫秒 = 5 分钟 |
| 最大冷却 `maxCooldownMs` | `1800000` 毫秒 = 30 分钟 |

### 开发与测试

```sh
node --test test/*.test.ts     # 全部测试
node --test test/proxy.test.ts # 单个文件
npm run typecheck              # tsc --noEmit
npm run build                  # 编译 src/ 到 lib/
npm run check                  # typecheck + 测试
```

测试全程离线：解析器测试回放 `test/fixtures/` 里抓下来的真实响应，传输测试不开 socket，代理测试只验 `parseProxy`、`proxyFromEnv` 和纯函数式的响应分帧。

CI（`.github/workflows/ci.yml`）在 Node 24 的 Ubuntu 与 macOS 上跑 `npm ci`、`npm run typecheck`、`npm test`、`npm run build`，并检查构建确实产出了 `lib/index.js` 和 `lib/index.d.ts`，且 `apply` 与 `Config` 都可导入。

改完 `src/*.ts` 记得构建并重启，否则跑的还是 `lib/` 里的旧代码。

## 相关文档链接

- [docs/plugin-settings-form.md](docs/plugin-settings-form.md)：插件配置要出现在设置页，需要同时满足哪四层条件；附一次真实排查的完整过程。
- [CHANGELOG.md](CHANGELOG.md)：每个版本改了什么，以及当时的实测数据。
- [docs/architecture.md](docs/architecture.md)：模块划分和从 `web` 服务到来源列表的数据流。
- [docs/engines.md](docs/engines.md)：每个引擎的请求形状、解析怪癖与实测结论。
- [docs/troubleshooting.md](docs/troubleshooting.md)：没有结果、代理没探测到、提供方没被选中、冷却卡住。
- [README.md](README.md)：英文版，与中文版逐节对应。

MIT © 2026 fangchenghao，见 [LICENSE](LICENSE)。
