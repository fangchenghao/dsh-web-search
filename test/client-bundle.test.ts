import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), 'utf8');

interface LoadOptions {
  id: string;
  factory?: (require: (name: string) => unknown) => unknown;
}

/** Run the browser half against a stub loader, returning what it registered. */
function loadClient(): { id: string; factory: (require: (name: string) => unknown) => unknown } {
  const captured: LoadOptions[] = [];
  const window = {
    __ModuleLoader__: {
      load: (options: LoadOptions) => {
        captured.push(options);
      },
    },
  };
  // The bundle is plain browser JavaScript; evaluating it with a stub window is
  // the only way to see the contract the Host checks at runtime.
  new Function('window', 'console', read('client.js'))(window, console);
  assert.equal(captured.length, 1, 'the bundle must register exactly once');
  const [options] = captured;
  assert.ok(options !== undefined);
  assert.equal(typeof options.factory, 'function');
  return { id: options.id, factory: options.factory };
}

test('the client bundle registers under the package name, not a nickname', () => {
  const pkg = JSON.parse(read('package.json')) as { name: string };
  const { id } = loadClient();
  // The Host rejects a bundle whose loader id differs from the package name:
  // "loaded without registering <name> via __ModuleLoader__.load".
  assert.equal(id, pkg.name);
});

test('the factory declares the services its page needs', () => {
  const { factory } = loadClient();
  const result = factory((request: string) => {
    if (request === 'react') return { createElement: () => ({}) };
    throw new Error(`unexpected require: ${request}`);
  }) as { inject?: string[] } | undefined;
  assert.ok(result !== undefined && result !== null);
  assert.deepEqual(result.inject, ['slots', 'locale', 'configForms']);
});
