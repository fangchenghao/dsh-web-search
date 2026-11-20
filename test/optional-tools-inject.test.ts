/**
 * The optional tool half must reach the registry through `ctx.inject`.
 *
 * Cordis refuses an undeclared service on both `ctx.get()` and `ctx.tools`
 * (`cannot get property "tools" without inject`). A host that tightened that
 * rule therefore made `readToolRegistry` return `undefined`, and the plugin
 * silently mounted without `web_tools` — the search provider and the prompt
 * section still arrived, so the loss looked like a settings problem.
 *
 * The dependency must stay optional: putting `tools` in `inject` would stop the
 * whole plugin, `web_search` included, from mounting on a deployment with no
 * tool registry. These tests pin both halves of that contract.
 *
 * @module dsh-web-search-bing/test/optional-tools-inject
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../src/index.ts';

/** A registry that records the tool names registered into it. */
function registry(names: string[]): { register: (definition: { name?: string }) => () => void } {
  return {
    register(definition) {
      if (typeof definition?.name === 'string') names.push(definition.name);
      return () => {};
    },
  };
}

/** The minimum `ctx.web` the provider registration needs. */
function webSeam(): {
  registerSearchProvider: () => void;
  registerFetchProvider: () => void;
} {
  return {
    registerSearchProvider: () => {},
    registerFetchProvider: () => {},
  };
}

test('`tools` is not a hard dependency, so a host without one still mounts web_search', () => {
  assert.ok(
    !inject.includes('tools'),
    'a hard `tools` dependency would stop web_search from mounting where no registry exists',
  );
});

test('a host that refuses ctx.get still gets the optional tools through ctx.inject', () => {
  const names: string[] = [];
  const tools = registry(names);
  const injections: string[][] = [];

  const ctx = {
    web: webSeam(),
    // The tightening under test: an undeclared service read throws.
    get: (name: string) => {
      throw new Error(`cannot get property "${name}" without inject`);
    },
    // `ctx.tools` is likewise unavailable, matching Cordis's proxy trap.
    get tools(): never {
      throw new Error('cannot get property "tools" without inject');
    },
    /** Optional injection: Cordis calls back with the resolved service. */
    inject: (deps: string[], callback: (services: { tools: unknown }) => unknown) => {
      injections.push(deps);
      callback({ tools } as never);
    },
  };

  apply(ctx as never, {});

  assert.ok(
    injections.some((deps) => deps.includes('tools')),
    `the registry must be requested through an optional injection, saw ${JSON.stringify(injections)}`,
  );
  assert.ok(
    names.includes('web_tools'),
    `the unified tool must be registered through the injected registry, got ${JSON.stringify(names)}`,
  );
});

test('a host that resolves ctx.get directly never pays for an extra injection', () => {
  const names: string[] = [];
  const injections: string[][] = [];

  const ctx = {
    web: webSeam(),
    get: (name: string) => (name === 'tools' ? registry(names) : undefined),
    inject: (deps: string[]) => {
      injections.push(deps);
    },
  };

  apply(ctx as never, {});

  assert.equal(
    injections.filter((deps) => deps.includes('tools')).length,
    0,
    'the synchronous path must not also arm a tools injection',
  );
  assert.ok(names.includes('web_tools'), 'the synchronous registry still registers the tools');
});

test('a host with neither path still mounts the search provider without throwing', () => {
  const ctx = { web: webSeam() };
  assert.doesNotThrow(() => apply(ctx as never, {}));
});
