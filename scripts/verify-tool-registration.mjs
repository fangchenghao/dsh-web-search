/**
 * Prove the `domain_search` and `search_many` definitions are accepted by the
 * host's real tool registry — not by a hand-written stand-in.
 *
 * `ToolRuntime.register()` is the installed registration API. The host ships it
 * inside `app.asar`, so it is not resolvable from this checkout; point this
 * script at a directory whose `node_modules` contains the matching published
 * packages:
 *
 *   npm install --legacy-peer-deps \
 *     @deepseek-ai/dsh-tools@0.2.1-rc.2 @deepseek-ai/cordis@~4.0.5 \
 *     @deepseek-ai/dsh-system-prompt@0.2.1-rc.2 @deepseek-ai/dsh-agent@0.2.1-rc.2 \
 *     @deepseek-ai/dsh-ptc-runtime@0.2.1-rc.2 @deepseek-ai/dsh-llm@0.2.1-rc.2 \
 *     @deepseek-ai/dsh-scope@0.2.1-rc.2 @deepseek-ai/dsh-session@0.2.1-rc.2 \
 *     @deepseek-ai/dsh-user-approval@0.2.1-rc.2 @deepseek-ai/dsh-sandbox@0.2.1-rc.2 \
 *     @deepseek-ai/dsh-sandbox-policy@0.2.1-rc.2 @deepseek-ai/dsh-working-directory@0.2.1-rc.2
 *   DSH_VERIFY_MODULES=/path/to/that/dir node scripts/verify-tool-registration.mjs
 *
 * It prints the registered definitions, the model-facing schemas the registry
 * projects, and the result of disposing each registration. Exit code 2 means
 * the host packages were not available, so nothing was proven — it is not a
 * pass.
 *
 * @module dsh-web-search-bing/scripts/verify-tool-registration
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve a published package from the verification install, if present. */
async function loadPackage(name) {
  try {
    return await import(name);
  } catch (error) {
    const base = process.env.DSH_VERIFY_MODULES;
    if (base === undefined || base.length === 0) throw error;
    const root = join(base, 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const entry = manifest.exports?.['.']?.default ?? manifest.main;
    if (typeof entry !== 'string') throw error;
    return import(pathToFileURL(join(root, entry)).href);
  }
}

async function main() {
  const { Context } = await loadPackage('@deepseek-ai/cordis');
  const SystemPrompt = (await loadPackage('@deepseek-ai/dsh-system-prompt')).default;
  const { ToolRuntime } = await loadPackage('@deepseek-ai/dsh-tools');
  const { createDomainToolDefinition } = await import('../src/domain-tool.ts');
  const { createSearchManyDefinition } = await import('../src/search-many.ts');

  // The same objects the plugin hands the registry: raw JSON Schema, required
  // arrays at object level, and `output: { schema, render }`.
  const definition = createDomainToolDefinition('domain_search', () => ({
    sourceIds: ['github'],
    limit: 3,
    timeoutMs: 1000,
  }));
  const batchDefinition = createSearchManyDefinition('search_many', async () => ({
    sources: [],
    failures: [],
    truncated: false,
  }));

  // Built exactly as the host builds it: systemPrompt is a hard inject of the
  // tool registry, and `tools` becomes available on the context through Cordis.
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRuntime);
  const tools = root.get('tools');
  if (tools === undefined) throw new Error('the host tool service did not mount');

  const dispose = tools.register(definition);
  const disposeBatch = tools.register(batchDefinition);
  const registered = tools.get('domain_search');
  const batch = tools.get('search_many');
  console.log('registered names:', [registered?.name, batch?.name].join(', '));
  console.log('projected schemas:', tools.schemas().map((schema) => schema.name).join(', '));
  console.log('domain parameter required:', JSON.stringify(registered?.parameters?.required));
  console.log('domain output required:', JSON.stringify(registered?.output?.schema?.required));
  console.log('batch parameter required:', JSON.stringify(batch?.parameters?.required));
  console.log('batch output required:', JSON.stringify(batch?.output?.schema?.required));
  console.log('batch item required:', JSON.stringify(batch?.parameters?.properties?.queries?.items));
  console.log('timeoutMs:', registered?.timeoutMs, batch?.timeoutMs);

  dispose();
  disposeBatch();
  console.log('after dispose:', [tools.get('domain_search')?.name, tools.get('search_many')?.name]
    .filter((name) => name !== undefined)
    .join(', ') || 'absent');
  console.log('projected after dispose:', tools.schemas().map((schema) => schema.name).join(', ') || 'absent');
  await root.fiber.dispose();
}

try {
  await main();
} catch (error) {
  console.error('verification could not run:', error instanceof Error ? error.message : error);
  console.error('set DSH_VERIFY_MODULES to a directory where @deepseek-ai/dsh-tools is installed');
  process.exit(2);
}
