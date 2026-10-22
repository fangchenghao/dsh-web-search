/**
 * Length control for `web_fetch`.
 *
 * The Host's `WebFetchRequest` has exactly one field — `url` (see
 * `@deepseek-ai/dsh-web`'s catalogued `export interface WebFetchRequest {
 * readonly url: string }`). It offers no `offset`/`maxLength`/`format`, so the
 * plugin cannot implement true continuation paging: every call starts at the
 * top of the page. What it can do, and what these tests pin down, is a
 * configurable character budget with a truncation notice that names the
 * original length, plus proof that extra request fields are ignored rather
 * than silently half-implemented.
 *
 * @module dsh-web-search-bing/test/fetch-paging
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchProvider } from '../src/fetch.ts';
import type { FetchOutcome } from '../src/fetch.ts';

/** Replace `globalThis.fetch` for one test and restore it afterwards. */
function stubFetch(body: string, contentType = 'text/html; charset=utf-8'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('the configured budget cuts converted Markdown and names the original length', async () => {
  const body = 'w'.repeat(1200);
  const page = `<html><body><article><h1>Long</h1><p>${body}</p></article></body></html>`;
  const restore = stubFetch(page);
  try {
    const provider = createFetchProvider({ maxLength: 1000 });
    const result = await provider.fetch({ url: 'https://example.com/long' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.kind, 'text', 'the Host must receive text, or it converts the page a second time');
    assert.equal(result.truncated, true);
    // "# Long\n\n" is 8 characters, leaving 992 of the 1200-word body.
    assert.equal(
      result.body.content,
      `# Long\n\n${'w'.repeat(992)}\n\n`
        + '[truncated at 1000 chars; original length 1208 chars; the rest is not shown]',
    );
  } finally {
    restore();
  }
});

test('the default budget is 20000 characters', async () => {
  const body = 'w'.repeat(20500);
  const page = `<html><body><article><h1>Long</h1><p>${body}</p></article></body></html>`;
  const restore = stubFetch(page);
  try {
    const provider = createFetchProvider();
    const result = await provider.fetch({ url: 'https://example.com/long' });
    assert.equal(result.truncated, true);
    assert.equal(
      result.body.content,
      `# Long\n\n${'w'.repeat(19992)}\n\n`
        + '[truncated at 20000 chars; original length 20508 chars; the rest is not shown]',
    );
  } finally {
    restore();
  }
});

test('fetchFormat text returns the same reading order without Markdown syntax', async () => {
  const page = '<html><body><h2>Title</h2><p><strong>Bold</strong> <a href="/x">Link</a></p></body></html>';
  const restore = stubFetch(page);
  try {
    const provider = createFetchProvider({ format: 'text' });
    const result = await provider.fetch({ url: 'https://example.com/page' });
    assert.equal(result.body.content, 'Title\n\nBold Link (https://example.com/x)');
    assert.equal(result.truncated, false);
  } finally {
    restore();
  }
});

test('a plain-text body is budgeted too, without HTML conversion', async () => {
  const json = `{"data":"${'j'.repeat(1200)}"}`;
  const restore = stubFetch(json, 'application/json');
  try {
    const provider = createFetchProvider({ maxLength: 1000 });
    const result = await provider.fetch({ url: 'https://api.example.com/items' });
    assert.equal(result.body.kind, 'text');
    assert.equal(result.truncated, true);
    assert.equal(
      result.body.content,
      `${json.slice(0, 1000)}\n\n`
        + `[truncated at 1000 chars; original length ${json.length} chars; the rest is not shown]`,
    );
  } finally {
    restore();
  }
});

test('an offset in the request cannot continue a page: every call starts at the top', async () => {
  const page = `<html><body><article><h1>Long</h1><p>${'w'.repeat(1200)}</p></article></body></html>`;
  const restore = stubFetch(page);
  try {
    const provider = createFetchProvider({ maxLength: 1000 });
    const first = await provider.fetch({ url: 'https://example.com/long', offset: 1000 } as never);
    const second = await provider.fetch({ url: 'https://example.com/long' });
    // The Host type has no offset field, so the extra property is inert: the
    // second read is identical rather than the tail after character 1000.
    assert.equal(first.body.content, second.body.content);
    assert.ok(first.body.content.startsWith('# Long\n\n'));
    assert.ok(first.body.content.includes('[truncated at 1000 chars;'));
  } finally {
    restore();
  }
});

test('the tunnel rung is converted as well, not just the direct rung', async () => {
  const html: FetchOutcome = {
    url: 'https://example.com/tunnelled',
    statusCode: 200,
    body: {
      kind: 'html',
      content: '<html><body><nav>Menu</nav><article><h1>Kept</h1><p>Body</p></article></body></html>',
    },
    truncated: false,
  };
  const provider = createFetchProvider(
    { proxy: 'http://127.0.0.1:7890' },
    {
      direct: () => Promise.reject(new Error('direct refused')),
      tunnel: () => Promise.resolve(html),
      extract: () => Promise.reject(new Error('unused')),
      detectProxy: () => Promise.resolve('http://127.0.0.1:7890'),
    },
  );
  const result = await provider.fetch({ url: html.url });
  assert.equal(result.body.content, '# Kept\n\nBody');
  assert.equal(result.body.kind, 'text');
  assert.equal(result.truncated, false);
});

test('a non-2xx HTML response is converted but keeps its status', async () => {
  const page = '<html><body><article><h1>Missing</h1><p>Not found here.</p></article></body></html>';
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(page, { status: 404, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  try {
    const provider = createFetchProvider({ maxLength: 20000 });
    const result = await provider.fetch({ url: 'https://example.com/missing' });
    assert.equal(result.statusCode, 404);
    assert.equal(result.body.content, '# Missing\n\nNot found here.');
    assert.equal(result.truncated, false);
  } finally {
    globalThis.fetch = original;
  }
});
