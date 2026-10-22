/**
 * The contract every `.volatile()` mark imposes on this plugin.
 *
 * `dsh-settings` serves a namespace only when the schema has a volatile field,
 * but the mark is not passive: the Loader validates the row through
 * `Config['~standard'].validate`, and schemastery resolves each marked field to
 * a live `{ get }` reference. `apply` therefore receives references, never the
 * values. Calling `Config(...)` on that object again feeds `{ get }` to the
 * field's own validator, which is exactly the activation failure
 * `$.timeoutMs expected number but got [object Object]`.
 *
 * @module dsh-web-search-bing/test/config-live
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, resolveConfig } from '../src/config.ts';
import { apply } from '../src/index.ts';
import type { ConfigInput } from '../src/config.ts';

/** The config a profile patch carries for this plugin today. */
const RAW = { anysearchApiKey: 'as_sk_test', anysearchDomain: '' };

/** The Loader's own call: `@deepseek-ai/cordis` `resolveConfig` uses `~standard`. */
function loaderResolve(config: Record<string, unknown>): Record<string, unknown> {
  const result = Config['~standard'].validate(config);
  if ('issues' in result && result.issues !== undefined) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  return result.value as Record<string, unknown>;
}

test('the Loader hands over live references, and resolveConfig reads them out', () => {
  const handed = loaderResolve(RAW);
  assert.equal(typeof handed.timeoutMs, 'object', 'a marked field must arrive as a reference');

  const resolved = resolveConfig(handed as ConfigInput, undefined);
  assert.equal(resolved.timeoutMs, 15000, 'the default survives the handoff');
  assert.equal(resolved.anysearchApiKey, 'as_sk_test');
  assert.equal(resolved.anysearchDomain, '');
  assert.equal(resolved.limit, 8);
  assert.equal(resolved.wait, 'auto');
  assert.equal(resolved.hostIds, undefined);
  assert.equal(resolved.proxy, undefined);
});

test('a plain object still validates, and a partial one gets every default', () => {
  const resolved = resolveConfig({ timeoutMs: 2000 }, 3);
  assert.equal(resolved.timeoutMs, 2000);
  assert.equal(resolved.limit, 3, 'the caller budget is capped by the configured limit');
  assert.deepEqual(resolved.rank, {
    rrfConstant: 60,
    authorityBoost: 0.25,
    freshnessBoost: 0.2,
    freshnessDays: 30,
  });
  assert.equal(resolveConfig({}, undefined).cacheTtlMs, 600000);
  assert.equal(resolveConfig(undefined, undefined).timeoutMs, 15000);
});

test('an invalid plain value still fails with the offending path', () => {
  assert.throws(
    () => resolveConfig({ timeoutMs: 100 } as ConfigInput, undefined),
    /\$\.timeoutMs expected number >= 500 but got 100/,
  );
});

test('reading through the reference keeps a Settings commit visible without a restart', () => {
  // What the Loader does on a volatile-only patch change: it mutates the
  // reference in place (`cordis-plugin-loader` `Entry._commitVolatile`) and
  // never restarts the plugin, so a snapshot taken at mount would go stale.
  let current = 15000;
  const section = { timeoutMs: { get: () => current }, anysearchApiKey: 'as_sk_test' } as unknown as ConfigInput;
  assert.equal(resolveConfig(section, undefined).timeoutMs, 15000);

  current = 45000;
  assert.equal(resolveConfig(section, undefined).timeoutMs, 45000);
});

test('the settings gate sees volatile fields, so the namespace is served', () => {
  // `dsh-settings` `describe()` keeps a namespace only when
  // `volatileForm(Config)` is defined (`lib/types/schema.js:43`), which walks
  // `meta.volatile`. A marked *array* is not special: it resolves to a
  // reference wrapping the array, whose JSON form is `{}` — `plainConfig`
  // unwraps it before any form sees it (`schema.js:9-11`), so every key the
  // settings card draws is served and writable.
  const fields = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict;
  const marked = Object.entries(fields)
    .filter(([, schema]) => schema.meta?.volatile === true)
    .map(([key]) => key)
    .sort();
  assert.equal(marked.length, Object.keys(fields).length, 'every field must be editable, or the served form disagrees with the card');
  assert.deepEqual(marked, [
    'anysearchApiKey', 'anysearchDomain', 'authorityBoost', 'authorityDomains', 'baseCooldownMs',
    'cacheEntries', 'cacheTtlMs', 'freshnessBoost', 'freshnessDays', 'hosts', 'limit',
    'maxCooldownMs', 'proxy', 'rrfConstant', 'timeoutMs', 'wait',
  ]);
});

test('a marked array survives the handoff and its value is a real array', () => {
  const handed = loaderResolve({ ...RAW, hosts: ['ddg-html'], authorityDomains: ['example.com'] });
  // The reference's own JSON form is `{}`; that is the artifact, not the value.
  assert.equal(JSON.stringify(handed.hosts), '{}');
  assert.deepEqual((handed.hosts as { get: () => string[] }).get(), ['ddg-html']);

  const resolved = resolveConfig(handed as ConfigInput, undefined);
  assert.deepEqual(resolved.hostIds, ['ddg-html']);
  assert.deepEqual(resolved.rank.authorityDomains, ['example.com']);
  // Handed to the engine layer, which may sort or splice it.
  assert.notEqual(resolved.rank.authorityDomains, (handed.authorityDomains as { get: () => string[] }).get());
});

test('apply mounts on the Loader-shaped config instead of failing activation', () => {
  const registered: string[] = [];
  const ctx = {
    web: {
      registerSearchProvider: (provider: { id: string }) => registered.push(provider.id),
      registerFetchProvider: (provider: { id: string }) => registered.push(provider.id),
    },
  };
  // `unknown` is how the Loader hands the section to a function-style plugin.
  apply(ctx, loaderResolve(RAW));
  assert.deepEqual(registered, ['bing', 'http-proxy']);
});
