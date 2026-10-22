/**
 * Live-editability of the configuration, as the Host defines it.
 *
 * The settings document does not serve every plugin Config. `dsh-settings`
 * keeps a namespace only when `volatileForm(schema)` returns a form, and that
 * helper keeps a namespace when a field carries `meta.volatile`. A schema
 * without a single `.volatile()` field is therefore silently absent from
 * Settings, which is exactly how this page shipped blank: the plugin was
 * loaded, its schema was valid, and the document still had no row for it.
 *
 * This test restates that filter so the mark cannot be dropped unnoticed.
 *
 * @module dsh-web-search-bing/test/config-live
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';
import { Config } from '../src/config.ts';

/** Child schemas, whether the implementation stores them in a Map or an object. */
function dictOf(schema: { dict?: unknown }): Record<string, { type?: string; meta?: { volatile?: boolean }; dict?: unknown }> {
  const dict = schema.dict;
  if (dict instanceof Map) return Object.fromEntries(dict as Map<string, never>);
  return (dict ?? {}) as Record<string, { type?: string; meta?: { volatile?: boolean } }>;
}

/** The Host's filter, restated: a plain form, or undefined when nothing is live. */
function volatileForm(schema: { type?: string; meta?: { volatile?: boolean }; dict?: unknown }): { fields: string[] } | undefined {
  if (schema.meta?.volatile === true) return { fields: ['*'] };
  if (schema.type !== 'object') return undefined;
  const kept = Object.entries(dictOf(schema)).filter(([, child]) => volatileForm(child) !== undefined);
  return kept.length === 0 ? undefined : { fields: kept.map(([key]) => key) };
}

test('every configuration field is marked live-editable, so Settings serves the row', () => {
  const form = volatileForm(Config as unknown as { type?: string; dict?: unknown });
  assert.ok(form !== undefined, 'the Host filters a schema with no volatile field out of the settings document');
  const marked = form.fields.filter((field) => field !== '*');
  assert.equal(marked.length, 16, `expected 16 live fields, saw ${String(marked.length)}: ${marked.join(', ')}`);
  for (const field of ['anysearchApiKey', 'anysearchDomain', 'wait', 'limit', 'proxy']) {
    assert.ok(marked.includes(field), `${field} must stay editable from Settings`);
  }
});

test('the filter itself discriminates, which is why the mark is required', () => {
  assert.equal(volatileForm({ type: 'object', dict: { a: z.string() } }), undefined, 'a plain field must be rejected');
  const live = volatileForm({ type: 'object', dict: { a: z.string().volatile() } });
  assert.deepEqual(live, { fields: ['a'] }, 'a volatile field must be accepted');
});
