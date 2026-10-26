/**
 * The Settings bridge is a narrow HTTP surface; these tests pin its guards
 * (POST-only, loopback-only, same-origin) and the shape the client button reads.
 *
 * @module dsh-web-search-bing/test/bridge
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ENGINE_TEST_BRIDGE_PATH, registerEngineTestBridge } from '../src/bridge.ts';
import type { EngineTestOutcome, EngineTestRunner } from '../src/engine-test.ts';

/** A captured response. */
interface Captured {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** A response stand-in with just the methods the bridge calls. */
function response(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '', headers: {} };
  const fake = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = { ...headers };
    },
    end(body: string) {
      captured.body = body;
    },
  };
  return { response: fake as unknown as ServerResponse, captured };
}

/** A request stand-in with a JSON body. */
function request(
  body: string,
  options: { method?: string; remote?: string; origin?: string; host?: string } = {},
): IncomingMessage {
  const bytes = Buffer.from(body, 'utf8');
  const fake = {
    method: options.method ?? 'POST',
    headers: {
      host: options.host ?? '127.0.0.1:3000',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
  return fake as unknown as IncomingMessage;
}

/** Register a bridge against a fake injectable host and return the route. */
function mount(runTest: EngineTestRunner): {
  path: string;
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  effects: number;
} {
  let route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> } | undefined;
  let effects = 0;
  const ctx = {
    inject: (_deps: string[], callback: (context: {
      webServer: { register: (candidate: typeof route) => () => void };
      effect: (fn: () => (() => void) | void) => unknown;
    }) => unknown) => {
      callback({
        webServer: {
          register(candidate) {
            route = candidate;
            return () => {};
          },
        },
        effect(fn) {
          effects += 1;
          fn();
        },
      });
    },
  };
  const dispose = registerEngineTestBridge(ctx as never, runTest);
  assert.equal(typeof dispose, 'function');
  assert.ok(route !== undefined);
  return { path: route.path, handler: route.handler, effects };
}

/** One successful engine outcome. */
function success(): EngineTestOutcome {
  return {
    sources: [{ url: 'https://example.com/', title: 'Example' }],
    failureDetails: [],
    failures: [],
  };
}

/** A runner that remembers which engine it was asked about. */
function runner(seen: string[]): EngineTestRunner {
  return async (engine) => {
    seen.push(engine);
    return success();
  };
}

test('the bridge registers the documented path and calls the shared runner', async () => {
  const seen: string[] = [];
  const { path, handler } = mount(runner(seen));
  assert.equal(path, ENGINE_TEST_BRIDGE_PATH);
  const { response: res, captured } = response();
  await handler(request(JSON.stringify({ engine: 'exa', query: 'probe' })), res);
  assert.equal(captured.status, 200);
  assert.deepEqual(seen, ['exa']);
  const body = JSON.parse(captured.body) as { ok: boolean; value: { results: Array<{ engine: string; ok: boolean }> } };
  assert.equal(body.ok, true);
  assert.equal(body.value.results[0]?.engine, 'exa');
  assert.equal(body.value.results[0]?.ok, true);
});

test('without an engine the bridge tests every catalogue entry', async () => {
  const seen: string[] = [];
  const { handler } = mount(runner(seen));
  const { response: res, captured } = response();
  await handler(request('{}'), res);
  assert.equal(captured.status, 200);
  assert.equal(seen.length, 8);
});

test('a non-POST request is rejected with 405', async () => {
  const { handler } = mount(runner([]));
  const { response: res, captured } = response();
  await handler(request('', { method: 'GET' }), res);
  assert.equal(captured.status, 405);
});

test('a non-loopback caller is rejected with 403', async () => {
  const { handler } = mount(runner([]));
  const { response: res, captured } = response();
  await handler(request('{}', { remote: '10.0.0.7' }), res);
  assert.equal(captured.status, 403);
});

test('a cross-origin caller is rejected with 403', async () => {
  const { handler } = mount(runner([]));
  const { response: res, captured } = response();
  await handler(request('{}', { origin: 'https://evil.example' }), res);
  assert.equal(captured.status, 403);
});

test('an unknown engine is rejected before the runner starts', async () => {
  const seen: string[] = [];
  const { handler } = mount(runner(seen));
  const { response: res, captured } = response();
  await handler(request(JSON.stringify({ engine: 'made-up' })), res);
  assert.equal(captured.status, 400);
  assert.equal(seen.length, 0);
});

test('a malformed JSON body is rejected with 400', async () => {
  const { handler } = mount(runner([]));
  const { response: res, captured } = response();
  await handler(request('{not json'), res);
  assert.equal(captured.status, 400);
});

test('the bridge is a no-op when the host cannot inject a web server', () => {
  const dispose = registerEngineTestBridge({}, async () => success());
  assert.equal(dispose, undefined);
});

test('the route is mounted through effect so plugin disposal can release it', () => {
  const { effects } = mount(runner([]));
  assert.equal(effects, 1);
});
