/**
 * What the fetch provider refuses, and how long it is willing to try.
 *
 * These are the real-world failures measured against this network: a PDF that
 * arrives as binary noise, a JavaScript shell that converts to zero characters,
 * a page that answers 403 after a two-rung escalation, and a caller waiting half
 * a minute for a page that will never arrive.
 *
 * @module dsh-web-search-bing/test/fetch-hardening
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchProvider } from '../src/fetch.ts';
import type { FetchOutcome } from '../src/fetch.ts';
import { htmlToMarkdown } from '../src/markdown.ts';
import { search } from '../src/engines.ts';
import { SearchError } from '../src/errors.ts';

/** An outcome the caller controls completely. */
function outcome(
  url: string,
  statusCode: number,
  content: string,
  options: { kind?: 'html' | 'text' | 'binary'; contentType?: string } = {},
): FetchOutcome {
  return {
    url,
    statusCode,
    body: { kind: options.kind ?? 'html', content },
    contentType: options.contentType,
    truncated: false,
  };
}

const PASS = { renderJs: 'off' as const, useProxy: false };

test('a binary document is refused by name instead of arriving as noise', async () => {
  const deps = {
    direct: () => Promise.resolve(outcome('https://example.com/paper.pdf', 200, '%PDF-1.5 ...', { kind: 'binary', contentType: 'application/pdf' })),
    tunnel: () => Promise.reject(new Error('unused')),
    extract: () => Promise.reject(new Error('unused')),
    detectProxy: () => Promise.resolve('http://127.0.0.1:7890'),
  };
  const provider = createFetchProvider(PASS, deps);
  await assert.rejects(
    () => provider.fetch({ url: 'https://example.com/paper.pdf' }),
    (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, 'SEARCH_UNSUPPORTED');
      assert.match(error.message, /application\/pdf/);
      return true;
    },
  );
});

test('a 200 response with no readable text is a rejection, not an empty page', async () => {
  const deps = {
    direct: () => Promise.resolve(outcome('https://example.com/app', 200, '<html><body><div id="root"></div></body></html>')),
    tunnel: () => Promise.reject(new Error('unused')),
    extract: () => Promise.reject(new Error('unused')),
    detectProxy: () => Promise.resolve('http://127.0.0.1:7890'),
  };
  const provider = createFetchProvider(PASS, deps);
  await assert.rejects(
    () => provider.fetch({ url: 'https://example.com/app' }),
    (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, 'SEARCH_EMPTY');
      return true;
    },
  );
});

test('an ordinary error page still comes back with its status', async () => {
  const deps = {
    direct: () => Promise.resolve(outcome('https://example.com/missing', 404, '<html><body><h1>Not found</h1></body></html>')),
    tunnel: () => Promise.reject(new Error('unused')),
    extract: () => Promise.reject(new Error('unused')),
    detectProxy: () => Promise.resolve('http://127.0.0.1:7890'),
  };
  const provider = createFetchProvider(PASS, deps);
  const result = await provider.fetch({ url: 'https://example.com/missing' });
  assert.equal(result.statusCode, 404);
  assert.match(result.body.content, /Not found/);
});

test('the whole ladder stops at its overall budget instead of stacking deadlines', async () => {
  const slow = (ms: number) => () => new Promise<FetchOutcome>((_, reject) => {
    setTimeout(() => reject(new Error('timed out')), ms);
  });
  const deps = { direct: slow(300), tunnel: slow(300), extract: slow(300), detectProxy: () => Promise.resolve('http://127.0.0.1:7890') };
  const provider = createFetchProvider({ ...PASS, overallMs: 500 }, deps);
  const startedAt = Date.now();
  await assert.rejects(() => provider.fetch({ url: 'https://example.com' }), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.code, 'SEARCH_NETWORK');
    return true;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_500, `the ladder spent ${elapsed}ms against a 500ms budget`);
});

test('a layout shell as <main> does not blank the page', () => {
  // github.com's repository pages have a `<main>` that holds a breadcrumb while
  // the prose lives in a sibling container; trusting any non-empty landmark
  // returned the breadcrumb and threw the article away.
  const html = `<html><body><nav>menu menu menu</nav><main><p>Home</p></main>
    <div class="content"><p>${'Real prose about the topic. '.repeat(40)}</p></div></body></html>`;
  const markdown = htmlToMarkdown(html);
  assert.ok(markdown.length > 200, `expected prose, got ${markdown.length} characters`);
  assert.match(markdown, /Real prose about the topic/);
});

test('an empty query fails immediately instead of reaching the engines', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () => search('   ', undefined, { limit: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof SearchError);
      assert.equal(error.code, 'SEARCH_INVALID');
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 100, 'validation must not wait for a network round trip');
});
