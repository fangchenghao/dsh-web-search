/**
 * Tests for following HTML-level redirects.
 *
 * PyTorch's `stable` documentation keeps moved pages alive with a 200 response
 * whose entire body is `<meta http-equiv="refresh">` plus a JavaScript
 * `location.replace`. Before this, a fetch returned "# Redirecting…" as if that
 * were the page.
 *
 * @module dsh-web-search-bing/test/fetch-redirect
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { directFetch, documentRedirect } from '../src/fetch.ts';

const PYTORCH = `<!DOCTYPE html><meta charset="utf-8"><title>Redirecting&hellip;</title>
<script>location.replace("../../2.14/generated/page.html" + location.hash);</script>
<meta http-equiv="refresh" content="0; url=../../2.14/generated/page.html">
<link rel="canonical" href="../../2.14/generated/page.html">
<a href="../../2.14/generated/page.html">Continue to ../../2.14/generated/page.html</a>`;

test('a meta refresh resolves relative to the fetched URL', () => {
  assert.equal(
    documentRedirect(PYTORCH, 'https://pytorch.org/docs/stable/generated/page.html'),
    'https://pytorch.org/docs/2.14/generated/page.html',
  );
});

test('a redirect title can point at a canonical link', () => {
  const html = '<title>Redirecting…</title><link rel="canonical" href="https://example.com/new">';
  assert.equal(documentRedirect(html, 'https://example.com/old'), 'https://example.com/new');
});

test('an ordinary page that mentions location.href is not a redirect', () => {
  const html = '<html><head><title>Docs</title></head><body><h1>API</h1><script>if (x) location.href = "/next";</script></body></html>';
  assert.equal(documentRedirect(html, 'https://example.com/page'), undefined);
});

test('a non-http target is refused', () => {
  const html = '<meta http-equiv="refresh" content="0; url=javascript:alert(1)">';
  assert.equal(documentRedirect(html, 'https://example.com/'), undefined);
});

test('directFetch follows the redirect once and returns the destination', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (url.endsWith('/old')) {
      const redirect = '<title>Redirecting…</title><meta http-equiv="refresh" content="0; url=/new">';
      return new Response(redirect, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('<html><body><h1>Target page</h1></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  try {
    const outcome = await directFetch('https://example.com/old', 5_000, undefined, 'test-agent', 1_000_000);
    assert.equal(outcome.url, 'https://example.com/new');
    assert.equal(outcome.statusCode, 200);
    assert.match(outcome.body.content, /Target page/u);
    assert.deepEqual(seen, ['https://example.com/old', 'https://example.com/new']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a redirect loop stops after the hop budget instead of spinning', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const redirect = `<title>Redirecting…</title><meta http-equiv="refresh" content="0; url=/hop${calls}">`;
    return new Response(redirect, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    const outcome = await directFetch('https://example.com/loop', 5_000, undefined, 'test-agent', 1_000_000);
    assert.equal(calls, 3, 'initial request plus two follow-ups');
    assert.match(outcome.body.content, /Redirecting/u);
  } finally {
    globalThis.fetch = original;
  }
});
