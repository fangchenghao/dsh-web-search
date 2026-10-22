/**
 * Live-editability, as the Host defines it, without costing correctness.
 *
 * `dsh-settings` serves a namespace only when a field carries `meta.volatile`,
 * but the mark is not passive: schemastery resolves a marked field to a `{ get }`
 * holder. A marked *array* resolves to `{}` and the Loader then rejects the whole
 * entry ("expected array but got [object Object]"), so arrays stay plain; marked
 * scalars must be read through the holder, which is what `resolveConfig` does.
 *
 * @module dsh-web-search-bing/test/config-live
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, resolveConfig } from '../src/config.ts';

type Field = { meta?: { volatile?: boolean } };

/** The schema's child fields, whether stored in a Map or a plain object. */
function fields(): Record<string, Field> {
  const dict = (Config as unknown as { dict?: Map<string, Field> | Record<string, Field> }).dict;
  return (dict instanceof Map ? Object.fromEntries(dict) : dict ?? {}) as Record<string, Field>;
}

test('every scalar is marked live-editable, so the Host serves the settings row', () => {
  const live = Object.entries(fields()).filter(([, field]) => field.meta?.volatile === true).map(([key]) => key);
  assert.equal(live.length, 14, `expected 14 live fields, saw ${String(live.length)}: ${live.join(', ')}`);
  for (const required of ['anysearchApiKey', 'anysearchDomain', 'wait', 'limit', 'proxy', 'timeoutMs']) {
    assert.ok(live.includes(required), `${required} must stay editable from Settings`);
  }
});

test('arrays are left unmarked, because a marked array fails validation', () => {
  for (const name of ['hosts', 'authorityDomains']) {
    assert.notEqual(fields()[name]?.meta?.volatile, true, `${name} must stay plain`);
  }
  assert.ok(Array.isArray(Config({}).hosts), 'hosts must still validate as an array');
  assert.ok(Array.isArray(Config({}).authorityDomains), 'authorityDomains must still validate as an array');
});

test('marked fields resolve to plain values with their defaults intact', () => {
  const empty = resolveConfig({}, undefined);
  assert.equal(empty.limit, 8);
  assert.equal(empty.timeoutMs, 15_000);
  assert.equal(empty.wait, 'auto');
  assert.equal(empty.anysearchApiKey, '', 'a marked string must not collapse to undefined');
  assert.equal(empty.cacheTtlMs, 600_000);

  const given = resolveConfig({ proxy: 'http://127.0.0.1:7890', limit: 5, anysearchDomain: 'academic' }, undefined);
  assert.equal(given.proxy, 'http://127.0.0.1:7890', 'a value passed through must survive the holder read');
  assert.equal(given.limit, 5);
  assert.equal(given.anysearchDomain, 'academic');
});
