/**
 * End-to-end test for the whole-phrase engine variant fan-out.
 *
 * cn.bing answers the long query with dictionary entries for 东, but answers
 * `东数西算` with the NDRC article. The transport asks both, merges the rows,
 * and the CJK relevance gate keeps only the article.
 *
 * @module dsh-web-search-bing/test/variant-fetch
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/engines.ts';

const row = (url: string, title: string, snippet: string) =>
  `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>${snippet}</p></li>`;

test('a long Chinese query gets a core-word retry on cn.bing', async () => {
  const query = '东数西算 八个国家枢纽节点 定位';
  const original = [
    row('https://baike.baidu.com/item/%E4%B8%9C/5047', '东（汉语文字）_百度百科', '东，汉语文字。'),
    row('https://www.hgcha.com/zidian/1', '《东》的拼音', '东字的意思'),
  ].join('');
  const variant = row('https://www.ndrc.gov.cn/a.html', '东数西算 国家枢纽节点', '国家发改委 东数西算 枢纽节点');
  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const parsed = new URL(url);
    if (parsed.hostname !== 'cn.bing.com') throw new Error(`unstubbed host ${parsed.hostname}`);
    const q = parsed.searchParams.get('q') ?? '';
    const body = q === query ? original : q === '东数西算' ? variant : '';
    return new Response(`<html><body><ol>${body}</ol></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    const outcome = await search(query, undefined, { hostIds: ['cn.bing'], useProxy: false, limit: 8 });
    assert.deepEqual(outcome.sources.map((source) => source.url), ['https://www.ndrc.gov.cn/a.html']);
    assert.ok(seen.some((url) => url.includes(encodeURIComponent('东数西算')) && !url.includes(encodeURIComponent(query))), 'the core-word variant must be requested');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
