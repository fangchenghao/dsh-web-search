/**
 * The settings-page half, loaded the way the browser loads it: through the
 * module-loader shim, with the services Cordis would inject.
 *
 * These tests exist because the page shipped once with `configForms` missing
 * from its inject list. Cordis only exposes a declared service, so the page read
 * `undefined`, took its "not available" branch, and rendered nothing — while the
 * navigation entry it had registered still appeared. Only a mount test catches
 * that: the file parses, the slot registration is valid, and the page is simply
 * empty.
 *
 * @module dsh-web-search-bing/test/client-card
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

/** The nineteen configurable keys, in the order the page renders them. */
const KEYS = [
  'hosts', 'wait', 'timeoutMs', 'proxy', 'anysearchApiKey', 'anysearchDomain',
  'limit', 'rrfConstant', 'authorityDomains', 'authorityBoost', 'freshnessBoost', 'freshnessDays',
  'cacheTtlMs', 'cacheEntries', 'baseCooldownMs', 'maxCooldownMs',
  'domainSources', 'domainLimit', 'domainTimeoutMs',
] as const;

/** One rendered element, after function components have been expanded. */
interface Element {
  type?: unknown;
  props?: Record<string, unknown>;
}

/** A React stand-in that renders to plain data and runs effects immediately. */
function reactShim(): Record<string, unknown> {
  return {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children } };
    },
    useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [value, () => undefined];
    },
    useEffect(effect: () => void | (() => void)): void {
      effect();
    },
    useCallback<T>(fn: T): T {
      return fn;
    },
    useMemo<T>(fn: () => T): T {
      return fn();
    },
    useRef<T>(value: T): { current: T } {
      return { current: value };
    },
    Fragment: 'Fragment',
  };
}

/** Load client.js as the browser would, returning the registered factory. */
async function loadFactory(): Promise<Record<string, unknown>> {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let definition: { id?: string; factory?: (require: (name: string) => unknown) => unknown } | undefined;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (next: typeof definition) => {
          definition = next;
        },
      },
    },
    console: { warn: () => undefined },
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(definition !== undefined, 'client.js registered nothing with the module loader');
  assert.equal(definition.id, 'dsh-web-search-bing');
  const React = reactShim();
  const factory = definition.factory;
  assert.equal(typeof factory, 'function');
  return factory((name: string) => (name === 'react' ? React : undefined)) as Record<string, unknown>;
}

/** The values the page shows when the namespace has never been edited. */
function defaultValues(): Record<string, unknown> {
  return {
    hosts: [],
    wait: 'auto',
    proxy: '',
    limit: 8,
    timeoutMs: 15000,
    rrfConstant: 60,
    authorityDomains: [],
    authorityBoost: 0.25,
    freshnessBoost: 0.2,
    freshnessDays: 30,
    cacheTtlMs: 600000,
    cacheEntries: 100,
    baseCooldownMs: 300000,
    maxCooldownMs: 1800000,
    domainSources: ['github', 'npm', 'pypi', 'arxiv', 'wikipedia', 'hn', 'stackexchange', 'crates'],
    domainLimit: 5,
    domainTimeoutMs: 8000,
  };
}

/** A form handle backed by a mutable snapshot, as `configForms` returns one. */
function fakeForm(): Record<string, unknown> {
  let value = defaultValues();
  return {
    getSnapshot: () => ({ status: 'ready', value, revision: 1, writable: true }),
    subscribe: () => () => undefined,
    mutate: async (operations: unknown) => {
      for (const op of operations as { path: string[]; value: unknown }[]) {
        value = { ...value, [op.path[0] as string]: op.value };
      }
      return true;
    },
  };
}

/** The context Cordis would hand the page, optionally without the service. */
function fakeContext(
  registered: { options: Record<string, unknown>; component: (props: unknown) => unknown }[],
  withService: boolean,
): Record<string, unknown> {
  return {
    slots: {
      inject: (_slot: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registered.push({ options, component });
        return () => undefined;
      },
    },
    locale: { bind: () => (key: string) => key, register: () => () => undefined },
    ...(withService
      ? {
          configForms: {
            get: () => fakeForm(),
            whileServed: (_keys: string[], cb: () => unknown) => cb(),
            // The page derives its namespace from the served projection, so the
            // fake mirrors the shipped shape: a snapshot store plus ensure().
            mirror: {
              getSnapshot: () => ({ view: { namespaces: [{ ns: 'web-search-bing' }] } }),
              subscribe: () => () => undefined,
              ensure: () => undefined,
            },
          },
        }
      : {}),
    effect: (fn: () => unknown) => fn(),
  };
}

