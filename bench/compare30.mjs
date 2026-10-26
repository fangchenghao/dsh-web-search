#!/usr/bin/env node
/**
 * Public 30-query comparison against keyless Firecrawl and anonymous Exa.
 *
 * This measures what can be measured without a private relevance label:
 * availability, latency, unique domains, and whether a known official domain
 * appears in the top 8. It deliberately does not print a "quality winner":
 * search-result relevance is query-dependent and needs human labels.
 *
 * Usage:
 *   DSH_WEB_SEARCH_PROXY=http://127.0.0.1:7890 node bench/compare30.mjs
 *   node bench/compare30.mjs --out bench/compare30/results-2026-10-26.json
 *
 * Environment:
 *   DSH_WEB_SEARCH_PROXY  optional tunnel for all three providers
 *   ANYSEARCH_API_KEY     optional for the plugin arm
 *
 * @module bench/compare30
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../src/engines.ts';
import { parseExaMcp } from '../src/parsers.ts';
import { proxyGet } from '../src/proxy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_QUERIES = join(ROOT, 'bench', 'compare30', 'queries.json');
const DEFAULT_OUT = join(ROOT, 'bench', 'compare30', 'results.json');
const PROXY = process.env.DSH_WEB_SEARCH_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? undefined;
const LIMIT = 8;
const TIMEOUT_MS = 15_000;
const SLEEP_MS = (() => {
  const raw = Number(process.env.COMPARE_SLEEP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
})();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Parse `--flag value` and `--flag=value`. */
function args() {
  const out = { queries: DEFAULT_QUERIES, out: DEFAULT_OUT };
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    const [key, inline] = arg.split('=', 2);
    const value = inline ?? process.argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (inline === undefined) index += 1;
    if (key === '--queries') out.queries = resolve(value);
    else if (key === '--out') out.out = resolve(value);
    else throw new Error(`unknown option ${key}`);
  }
  return out;
}

