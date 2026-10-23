import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');

/** Every `name:` value in a document, with surrounding quotes preserved. */
function nameScalars(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*name:\s*(.*)$/gm)].map((match) => (match[1] ?? '').trim());
}

test('the bundle patch quotes a scoped name, because YAML rejects a bare @', () => {
  const yaml = read('cordis.patch.yml');
  const names = nameScalars(yaml);
  assert.ok(names.length > 0, 'the overlay must name the plugin it inserts');
  for (const value of names) {
    if (value.startsWith('@')) {
      assert.match(value, /^['"]@/, `unquoted scoped name breaks the Host's YAML parse: ${value}`);
    }
  }
  const pkg = JSON.parse(read('package.json')) as { name: string };
  assert.ok(
    names.some((value) => value.replace(/^['"]|['"]$/g, '') === pkg.name),
    `the overlay should insert ${pkg.name}, found ${names.join(', ')}`,
  );
});

test('the overlay inserts the entry with the documented id and an empty config', () => {
  const yaml = read('cordis.patch.yml');
  assert.match(yaml, /id: web-search-bing/);
  assert.match(yaml, /config: \{\}/);
});

test('README YAML snippets quote the scoped name too', () => {
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const text = read(file);
    // A copy-pasted snippet that starts with a bare @ fails in the same way, so
    // the docs must not teach the broken form.
    const bare = [...text.matchAll(/^\s*name:\s*(@[^\s'"]+)$/gm)].map((match) => match[1]);
    assert.deepEqual(bare, [], `${file} shows an unquoted scoped name: ${bare.join(', ')}`);
  }
});
