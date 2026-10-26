/**
 * Offline contract tests for the keyless platform adapters.
 *
 * Every response below is a trimmed stand-in for a live payload, and `fetch`
 * is always injected, so the suite never touches the network and never needs
 * the proxy. The tests cover the six parsers, the direct-to-fallback switch,
 * failure isolation, de-duplication, interleaving and the global cap.
 *
 * @module dsh-web-search-bing/test/platforms
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLATFORM_LIMIT,
  MAX_PLATFORM_LIMIT,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  isPlatformId,
  parseBilibili,
  normaliseJuejinSources,
  normaliseZhihuFallback,
  parseJuejin,
  parseReddit,
  parseV2ex,
  parseYoutube,
  searchPlatforms,
} from '../src/platforms.ts';
import type { PlatformId, PlatformSearchOptions } from '../src/platforms.ts';
import type { Source } from '../src/types.ts';

/** One HTTP answer the stub serves. */
type Reply = { status?: number; body: string } | { error: Error };

/** A fallback call, as recorded by {@link fallbackWith}. */
interface FallbackCall {
  query: string;
  limit: number;
}

/** A source with a stable shape. */
function source(url: string, title = 'Title'): Source {
  return { url, title, snippet: 'snippet' };
}

/** Route a request by hostname, recording each URL. */
function routedFetch(routes: Partial<Record<string, Reply>>, calls: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push(url);
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    const reply = routes[host];
    if (reply === undefined) throw new Error(`unexpected host ${host}`);
    if ('error' in reply) throw reply.error;
    return new Response(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
}

/** A `fetch` that fails the test if a direct request is attempted. */
function guardedFetch(): typeof fetch {
  return (async () => {
    throw new Error('direct request should not run');
  }) as unknown as typeof fetch;
}

/** A fallback search that records its calls and returns fixed rows. */
function fallbackWith(
  sources: Source[],
  calls: FallbackCall[] = [],
  failures: string[] = [],
): NonNullable<PlatformSearchOptions['fallbackSearch']> {
  return async (query, limit) => {
    calls.push({ query, limit });
    return { sources: sources.slice(0, limit), failures };
  };
}

/** The documented Juejin envelope, with one string id and one numeric id. */
const JUEJIN_JSON = JSON.stringify({
  err_no: 0,
  err_msg: '',
  data: [
    {
      result_model: {
        article_info: {
          article_id: '7300000000000000001',
          title: '<em>TypeScript</em> 类型体操入门',
          brief_content: '从零开始 &amp; 实战',
          ctime: '1700000000',
        },
      },
    },
    {
      result_model: {
        article_info: {
          article_id: 1234567890,
          title: 'Rust 实战',
          brief_content: '',
          ctime: 1700086400,
        },
      },
    },
  ],
});

/** The documented Reddit listing, with a permalink and an external link. */
const REDDIT_JSON = JSON.stringify({
  data: {
    children: [
      {
        data: {
          title: 'How to &quot;test&quot;',
          permalink: '/r/typescript/comments/abc/how_to_test/',
          selftext: 'A post about <b>testing</b>',
          created_utc: 1700000000,
          subreddit_name_prefixed: 'r/typescript',
          score: 42,
          num_comments: 7,
        },
      },
      {
        data: {
          title: 'External link',
          url: 'https://example.com/x',
          selftext: '',
          created_utc: 1700086400,
          subreddit_name_prefixed: 'r/webdev',
          score: 1,
          num_comments: 2,
        },
      },
    ],
  },
});

/** A Bilibili video search envelope with a highlighted title. */
const BILIBILI_JSON = JSON.stringify({
  code: 0,
  message: '0',
  data: {
    result: [
      {
        type: 'video',
        arcurl: 'https://www.bilibili.com/video/BV1xx411c7mD',
        bvid: 'BV1xx411c7mD',
        title: '<em class="keyword">TypeScript</em> 教程',
        description: '从零开始 &amp; 实战',
        pubdate: 1700000000,
        author: '某UP',
      },
      {
        type: 'video',
        bvid: 'BV1yy411c7mE',
        title: '第二个视频',
        description: '',
        pubdate: '1700086400',
      },
    ],
  },
});

/** A V2EX hot list; only two topics mention TypeScript. */
const V2EX_JSON = JSON.stringify([
  {
    id: 100,
    title: 'TypeScript 5.9 发布',
    content: '新版本带来了若干改进。',
    url: 'https://www.v2ex.com/t/100',
    created: 1700000000,
  },
  {
    id: 101,
    title: '求推荐键盘',
    content: '想买一把适合 TypeScript 开发的键盘。',
    created: 1700086400,
  },
  {
    id: 102,
    title: '周末骑行',
    content: '天气不错。',
    url: 'https://www.v2ex.com/t/102',
    created: 1700172800,
  },
]);

/** One video renderer, as YouTube embeds it. */
function videoRenderer(id: string, title: string): Record<string, unknown> {
  return {
    videoId: id,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: 'Channel' }] },
    lengthText: { simpleText: '10:01' },
    viewCountText: { simpleText: '1,234 views' },
    publishedTimeText: { simpleText: '2 days ago' },
  };
}

