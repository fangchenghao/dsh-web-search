/**
 * The Settings update button's loopback endpoint.
 *
 * The host plugin manager is a double here: these tests pin the safety rules
 * that matter when a button can run `pnpm add` — POST + loopback + same-origin,
 * one fixed package spec, no replacement of a link:/file: checkout, and an
 * explicit restart result.
 *
 * @module dsh-web-search-bing/test/update-bridge
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OWN_PACKAGE_NAME,
  UPDATE_BRIDGE_PATH,
  registerUpdateBridge,
} from '../src/bridge.ts';
import type { PluginManagerLike } from '../src/inject.ts';

interface Captured {
  status: number;
  body: string;
}

function response(): { response: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '' };
  const fake = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body: string) {
      captured.body = body;
    },
  };
  return { response: fake as unknown as ServerResponse, captured };
}

function request(
  body = '{}',
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

function manager(options: {
  source?: string;
  application?: 'applied' | 'restart-required' | 'failed' | 'cancelled';
  changed?: boolean;
} = {}): { manager: PluginManagerLike; calls: string[] } {
  const calls: string[] = [];
  const value: PluginManagerLike = {
    async listBundles() {
      return [{ name: OWN_PACKAGE_NAME, installed: true, source: options.source, version: '0.20.0' }];
    },
    async installBundle(spec) {
      calls.push(spec);
      return {
        changed: options.changed ?? true,
        application: options.application ?? 'restart-required',
        version: '0.20.1',
      };
    },
  };
  return { manager: value, calls };
}

function mount(
  value: PluginManagerLike | undefined,
  options: { hostGet?: boolean } = {},
): {
  path: string;
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  effects: number;
} {
  let route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> } | undefined;
  let effects = 0;
  const ctx = {
    inject(_deps: string[], callback: (context: Record<string, unknown>) => unknown) {
      callback({
        webServer: {
          register(candidate: typeof route) {
            route = candidate;
            return () => {};
          },
        },
        ...(value === undefined || options.hostGet === true ? {} : { pluginManager: value }),
        effect(fn: () => (() => void) | void) {
          effects += 1;
          fn();
        },
      });
    },
    ...(options.hostGet === true && value !== undefined ? { get: (name: string) => (name === 'pluginManager' ? value : undefined) } : {}),
  };
  const dispose = registerUpdateBridge(ctx as never);
  assert.equal(typeof dispose, 'function');
  assert.ok(route !== undefined);
  return { path: route.path, handler: route.handler, effects };
}

test('the update route installs only this package at latest and reports restart', async () => {
  const { manager: managerValue, calls } = manager();
  const { path, handler, effects } = mount(managerValue);
  assert.equal(path, UPDATE_BRIDGE_PATH);
  assert.equal(effects, 1);
  const { response: res, captured } = response();
  await handler(request(), res);
  assert.equal(captured.status, 200);
  assert.deepEqual(calls, [`${OWN_PACKAGE_NAME}@latest`]);
  const body = JSON.parse(captured.body) as { ok: boolean; restartRequired: boolean; version: string };
  assert.equal(body.ok, true);
  assert.equal(body.restartRequired, true);
  assert.equal(body.version, '0.20.1');
});

test('a link:/file: install is refused before the harness is asked to replace it', async () => {
  const { manager: managerValue, calls } = manager({ source: 'link:/Users/dp/plugin' });
  const { handler } = mount(managerValue);
  const { response: res, captured } = response();
  await handler(request(), res);
  assert.equal(captured.status, 409);
  assert.equal(calls.length, 0);
  const body = JSON.parse(captured.body) as { code: string };
  assert.equal(body.code, 'local-install');
});

test('a deployment without a plugin manager returns 503 instead of pretending to update', async () => {
  const { handler } = mount(undefined);
  const { response: res, captured } = response();
  await handler(request(), res);
  assert.equal(captured.status, 503);
  const body = JSON.parse(captured.body) as { code: string };
  assert.equal(body.code, 'manager-unavailable');
});

test('the manager can also be found through ctx.get', async () => {
  const { manager: managerValue, calls } = manager();
  const { handler } = mount(managerValue, { hostGet: true });
  const { response: res, captured } = response();
  await handler(request(), res);
  assert.equal(captured.status, 200);
  assert.deepEqual(calls, [`${OWN_PACKAGE_NAME}@latest`]);
});

test('GET, remote callers and cross-origin callers are rejected before install', async () => {
  const { manager: managerValue, calls } = manager();
  const { handler } = mount(managerValue);
  for (const candidate of [
    request('', { method: 'GET' }),
    request('{}', { remote: '10.0.0.7' }),
    request('{}', { origin: 'https://evil.example' }),
  ]) {
    const { response: res, captured } = response();
    await handler(candidate, res);
    assert.ok([403, 405].includes(captured.status), `unexpected ${captured.status}`);
  }
  assert.equal(calls.length, 0);
});

test('a malformed body is rejected before install', async () => {
  const { manager: managerValue, calls } = manager();
  const { handler } = mount(managerValue);
  const { response: res, captured } = response();
  await handler(request('{not json'), res);
  assert.equal(captured.status, 400);
  assert.equal(calls.length, 0);
});

test('a failed manager result is surfaced as an error, not as success', async () => {
  const { manager: managerValue } = manager({ application: 'failed' });
  const { handler } = mount(managerValue);
  const { response: res, captured } = response();
  await handler(request(), res);
  assert.equal(captured.status, 502);
  const body = JSON.parse(captured.body) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('the route is a no-op when the host cannot inject a web server', () => {
  const dispose = registerUpdateBridge({} as never);
  assert.equal(dispose, undefined);
});