/** Host without a leading www. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./iu, '').toLowerCase(); } catch { return ''; }
}

/** Whether a result is on the expected official host. */
function isOfficial(url, official) {
  const host = hostOf(url);
  const expected = official.replace(/^www\./iu, '').toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

/** Normalise one result list to the shared shape. */
function rows(raw, pick) {
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const row = pick(item);
    if (row === undefined || row.url === undefined || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
    if (out.length >= LIMIT) break;
  }
  return out;
}

/** Direct POST, then the tunnel when direct fails. */
async function postWithFallback(url, body, headers = {}) {
  const attempts = [];
  try {
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-web-search-compare/1', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    attempts.push({ route: 'direct', status: response.status, ms: Date.now() - started });
    if (response.ok) return { ok: true, status: response.status, text, route: 'direct', attempts };
  } catch (error) {
    attempts.push({ route: 'direct', error: error instanceof Error ? error.message : String(error), ms: TIMEOUT_MS });
  }
  if (PROXY === undefined) return { ok: false, attempts, error: 'no proxy configured' };
  try {
    const started = Date.now();
    const response = await proxyGet(url, {
      proxy: PROXY,
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-web-search-compare/1', ...headers },
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
    });
    attempts.push({ route: 'proxy', status: response.status, ms: Date.now() - started });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, text: response.text, route: 'proxy', attempts };
  } catch (error) {
    attempts.push({ route: 'proxy', error: error instanceof Error ? error.message : String(error), ms: TIMEOUT_MS });
    return { ok: false, attempts, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Run the plugin arm. */
async function runPlugin(query) {
  const started = Date.now();
  try {
    const outcome = await search(query, undefined, {
      limit: LIMIT,
      timeoutMs: TIMEOUT_MS,
      ...(PROXY === undefined ? {} : { proxy: PROXY }),
      ...(process.env.ANYSEARCH_API_KEY === undefined ? {} : { anysearchApiKey: process.env.ANYSEARCH_API_KEY }),
    });
    return {
      ok: outcome.sources.length > 0,
      ms: Date.now() - started,
      results: outcome.sources.slice(0, LIMIT).map((source) => ({ url: source.url, title: source.title, snippet: source.snippet })),
      failures: outcome.failures,
      route: outcome.proxy === undefined ? 'direct' : 'proxy',
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, results: [], failures: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Run the Firecrawl keyless arm. */
async function runFirecrawl(query) {
  const started = Date.now();
  const response = await postWithFallback('https://api.firecrawl.dev/v1/search', { query, limit: 10 });
  if (!response.ok) return { ok: false, ms: Date.now() - started, results: [], failures: [response.error ?? `HTTP ${response.status}`], attempts: response.attempts };
  try {
    const parsed = JSON.parse(response.text);
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    return {
      ok: data.length > 0,
      ms: Date.now() - started,
      results: rows(data, (item) => typeof item.url === 'string' ? { url: item.url, title: typeof item.title === 'string' ? item.title : undefined, snippet: typeof item.description === 'string' ? item.description : undefined } : undefined),
      failures: [],
      route: response.route,
      attempts: response.attempts,
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, results: [], failures: [`parse: ${error instanceof Error ? error.message : String(error)}`], attempts: response.attempts };
  }
}

/** Run the Exa anonymous MCP arm. */
async function runExa(query) {
  const started = Date.now();
  const response = await postWithFallback(
    'https://mcp.exa.ai/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: 10 } } },
    { accept: 'application/json, text/event-stream' },
  );
  if (!response.ok) return { ok: false, ms: Date.now() - started, results: [], failures: [response.error ?? `HTTP ${response.status}`], attempts: response.attempts };
  const sources = parseExaMcp(response.text, 'https://mcp.exa.ai/mcp');
  return {
    ok: sources.length > 0,
    ms: Date.now() - started,
    results: sources.slice(0, LIMIT).map((source) => ({ url: source.url, title: source.title, snippet: source.snippet })),
    failures: [],
    route: response.route,
    attempts: response.attempts,
  };
}

/** Aggregate one arm. */
function aggregate(arm) {
  const latencies = arm.results.map((item) => item.ms).sort((a, b) => a - b);
  const pct = (p) => latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  const answered = arm.results.filter((item) => item.ok).length;
  const official = arm.results.filter((item) => item.officialHit).length;
  return {
    queries: arm.results.length,
    answered,
    answerRate: arm.results.length === 0 ? 0 : answered / arm.results.length,
    officialHits: official,
    officialRate: arm.results.length === 0 ? 0 : official / arm.results.length,
    meanUniqueDomains: arm.results.length === 0 ? null : Number((arm.results.reduce((sum, item) => sum + item.uniqueDomains, 0) / arm.results.length).toFixed(2)),
    latencyMs: {
      mean: latencies.length === 0 ? null : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      p50: pct(50),
      p95: pct(95),
    },
    failures: arm.results.flatMap((item) => item.failures.map((failure) => ({ id: item.id, failure }))),
  };
}

/** Format a Markdown report. */
function report(data) {
  const providers = ['plugin', 'firecrawl', 'exa'];
  const lines = [
    '# 30-query keyless comparison',
    '',
    `Generated: ${data.generatedAt}`,
    '',
    '## Method',
    '',
    '- Same 30 queries, same top-8 budget, same machine and network route.',
    '- Plugin arm: `search()` with the current ranker, no cache, 15 s timeout.',
    '- Firecrawl arm: `POST https://api.firecrawl.dev/v1/search` keyless tier, direct then the configured tunnel.',
    '- Exa arm: anonymous MCP `web_search_exa`, direct then the configured tunnel.',
    '- Metrics are availability, latency, unique domains and whether a known official domain appears. They are not a human relevance grade; failures are listed below.',
    '- No API keys were used. Firecrawl/Exa can rate-limit or block by IP; that is part of the recorded result.',
    '',
    '## Summary',
    '',
    '| Provider | Answered | Official-domain hit | Mean unique domains | Mean ms | p50 ms | p95 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const key of providers) {
    const value = data.summary[key];
    lines.push(`| ${data.providers[key].label} | ${value.answered}/${value.queries} | ${value.officialHits}/${value.queries} | ${value.meanUniqueDomains ?? '—'} | ${value.latencyMs.mean ?? '—'} | ${value.latencyMs.p50 ?? '—'} | ${value.latencyMs.p95 ?? '—'} |`);
  }
  lines.push('', '## Per query', '', '| Query | Category | Plugin | Firecrawl | Exa | Plugin official |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of data.queries) {
    const cell = (key) => {
      const item = row[key];
      return item === undefined ? '—' : item.ok ? `${item.results.length} rows / ${item.ms}ms` : `FAIL: ${(item.failures[0] ?? 'no rows').slice(0, 80)}`;
    };
    lines.push(`| ${row.query.replace(/\|/gu, '\\|')} | ${row.category} | ${cell('plugin')} | ${cell('firecrawl')} | ${cell('exa')} | ${row.plugin.officialHit ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Failures and caveats', '');
  for (const key of providers) {
    const failures = data.summary[key].failures;
    lines.push(`### ${data.providers[key].label}`, '');
    if (failures.length === 0) lines.push('No failures recorded.');
    else for (const failure of failures.slice(0, 30)) lines.push(`- ${failure.id}: ${failure.failure}`);
    lines.push('');
  }
  lines.push('The result files are the evidence; rerun with `node bench/compare30.mjs` and keep the raw JSON. A single run is a snapshot, not a permanent ranking.');
  return `${lines.join('\n')}\n`;
}

const options = args();
const queries = JSON.parse(await readFile(options.queries, 'utf8'));
if (!Array.isArray(queries)) throw new Error('queries must be a JSON array');
const startedAt = new Date().toISOString();
const providers = {
  plugin: { label: 'dsh-web-search', runner: runPlugin },
  firecrawl: { label: 'Firecrawl keyless', runner: runFirecrawl },
  exa: { label: 'Exa anonymous', runner: runExa },
};
const data = { generatedAt: startedAt, proxy: PROXY ?? null, limit: LIMIT, queries: [], summary: {}, providers: Object.fromEntries(Object.entries(providers).map(([key, value]) => [key, { label: value.label }])) };
for (const [index, query] of queries.entries()) {
  const row = { id: query.id, lang: query.lang, category: query.category, query: query.query, official: query.official };
  for (const [key, provider] of Object.entries(providers)) {
    const result = await provider.runner(query.query);
    const officialRank = result.results.findIndex((item) => isOfficial(item.url, query.official));
    row[key] = {
      ...result,
      officialHit: officialRank >= 0,
      officialRank: officialRank < 0 ? null : officialRank + 1,
      uniqueDomains: new Set(result.results.map((item) => hostOf(item.url)).filter(Boolean)).size,
    };
  }
  data.queries.push(row);
  process.stdout.write(`[${String(index + 1).padStart(2, '0')}/${queries.length}] ${query.id}\n`);
  await sleep(SLEEP_MS);
}
for (const [key, provider] of Object.entries(providers)) {
  const arm = { results: data.queries.map((row) => ({ id: row.id, ...row[key] })) };
  data.summary[key] = aggregate(arm);
}
await writeFile(options.out, `${JSON.stringify(data, null, 2)}\n`);
await writeFile(options.out.replace(/\.json$/u, '.md'), report(data));
console.log(`wrote ${options.out} and ${options.out.replace(/\.json$/u, '.md')}`);
