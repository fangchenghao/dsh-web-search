/**
 * Tests for the CJK relevance gate.
 *
 * The failing live case was `东数西算 八个国家枢纽节点 定位`: cn.bing answered
 * with dictionary entries for the single character 东, and those rows entered
 * the fused list ahead of the NDRC article.
 *
 * @module dsh-web-search-bing/test/relevance
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevant, isRelevant, queryProfile } from '../src/relevance.ts';

const row = (url: string, title: string, snippet = '') => ({ url, title, snippet });

test('a dictionary entry for one character is not relevant to a CJK phrase', () => {
  const profile = queryProfile('东数西算 八个国家枢纽节点 定位');
  assert.equal(isRelevant(row('https://baike.baidu.com/item/%E4%B8%9C/5047', '东（汉语文字）_百度百科', '东，汉语文字。'), profile), false);
  assert.equal(isRelevant(row('https://www.ndrc.gov.cn/a.html', '东数西算”全面启动八枢纽激发数据新活力', '国家发改委 枢纽节点'), profile), true);
});

test('a company page matching only one character is dropped', () => {
  const profile = queryProfile('东数西算 八个国家枢纽节点 定位');
  assert.equal(isRelevant(row('https://aiqicha.baidu.com/company_detail_1', '李在东 - 北京某公司', ''), profile), false);
});

test('a page in the URL slug but not the title still counts', () => {
  const profile = queryProfile('东数西算 枢纽节点');
  assert.equal(isRelevant(row('https://example.com/%E4%B8%9C%E6%95%B0%E8%A5%BF%E7%AE%97', 'Overview', ''), profile), true);
});

test('a specific English term inside a Chinese query can carry a row by itself', () => {
  const profile = queryProfile('如何配置 postgres 逻辑复制');
  assert.equal(
    isRelevant(row('https://www.postgresql.org/docs/current/logical-replication.html', 'PostgreSQL: Logical Replication'), profile),
    true,
  );
  assert.equal(isRelevant(row('https://baike.baidu.com/item/%E5%A6%82%E4%BD%95/53965', '如何（汉语词语）_百度百科', '如何，汉语词语'), profile), false);
});

test('English queries are never filtered', () => {
  const profile = queryProfile('kubernetes service networking');
  assert.equal(profile.cjk, false);
  assert.deepEqual(filterRelevant([row('https://example.com/a', 'Cooking recipes')], 'kubernetes service networking').length, 1);
});

test('filterRelevant keeps only rows that mention the entity', () => {
  const rows = [
    row('https://baike.baidu.com/item/%E4%B8%9C/5047', '东（汉语文字）_百度百科'),
    row('https://www.ndrc.gov.cn/a.html', '东数西算”全面启动八枢纽激发数据新活力', '国家发改委'),
    row('https://example.com/irrelevant', '今日天气'),
  ];
  assert.deepEqual(
    filterRelevant(rows, '东数西算 八个国家枢纽节点 定位').map((source) => source.url),
    ['https://www.ndrc.gov.cn/a.html'],
  );
});
