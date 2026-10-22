/**
 * The fetch provider's ladder: direct, then tunnel, then AnySearch extraction.
 *
 * Every rung is injected, so these tests assert the escalation policy and the
 * shape of the result without a network. The live behaviour they stand in for is
 * the measured one: a direct request to `github.com` times out on this network
 * while the tunnel returns the page in a few seconds.
 *
 * @module dsh-web-search-bing/test/fetch
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchProvider } from '../src/fetch.ts';
import type { FetchOutcome } from '../src/fetch.ts';
import { SearchError } from '../src/errors.ts';

/** An outcome for a 200 response. */
function ok(url: string, content = '<html><body>hello</body></html>', kind: 'html' | 'text' = 'html'): FetchOutcome {
  return { url, statusCode: 200, body: { kind, content }, truncated: false };
}

/** Record which rungs ran. */
interface Ladder {
  calls: string[];
  deps: Parameters<typeof createFetchProvider>[1];
}

/** Build a dependency set where each rung either resolves or throws. */
function ladder(plan: { direct?: 'ok' | 'fail'; tunnel?: 'ok' | 'fail' | 'missing'; extract?: 'ok' | 'fail'; proxy?: string }): Ladder {
  const calls: string[] = [];
  const pass = (rung: string, verdict: 'ok' | 'fail' | undefined, url: string): Promise<FetchOutcome> => {
    calls.push(rung);
    if (verdict === 'ok') return Promise.resolve(ok(url));
    return Promise.reject(new Error(`${rung} refused`));
  };
  return {
    calls,
    deps: {
      direct: (url) => pass('direct', plan.direct ?? 'fail', url),
      tunnel: (url) => pass('tunnel', plan.tunnel ?? 'fail', url),
      extract: (url) => pass('extract', plan.extract ?? 'fail', url),
      detectProxy: () => Promise.resolve(plan.proxy ?? 'http://127.0.0.1:7890'),
    },
  };
}

test('a direct success never touches the tunnel', async () => {
  const { calls, deps } = ladder({ direct: 'ok' });
  const provider = createFetchProvider({ renderJs: 'off' }, deps);
  const result = await provider.fetch({ url: 'https://example.com' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ['direct']);
});

test('a direct failure escalates to the tunnel', async () => {
  const { calls, deps } = ladder({ direct: 'fail', tunnel: 'ok' });
  const provider = createFetchProvider({ renderJs: 'off' }, deps);
  const result = await provider.fetch({ url: 'https://github.com/x' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, ['direct', 'tunnel']);
});

test('the tunnel is skipped when it is disabled, and extraction takes over', async () => {
  const { calls, deps } = ladder({ direct: 'fail', tunnel: 'ok', extract: 'ok' });
  const provider = createFetchProvider({ useProxy: false, anysearchApiKey: 'key', renderJs: 'off' }, deps);
  const result = await provider.fetch({ url: 'https://blocked.example/page' });
  assert.deepEqual(calls, ['direct', 'extract']);
  assert.equal(result.statusCode, 200);
});

test('extraction only runs when a key is configured', async () => {
  const { calls, deps } = ladder({ direct: 'fail', tunnel: 'fail', extract: 'ok' });
  const withoutKey = createFetchProvider({ renderJs: 'off' }, deps);
  await assert.rejects(() => withoutKey.fetch({ url: 'https://x.example/' }), (error: unknown) => {
    assert.ok(error instanceof SearchError);
    assert.match(error.message, /cannot fetch/);
    return true;
  });
  assert.deepEqual(calls, ['direct', 'tunnel']);
  calls.length = 0;

  const withKey = createFetchProvider({ anysearchApiKey: 'key', renderJs: 'off' }, deps);
  const result = await withKey.fetch({ url: 'https://x.example/' });
  assert.deepEqual(calls, ['direct', 'tunnel', 'extract']);
  assert.equal(result.statusCode, 200);
});

test('a non-http target is rejected without trying any rung', async () => {
  const { calls, deps } = ladder({ direct: 'ok' });
  const provider = createFetchProvider({ renderJs: 'off' }, deps);
  await assert.rejects(() => provider.fetch({ url: 'file:///etc/passwd' }), /not an http\(s\) URL/);
  assert.deepEqual(calls, []);
});

test('a cancellation is not retried on a later rung', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const provider = createFetchProvider(
    {},
    {
      direct: () => {
        calls.push('direct');
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
      tunnel: () => {
        calls.push('tunnel');
        return Promise.resolve(ok('https://x'));
      },
      extract: () => Promise.resolve(ok('https://x')),
      detectProxy: () => Promise.resolve('http://127.0.0.1:7890'),
    },
  );
  await assert.rejects(() => provider.fetch({ url: 'https://x.example/' }, controller.signal));
  assert.deepEqual(calls, ['direct']);
});

test('an oversized body is clamped and flagged', async () => {
  // The clamp lives in the real direct transport, so this test stubs `fetch`
  // rather than injecting a rung.
  const original = globalThis.fetch;
  const body = 'x'.repeat(4096);
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
  try {
    const provider = createFetchProvider({ maxBytes: 64, renderJs: 'off' });
    const result = await provider.fetch({ url: 'https://x.example/' });
    assert.equal(result.truncated, true);
    assert.equal(result.body.content.length, 64);
    assert.equal(result.body.kind, 'text');
  } finally {
    globalThis.fetch = original;
  }
});

test('the provider advertises the id the Host config selects', () => {
  assert.equal(createFetchProvider().id, 'http-proxy');
  assert.equal(createFetchProvider({ id: 'custom' }).id, 'custom');
  assert.equal(createFetchProvider().available(), true);
});