/** A YouTube results page with two video renderers in a nested experiment. */
function youtubePage(renderers: Record<string, unknown>[]): string {
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{ itemSectionRenderer: { contents: renderers.map((renderer) => ({ videoRenderer: renderer })) } }],
          },
        },
      },
    },
  };
  return `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
}

/** The ISO stamp for one epoch-seconds value. */
function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

test('PLATFORM_IDS, labels and the guard cover exactly the six platforms', () => {
  assert.deepEqual([...PLATFORM_IDS], ['bilibili', 'v2ex', 'reddit', 'youtube', 'zhihu', 'juejin']);
  assert.equal(new Set(PLATFORM_IDS).size, 6);
  for (const id of PLATFORM_IDS) {
    assert.equal(typeof PLATFORM_LABELS[id], 'string');
    assert.equal(isPlatformId(id), true);
  }
  assert.equal(isPlatformId('douban'), false);
  assert.equal(isPlatformId(42), false);
  assert.equal(isPlatformId(undefined), false);
});

test('parseJuejin reads the documented article_info wrapper', () => {
  const sources = parseJuejin(JUEJIN_JSON);
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {
    url: 'https://juejin.cn/post/7300000000000000001',
    title: 'TypeScript 类型体操入门',
    snippet: '从零开始 & 实战',
    publishedAt: iso(1700000000),
  });
  assert.deepEqual(sources[1], {
    url: 'https://juejin.cn/post/1234567890',
    title: 'Rust 实战',
    publishedAt: iso(1700086400),
  });
});

test('parseJuejin accepts a bare article_info shape and caps at the limit', () => {
  const payload = JSON.stringify({
    err_no: 0,
    data: [{ article_info: { article_id: 123, title: 'Bare', brief_content: 'x' } }],
  });
  assert.deepEqual(parseJuejin(payload), [
    { url: 'https://juejin.cn/post/123', title: 'Bare', snippet: 'x' },
  ]);
  assert.equal(parseJuejin(JUEJIN_JSON, 1).length, 1);
  assert.throws(() => parseJuejin('{"err_no":1,"err_msg":"blocked"}'), /API err_no 1/);
});

test('parseBilibili strips highlight tags, resolves bvid and parses pubdate', () => {
  const sources = parseBilibili(BILIBILI_JSON);
  assert.deepEqual(sources[0], {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: 'TypeScript 教程',
    snippet: 'UP主 某UP · 从零开始 & 实战',
    publishedAt: iso(1700000000),
  });
  assert.deepEqual(sources[1], {
    url: 'https://www.bilibili.com/video/BV1yy411c7mE',
    title: '第二个视频',
    publishedAt: iso(1700086400),
  });
  assert.equal(parseBilibili(BILIBILI_JSON, 1).length, 1);
});

test('parseBilibili rejects an anti-bot code and an HTML page', () => {
  assert.throws(() => parseBilibili('{"code":-412,"message":"请求被拦截"}'), /API code -412/);
  assert.throws(() => parseBilibili('<!DOCTYPE html><html><body>blocked</body></html>'), /HTML \(anti-bot\)/);
});

test('parseReddit prefers the permalink and decodes entities', () => {
  const sources = parseReddit(REDDIT_JSON);
  assert.deepEqual(sources[0], {
    url: 'https://www.reddit.com/r/typescript/comments/abc/how_to_test/',
    title: 'How to "test"',
    snippet: 'A post about testing',
    publishedAt: iso(1700000000),
  });
  assert.deepEqual(sources[1], {
    url: 'https://example.com/x',
    title: 'External link',
    snippet: 'r/webdev · 1 points · 2 comments',
    publishedAt: iso(1700086400),
  });
});

test('parseYoutube walks ytInitialData for videoRenderer', () => {
  const page = youtubePage([videoRenderer('abc123', 'TS &amp; JS'), videoRenderer('def456', 'Second')]);
  const sources = parseYoutube(page);
  assert.equal(sources.length, 2);
  assert.equal(sources[0]?.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(sources[0]?.title, 'TS & JS');
  assert.equal(sources[0]?.snippet, 'Channel · 10:01 · 1,234 views · 2 days ago');
  assert.match(sources[0]?.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(sources[1]?.url, 'https://www.youtube.com/watch?v=def456');
});

test('parseYoutube rejects a page without ytInitialData', () => {
  assert.throws(() => parseYoutube('<html><body>consent</body></html>'), /ytInitialData not found/);
});

test('parseYoutube expands compact relative stamps', () => {
  const renderer = { ...videoRenderer('ghi789', 'Third'), publishedTimeText: { simpleText: '1d ago' } };
  const [first] = parseYoutube(youtubePage([renderer]));
  assert.match(first?.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(first?.snippet, 'Channel · 10:01 · 1,234 views · 1d ago');
});

test('parseV2ex filters hot topics by title or body', () => {
  const sources = parseV2ex(V2EX_JSON, 'typescript');
  assert.deepEqual(sources.map((item) => item.url), [
    'https://www.v2ex.com/t/100',
    'https://www.v2ex.com/t/101',
  ]);
  assert.deepEqual(sources[1], {
    url: 'https://www.v2ex.com/t/101',
    title: '求推荐键盘',
    snippet: '想买一把适合 TypeScript 开发的键盘。',
    publishedAt: iso(1700086400),
  });
  assert.equal(parseV2ex(V2EX_JSON, 'typescript', 1).length, 1);
  assert.deepEqual(parseV2ex(V2EX_JSON, '不存在的词'), []);
  assert.throws(() => parseV2ex('<html>cloudflare</html>', 'x'), /HTML \(anti-bot\)/);
});

test('Bilibili direct HTML falls back to site:bilibili.com', async () => {
  const calls: string[] = [];
  const fallbackCalls: FallbackCall[] = [];
  const fetch = routedFetch(
    { 'api.bilibili.com': { body: '<!DOCTYPE html><html><body>anti-bot</body></html>' } },
    calls,
  );
  const outcome = await searchPlatforms('鸣潮', {
    ids: ['bilibili'],
    limit: 3,
    fetch,
    fallbackSearch: fallbackWith(
      [source('https://www.bilibili.com/video/BVfallback', 'Fallback')],
      fallbackCalls,
    ),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(fallbackCalls, [{ query: 'site:bilibili.com 鸣潮', limit: 3 }]);
  assert.deepEqual(outcome.sources.map((item) => item.url), ['https://www.bilibili.com/video/BVfallback']);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.via['bilibili'], 'fallback');
  assert.deepEqual(outcome.counts, { bilibili: 1 });
  assert.equal(outcome.truncated, false);
});

test('a YouTube page without ytInitialData falls back to site:youtube.com', async () => {
  const fallbackCalls: FallbackCall[] = [];
  const outcome = await searchPlatforms('typescript tutorial', {
    ids: ['youtube'],
    fetch: routedFetch({ 'www.youtube.com': { body: '<html><body>preview only</body></html>' } }),
    fallbackSearch: fallbackWith(
      [source('https://www.youtube.com/watch?v=fallback', 'Fallback video')],
      fallbackCalls,
    ),
  });
  assert.deepEqual(fallbackCalls, [{ query: 'site:youtube.com typescript tutorial', limit: DEFAULT_PLATFORM_LIMIT }]);
  assert.equal(outcome.via['youtube'], 'fallback');
  assert.equal(outcome.sources.length, 1);
});

test('Zhihu goes straight to the site:zhihu.com fallback', async () => {
  const fallbackCalls: FallbackCall[] = [];
  const outcome = await searchPlatforms('前端', {
    ids: ['zhihu'],
    fetch: guardedFetch(),
    fallbackSearch: fallbackWith([source('https://www.zhihu.com/question/1', 'Question')], fallbackCalls),
  });
  assert.deepEqual(fallbackCalls, [{ query: 'site:zhihu.com 前端', limit: DEFAULT_PLATFORM_LIMIT }]);
  assert.deepEqual(outcome.sources.map((item) => item.url), ['https://www.zhihu.com/question/1']);
  assert.equal(outcome.via['zhihu'], 'fallback');
  assert.deepEqual(outcome.failures, []);
});

test('fallback rows from another domain are rejected', async () => {
  const outcome = await searchPlatforms('前端', {
    ids: ['zhihu'],
    fetch: guardedFetch(),
    fallbackSearch: fallbackWith([
      source('https://www.zhihu.com/question/1', 'Question'),
      source('https://aggregator.example/zhihu-post', 'Aggregator'),
    ]),
  });
  assert.deepEqual(outcome.sources.map((item) => item.url), ['https://www.zhihu.com/question/1']);
  assert.deepEqual(outcome.failures, []);
});

test('a fallback with only off-domain rows explains the miss', async () => {
  const fallbackCalls: FallbackCall[] = [];
  const outcome = await searchPlatforms('typescript tutorial', {
    ids: ['youtube'],
    fetch: guardedFetch(),
    fallbackSearch: fallbackWith([source('https://example.com/video', 'Not a video platform')], fallbackCalls),
  });
  assert.deepEqual(outcome.sources, []);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0] ?? '', /fallback returned no youtube\.com result/);
});

test('Zhihu without a fallback reports a clean failure', async () => {
  const outcome = await searchPlatforms('前端', { ids: ['zhihu'], fetch: guardedFetch() });
  assert.deepEqual(outcome.sources, []);
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0] ?? '', /^zhihu: no keyless direct API/);
  assert.equal(outcome.counts['zhihu'], 0);
  assert.equal(outcome.via['zhihu'], 'fallback');
});

test('one dead platform does not fail the call', async () => {
  const fetch = routedFetch({
    'www.reddit.com': { error: new Error('connection reset') },
    'api.juejin.cn': { body: JUEJIN_JSON },
  });
  const outcome = await searchPlatforms('typescript', { ids: ['reddit', 'juejin'], fetch });
  assert.deepEqual(outcome.sources.map((item) => item.url), [
    'https://juejin.cn/post/7300000000000000001',
    'https://juejin.cn/post/1234567890',
  ]);
  assert.deepEqual(outcome.failures, ['reddit: connection reset']);
  assert.equal(outcome.counts['reddit'], 0);
  assert.equal(outcome.counts['juejin'], 2);
  assert.equal(outcome.via['reddit'], 'api');
  assert.equal(outcome.via['juejin'], 'api');
});

test('a failed fallback keeps the direct reason', async () => {
  const outcome = await searchPlatforms('typescript', {
    ids: ['reddit'],
    fetch: routedFetch({ 'www.reddit.com': { status: 403, body: 'Forbidden' } }),
    fallbackSearch: fallbackWith([], [], ['bing: timed out']),
  });
  assert.deepEqual(outcome.failures, ['reddit: HTTP 403; fallback failed: bing: timed out']);
  assert.equal(outcome.via['reddit'], 'fallback');
  assert.equal(outcome.counts['reddit'], 0);
});

test('duplicate URLs are removed and interleaving respects the limit', async () => {
  const shared = 'https://www.youtube.com/watch?v=abc123';
  const reddit = JSON.stringify({
    data: {
      children: [
        {
          data: {
            permalink: '/r/typescript/comments/one/',
            title: 'One',
            created_utc: 1700000000,
          },
        },
        { data: { url: shared, title: 'Shared video', created_utc: 1700086400 } },
      ],
    },
  });
  const youtube = youtubePage([
    videoRenderer('abc123', 'Shared video'),
    videoRenderer('def456', 'Second'),
    videoRenderer('ghi789', 'Third'),
  ]);
  const fetch = routedFetch({
    'www.reddit.com': { body: reddit },
    'www.youtube.com': { body: youtube },
  });
  const outcome = await searchPlatforms('video', { ids: ['reddit', 'youtube'], limit: 3, fetch });
  assert.deepEqual(outcome.sources.map((item) => item.url), [
    'https://www.reddit.com/r/typescript/comments/one/',
    shared,
    'https://www.youtube.com/watch?v=def456',
  ]);
  assert.equal(outcome.truncated, true);
  assert.deepEqual(outcome.counts, { reddit: 2, youtube: 3 });
  assert.deepEqual(outcome.failures, []);
});

test('the global limit is clamped to ten and snippets are bounded', async () => {
  const longBrief = '长'.repeat(500);
  const articles = Array.from({ length: 12 }, (_, index) => ({
    result_model: { article_info: { article_id: `id-${index}`, title: `Article ${index}`, brief_content: longBrief } },
  }));
  const outcome = await searchPlatforms('long', {
    ids: ['juejin'],
    limit: 99,
    fetch: routedFetch({ 'api.juejin.cn': { body: JSON.stringify({ err_no: 0, data: articles }) } }),
  });
  assert.equal(outcome.sources.length, MAX_PLATFORM_LIMIT);
  assert.equal(outcome.counts['juejin'], MAX_PLATFORM_LIMIT);
  assert.equal(outcome.truncated, false);
  assert.equal((outcome.sources[0]?.snippet ?? '').length, 300);
});

test('an empty query performs no requests and returns an empty outcome', async () => {
  let called = false;
  const stub = (async () => {
    called = true;
    return new Response('');
  }) as unknown as typeof globalThis.fetch;
  const outcome = await searchPlatforms('   ', { fetch: stub });
  assert.deepEqual(outcome, { sources: [], failures: [], counts: {}, truncated: false, via: {} });
  assert.equal(called, false);
});

test('PLATFORM_LABELS and PlatformId stay aligned at compile time', () => {
  const labels: Record<PlatformId, string> = { ...PLATFORM_LABELS };
  assert.equal(labels['bilibili'], 'Bilibili');
  assert.equal(Object.keys(labels).length, PLATFORM_IDS.length);
});

test("Bilibili keeps the query's topic and exposes play counts", () => {
  const payload = JSON.stringify({
    code: 0,
    data: {
      result: [
        { bvid: 'BV1python', title: 'Python 异步编程', description: 'async await', pubdate: 1700000000, play: 900, author: 'A', duration: '10:00' },
        { bvid: 'BV1rust', title: 'Rust 异步编程', description: 'tokio async', pubdate: 1700000000, play: 42, author: 'B', duration: '94:31' },
        { bvid: 'BV1react', title: 'React 全面 Rust 化', description: 'news', pubdate: 1700000000, play: 800, author: 'C' },
      ],
    },
  });
  const sources = parseBilibili(payload, 10, 'Rust 异步编程');
  assert.deepEqual(sources.map((source) => source.title), ['Rust 异步编程']);
  assert.match(sources[0]?.snippet ?? '', /播放 42/u);
  assert.match(sources[0]?.snippet ?? '', /时长 94:31/u);
});

test('Bilibili retries the alternate endpoint after the first parser rejects', async () => {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    if (calls === 1) return new Response('<html>anti-bot</html>', { status: 200 });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        result: [{ bvid: 'BV1alt', title: 'Rust 异步编程', description: 'tokio', pubdate: 1700000000, play: 10 }],
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const outcome = await searchPlatforms('Rust 异步编程', { ids: ['bilibili'], limit: 3, fetch });
  assert.equal(calls, 2);
  assert.equal(outcome.via['bilibili'], 'api');
  assert.equal(outcome.sources.length, 1);
  assert.equal(outcome.failures.length, 0);
});

test('Bilibili applies recency and popularity only when the query asks', () => {
  const now = new Date(Date.now() - 20 * 24 * 60 * 60 * 1_000).toISOString();
  const old = '2020-01-01T00:00:00.000Z';
  const payload = JSON.stringify({
    code: 0,
    data: {
      result: [
        { bvid: 'BVold', title: 'Rust 异步编程 旧教程', description: 'async', pubdate: Date.parse(old) / 1000, play: 999_999 },
        { bvid: 'BVsmall', title: 'Rust 异步编程 小教程', description: 'async', pubdate: Date.parse(now) / 1000, play: 10 },
        { bvid: 'BVbig', title: 'Rust 异步编程 大教程', description: 'async', pubdate: Date.parse(now) / 1000, play: 500 },
      ],
    },
  });
  const recent = parseBilibili(payload, 10, 'Rust 异步编程 2026 教程 播放量较高');
  assert.deepEqual(recent.map((item) => item.title), ['Rust 异步编程 大教程', 'Rust 异步编程 小教程']);
  const plain = parseBilibili(payload, 10, 'Rust 异步编程');
  assert.equal(plain.length, 3);
});

test('Juejin adds engagement counts when the API provides them', () => {
  const payload = JSON.stringify({
    err_no: 0,
    data: [{ article_info: { article_id: '1', title: 'AI 编程助手', brief_content: '实测', digg_count: 217, view_count: 36989 } }],
  });
  const [source] = parseJuejin(payload);
  assert.equal(source?.snippet, '点赞 217 · 阅读 36989 · 实测');
});

test('Juejin sorts by likes only when the query asks for popular posts', () => {
  const rows = parseJuejin(JSON.stringify({
    err_no: 0,
    data: [
      { article_info: { article_id: '1', title: 'small', brief_content: 'a', digg_count: 16, view_count: 1 } },
      { article_info: { article_id: '2', title: 'big', brief_content: 'b', digg_count: 217, view_count: 1 } },
    ],
  }));
  assert.deepEqual(normaliseJuejinSources(rows, '高赞 AI 编程助手').map((item) => item.title), ['big', 'small']);
  assert.deepEqual(normaliseJuejinSources(rows, 'AI 编程助手').map((item) => item.title), ['small', 'big']);
});

test('Zhihu fallback drops a broad question when specific answers exist', () => {
  const rows = [
    { url: 'https://www.zhihu.com/question/1', title: '目前有哪些主流的 AI ？', snippet: 'AI 工具列表' },
    { url: 'https://zhuanlan.zhihu.com/p/2', title: 'Claude Code：AI 编程的深度体验', snippet: 'AI 编程助手的真实体验' },
    { url: 'https://www.zhihu.com/question/3', title: '编程助手怎么选？', snippet: '真实体验与高赞回答' },
  ];
  assert.deepEqual(normaliseZhihuFallback(rows, 'AI 编程助手 真实体验 高赞').map((item) => item.url), [rows[1].url, rows[2].url]);
  assert.deepEqual(normaliseZhihuFallback(rows, 'AI').map((item) => item.url), rows.map((item) => item.url));
});
