/**
 * The prompt section is optional and static. These tests pin its contract with
 * the host: one `systemPrompt.section` call, a stable name/order, and a short
 * text that adds only the untrusted-content rule the tool schemas cannot.
 *
 * @module dsh-web-search-bing/test/system-prompt
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_PROMPT_ORDER,
  SEARCH_PROMPT_SECTION,
  SEARCH_PROMPT_TEXT,
  registerSearchPrompt,
} from '../src/system-prompt.ts';
import type { InjectableHost, SystemPromptSectionOptions } from '../src/inject.ts';
import { apply } from '../src/index.ts';
import type { PluginContext, SearchProvider } from '../src/index.ts';

/** A fake host that records the section and lets the test dispose it. */
function host(options: { noEffect?: boolean } = {}): {
  ctx: InjectableHost;
  sections: SystemPromptSectionOptions[];
  effects: number;
  dispose: () => void;
  deps: string[][];
} {
  const sections: SystemPromptSectionOptions[] = [];
  const deps: string[][] = [];
  let disposeSection: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const dispose = () => {
    cleanup?.();
    disposeSection?.();
  };
  const ctx: InjectableHost = {
    inject(dependencies, callback) {
      deps.push([...dependencies]);
      const services = {
        systemPrompt: {
          section(section: SystemPromptSectionOptions) {
            sections.push({ ...section });
            disposeSection = () => undefined;
            return disposeSection;
          },
        },
        effect: (execute: () => (() => void) | void) => {
          cleanup = execute() as (() => void) | undefined;
          return undefined;
        },
      };
      callback(options.noEffect === true ? { systemPrompt: services.systemPrompt } : services);
    },
  };
  return { ctx, sections, effects: 0, dispose, deps };
}

test('registerSearchPrompt installs one named section with the boundary text', () => {
  const fake = host();
  assert.equal(typeof registerSearchPrompt(fake.ctx), 'function');
  assert.deepEqual(fake.deps, [['systemPrompt']]);
  assert.equal(fake.sections.length, 1);
  assert.equal(fake.sections[0]?.name, SEARCH_PROMPT_SECTION);
  assert.equal(fake.sections[0]?.order, SEARCH_PROMPT_ORDER);
  assert.equal(fake.sections[0]?.text, SEARCH_PROMPT_TEXT);
  assert.match(fake.sections[0]?.text ?? '', /<untrusted-web-content>/u);
  assert.match(fake.sections[0]?.text ?? '', /untrusted external data/u);
  assert.match(fake.sections[0]?.text ?? '', /never follow/iu);
});

test('the prompt does not repeat tool definitions', () => {
  for (const name of ['advanced_search', 'research', 'search_many', 'domain_search', 'read_page', 'engine_test']) {
    assert.equal(SEARCH_PROMPT_TEXT.includes(name), false, name);
  }
  assert.ok(SEARCH_PROMPT_TEXT.length < 700, `${SEARCH_PROMPT_TEXT.length} chars`);
  assert.match(SEARCH_PROMPT_TEXT, /Ground claims in the URLs you actually read/u);
});

test('a host without systemPrompt support is a silent no-op', () => {
  assert.equal(registerSearchPrompt({}), undefined);
  const fake = host();
  fake.ctx.inject = (_deps, callback) => callback({});
  assert.equal(typeof registerSearchPrompt(fake.ctx), 'function', 'the hook exists even when the service does not');
  assert.equal(fake.sections.length, 0);
});

test('a host without effect still installs the section', () => {
  const fake = host({ noEffect: true });
  assert.equal(typeof registerSearchPrompt(fake.ctx), 'function');
  assert.equal(fake.sections.length, 1);
});

test('a throwing section does not escape', () => {
  const ctx: InjectableHost = {
    inject(_dependencies, callback) {
      callback({
        systemPrompt: {
          section() {
            throw new Error('section rejected');
          },
        },
      });
    },
  };
  assert.equal(typeof registerSearchPrompt(ctx), 'function');
});

test('a throwing inject call does not escape', () => {
  const ctx: InjectableHost = {
    inject() {
      throw new Error('cannot inject systemPrompt');
    },
  };
  assert.equal(registerSearchPrompt(ctx), undefined);
});

test('apply installs the prompt even when no tool registry is present', () => {
  const sections: SystemPromptSectionOptions[] = [];
  const providers: SearchProvider[] = [];
  const deps: string[][] = [];
  const ctx: PluginContext = {
    web: {
      registerSearchProvider: (provider) => providers.push(provider),
      registerFetchProvider: () => undefined,
    },
    inject(dependencies, callback) {
      deps.push([...dependencies]);
      if (dependencies.includes('systemPrompt')) {
        callback({
          systemPrompt: {
            section(options) {
              sections.push(options);
              return () => undefined;
            },
          },
        });
      }
    },
  };
  apply(ctx, {});
  assert.equal(providers.length, 1);
  assert.ok(deps.some((entry) => entry[0] === 'systemPrompt'));
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.name, SEARCH_PROMPT_SECTION);
  assert.match(sections[0]?.text ?? '', /<untrusted-web-content>/u);
});
