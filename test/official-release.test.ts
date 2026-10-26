/**
 * Narrow Rust release enrichment.
 *
 * The fixture mirrors the fields GitHub returns for a release tag. The test
 * checks the deterministic blog URL, the requested-version guard and the
 * failure path that must leave ordinary search untouched.
 *
 * @module dsh-web-search-bing/test/official-release
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRustRelease,
  isRustReleaseQuery,
  parseRustRelease,
  rustBlogUrl,
  rustReleaseVersion,
} from '../src/official-release.ts';
import { mergeOfficial, officialLookup, scopedNpmPackage } from '../src/official-sources.ts';

const payload = JSON.stringify({
  tag_name: '1.90.0',
  published_at: '2025-09-18T20:02:56Z',
  body: '## Language\n\n- Split up the `unknown_or_malformed_diagnostic_attributes` lint.\n- Use `lld` by default on x86_64-unknown-linux-gnu.',
});

test('recognizes a versioned Rust release query but not a tutorial', () => {
  assert.equal(isRustReleaseQuery('Rust 1.90 release notes'), true);
  assert.equal(isRustReleaseQuery('Rust 1.90 发布说明'), true);
  assert.equal(isRustReleaseQuery('Rust tutorial for beginners'), false);
  assert.equal(isRustReleaseQuery('Rust 2024 edition'), false);
  assert.deepEqual(rustReleaseVersion('Rust 1.90 发布说明'), { version: '1.90.0', tag: '1.90.0' });
  assert.equal(rustReleaseVersion('Rust 1.90.1 release notes')?.version, '1.90.1');
});

test('builds the canonical UTC blog URL', () => {
  assert.equal(
    rustBlogUrl('1.90.0', '2025-09-18T20:02:56Z'),
    'https://blog.rust-lang.org/2025/09/18/Rust-1.90.0/',
  );
  assert.equal(rustBlogUrl('1.90.0', 'not-a-date'), undefined);
});

test('parses the official release into a source', () => {
  const requested = { version: '1.90.0', tag: '1.90.0' };
  const source = parseRustRelease(payload, requested);
  assert.ok(source);
  assert.equal(source.url, 'https://blog.rust-lang.org/2025/09/18/Rust-1.90.0/');
  assert.match(source.title ?? '', /Rust 1\.90\.0/);
  assert.match(source.snippet ?? '', /Official Rust 1\.90\.0 release notes/);
  assert.equal(source.publishedAt, '2025-09-18T20:02:56.000Z');
});

test('rejects a mismatched tag and a malformed payload', () => {
  const requested = { version: '1.90.0', tag: '1.90.0' };
  assert.equal(parseRustRelease(JSON.stringify({ tag_name: '1.91.0', published_at: '2025-09-18T20:02:56Z' }), requested), undefined);
  assert.equal(parseRustRelease('not json', requested), undefined);
  assert.equal(parseRustRelease(JSON.stringify({ tag_name: '1.90.0' }), requested), undefined);
});

test('recognizes an explicitly npm-scoped package query', () => {
  assert.equal(scopedNpmPackage('@fffangchenghao/dsh-web-search npm'), '@fffangchenghao/dsh-web-search');
  assert.equal(scopedNpmPackage('npm package @scope/name version'), '@scope/name');
  assert.equal(scopedNpmPackage('what is npm?'), undefined);
  assert.equal(scopedNpmPackage('@scope/name without a registry'), undefined);
});

test('fetch uses the release endpoint and contains failures', async () => {
  const urls: string[] = [];
  const source = await fetchRustRelease('Rust 1.90 发布说明', {
    fetch: (async (url: URL | RequestInfo) => {
      urls.push(String(url));
      return new Response(payload, { status: 200 });
    }) as typeof fetch,
  });
  assert.ok(source);
  assert.deepEqual(urls, ['https://api.github.com/repos/rust-lang/rust/releases/tags/1.90.0']);

  const missing = await fetchRustRelease('Rust 1.90 发布说明', {
    fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch,
  });
  assert.equal(missing, undefined);
  assert.equal(await fetchRustRelease('Rust tutorial', {}), undefined);
});

test('mergeOfficial prepends and deduplicates by URL', () => {
  const official = { url: 'https://example.test/official', title: 'Official', snippet: 'official text' };
  const ordinary = [
    { url: 'https://example.test/other', title: 'Other', snippet: 'other text' },
    { url: official.url, title: 'Duplicate', snippet: 'duplicate text' },
  ];
  assert.deepEqual(mergeOfficial(ordinary, official), [official, ordinary[0]]);
  assert.deepEqual(mergeOfficial(ordinary, undefined), ordinary);
});

test('officialLookup ignores ordinary queries', () => {
  assert.equal(officialLookup('how to write a search plugin'), undefined);
  assert.equal(officialLookup('Rust tutorial'), undefined);
});