/** Expand function components into a flat element list. */
function flatten(node: unknown, out: Element[] = []): Element[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return out;
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  const element = node as Element;
  if (typeof element.type === 'function') {
    return flatten((element.type as (props: unknown) => unknown)(element.props ?? {}), out);
  }
  out.push(element);
  const children = element.props?.['children'];
  if (children !== undefined) flatten(children, out);
  return out;
}

/** Every string a tree renders. */
function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  const element = node as Element;
  if (typeof element.type === 'function') {
    return texts((element.type as (props: unknown) => unknown)(element.props ?? {}), out);
  }
  const children = element.props?.['children'];
  if (children !== undefined) texts(children, out);
  return out;
}

/** Mount the page and return its single registration. */
async function mount(withService: boolean): Promise<{
  options: Record<string, unknown>;
  render: () => unknown;
  inject: string[];
}> {
  const factory = await loadFactory();
  const registered: { options: Record<string, unknown>; component: (props: unknown) => unknown }[] = [];
  (factory.apply as (ctx: unknown) => void)(fakeContext(registered, withService));
  assert.equal(registered.length, 1, `expected one registration, saw ${registered.length}`);
  const first = registered[0] as { options: Record<string, unknown>; component: (props: unknown) => unknown };
  return {
    options: first.options,
    render: () => first.component({}),
    inject: factory.inject as string[],
  };
}

test('the page declares the configForms service it reads', async () => {
  const factory = await loadFactory();
  const inject = factory.inject as string[];
  assert.ok(Array.isArray(inject), 'the module must export an inject list');
  assert.ok(inject.includes('slots'), JSON.stringify(inject));
  assert.ok(inject.includes('locale'), JSON.stringify(inject));
  // Without this the service is undefined at runtime and the page is blank.
  assert.ok(inject.includes('configForms'), `configForms is missing from ${JSON.stringify(inject)}`);
});

test('mounting registers exactly one page into settings.section', async () => {
  const { options } = await mount(true);
  assert.equal(options['name'], 'settings.section');
  assert.equal(options['id'], 'web-search-bing');
  assert.equal(typeof options['label'], 'function');
});

test('a served namespace that is not ours produces a probe line, not a dead end', async () => {
  const registered: { options: Record<string, unknown>; component: (props: unknown) => unknown }[] = [];
  const ctx = fakeContext(registered, true);
  const forms = ctx['configForms'] as Record<string, unknown>;
  forms['mirror'] = {
    getSnapshot: () => ({ view: { namespaces: [{ ns: 'something-else' }] } }),
    subscribe: () => () => undefined,
    ensure: () => undefined,
  };
  const factory = await loadFactory();
  factory.apply(ctx);
  const rendered = texts(registered[0] === undefined ? null : (registered[0].component as (props: unknown) => unknown)({}));
  assert.ok(rendered.includes('loading'), `expected the loading note, got ${JSON.stringify(rendered)}`);
  assert.ok(
    rendered.some((text) => text.includes('something-else')),
    `expected the served namespaces to be shown, got ${JSON.stringify(rendered)}`,
  );
});

test('the page renders one control per configuration key', async () => {
  const { render } = await mount(true);
  const controls = flatten(render()).filter((element) => element.type === 'input' || element.type === 'select');
  assert.equal(controls.length, KEYS.length, `expected ${KEYS.length} controls, rendered ${controls.length}`);
});

test('the page shows the stored values, not just blanks', async () => {
  const { render } = await mount(true);
  const controls = flatten(render()).filter((element) => element.type === 'input' || element.type === 'select');
  const serialised = JSON.stringify(controls.map((control) => control.props?.['value'] ?? control.props?.['defaultValue']));
  for (const expected of ['15000', '600000', '300000', '1800000', '60', '0.25']) {
    assert.ok(serialised.includes(expected), `expected the stored value ${expected} in ${serialised}`);
  }
});

test('a deployment without the service renders the localized note instead of throwing', async () => {
  const { render } = await mount(false);
  const rendered = texts(render());
  assert.ok(rendered.includes('unavailable'), `expected the unavailable note, saw ${JSON.stringify(rendered)}`);
});
