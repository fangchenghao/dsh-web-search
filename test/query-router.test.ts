import assert from 'node:assert/strict';
import test from 'node:test';

import { routePackageQuery } from '../src/query-router.ts';

test('routes an explicit crates.io query to the existing crates source', () => {
  assert.deepEqual(routePackageQuery('crates.io 上 serde 和 tokio 的最新版本'), {
    id: 'crates',
    query: 'serde tokio',
    names: ['serde', 'tokio'],
    label: 'crates.io',
  });
});

test('routes explicit npm and PyPI queries', () => {
  assert.deepEqual(routePackageQuery('npm package react latest version'), {
    id: 'npm',
    query: 'react',
    names: ['react'],
    label: 'npm',
  });
  assert.deepEqual(routePackageQuery('PyPI requests library install'), {
    id: 'pypi',
    query: 'requests',
    names: ['requests'],
    label: 'PyPI',
  });
});

test('does not route general npm or crates discussion', () => {
  assert.equal(routePackageQuery('what is npm?'), undefined);
  assert.equal(routePackageQuery('how does npm install work?'), undefined);
  assert.equal(routePackageQuery('crates.io'), undefined);
  assert.equal(routePackageQuery('how does a Rust crate compile?'), undefined);
});

test('rejects empty and non-string input', () => {
  assert.equal(routePackageQuery(''), undefined);
  assert.equal(routePackageQuery('   '), undefined);
  assert.equal(routePackageQuery(undefined as unknown as string), undefined);
});
