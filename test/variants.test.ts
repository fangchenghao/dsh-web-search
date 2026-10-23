/**
 * Tests for the whole-phrase engine query variants.
 *
 * @module dsh-web-search-bing/test/variants
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cjkQueryVariants } from '../src/variants.ts';

test('a long policy query falls back to its core entity', () => {
  assert.deepEqual(cjkQueryVariants('东数西算 八个国家枢纽节点 定位'), ['东数西算']);
});

test('a mixed question drops the question and intent words', () => {
  assert.deepEqual(cjkQueryVariants('如何配置 postgres 逻辑复制'), ['postgres 逻辑复制']);
  assert.deepEqual(cjkQueryVariants('PostgreSQL 逻辑复制 配置'), ['PostgreSQL 逻辑复制']);
});

test('an ordinary two-word query pays nothing', () => {
  assert.deepEqual(cjkQueryVariants('Kubernetes Service 官方文档'), []);
  assert.deepEqual(cjkQueryVariants('postgres 逻辑复制'), []);
});

test('English and single-label queries get no variant', () => {
  assert.deepEqual(cjkQueryVariants('how to configure postgres logical replication'), []);
  assert.deepEqual(cjkQueryVariants('东数西算'), []);
});
