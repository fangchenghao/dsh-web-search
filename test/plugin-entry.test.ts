/**
 * The shape the Host reads the config schema from.
 *
 * `dsh-settings` resolves a plugin's schema as `entry.fiber.runtime.Config`, and
 * for a function-style plugin the runtime is that function. A named `Config`
 * export is therefore invisible to it: the settings document drops the row
 * before it checks the schema, and Settings shows nothing even though the schema
 * is valid and three separate fixes had already corrected everything downstream.
 *
 * @module dsh-web-search-bing/test/plugin-entry
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import pluginDefault, { Config, apply } from '../src/index.ts';

test('the default export is the apply function, so the Loader has one plugin to mount', () => {
  assert.equal(typeof pluginDefault, 'function');
  assert.equal(pluginDefault, apply, 'the default export must be the same function, not a copy');
});

test('the runtime carries Config, which is how the Host finds the settings schema', () => {
  const carrier = pluginDefault as unknown as { Config?: unknown };
  assert.equal(carrier.Config, Config, 'default.Config must be the Config schema');
  const schema = carrier.Config as { toJSON?: unknown } | undefined;
  // dsh-settings accepts the schema only when it has toJSON.
  assert.equal(typeof schema?.toJSON, 'function', 'the Host requires `toJSON` on the schema');
});
