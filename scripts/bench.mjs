#!/usr/bin/env node
/**
 * Offline retrieval benchmark for the web-search plugin.
 *
 * `--record` is the only mode that touches the network: it runs every query
 * through the plugin's `search()` exactly once (retrying once), rate-limited to
 * one query every 1.5 s, and stores each engine's raw list under
 * `bench/fixtures/<id>.json`. Evaluation (the default) reads those fixtures and
 * re-runs the current ranker, so changing `src/rank.ts` or the engine weights
 * produces a comparable score with no network and no cache.
 *
 * Usage:
 *   node scripts/bench.mjs --record
 *   node scripts/bench.mjs
 *   node scripts/bench.mjs --json --out bench/results/0.12.0.json
 *   node scripts/bench.mjs --rrf 40
 *   node scripts/bench.mjs --weight anysearch=1
 *
 * @module bench
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS, search } from '../src/engines.ts';
import { resolveConfig } from '../src/config.ts';
import { mergeRegions } from '../src/rank.ts';
import { preferWindow } from '../src/freshness.ts';
import {
  DEFAULT_K,
  aggregateScores,
  consensusSummary,
  engineStats,
  evaluateResults,
  normaliseDomain,
} from './lib/metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUERIES_PATH = join(ROOT, 'bench', 'queries.json');
const FIXTURE_DIR = join(ROOT, 'bench', 'fixtures');
const PACKAGE_PATH = join(ROOT, 'package.json');
const FIXTURE_BUDGET_BYTES = 400 * 1024;
const LANGUAGES = ['zh', 'en'];
const CATEGORIES = ['docs', 'release', 'package', 'news'];

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Print usage and exit. */
function usage() {
  console.log(`Usage: node scripts/bench.mjs [options]

Modes:
  --record               Fetch the 20 queries live and write bench/fixtures/*.json
  (default)              Evaluate the existing fixtures offline

Evaluation options:
  --json                 Print the machine-readable result instead of the table
  --out <path>           Also write the JSON result to <path>
  --compare <path>       Compare against a previously saved JSON result
  --label <text>         Label recorded in the JSON result
  --rrf <n>              Override rrfConstant (default 60)
  --weight <id=n>        Override one engine's slot weight; repeatable
  --authority-boost <n>  Override the authority multiplier
  --freshness-boost <n>  Override the freshness multiplier
  --freshness-days <n>   Override the freshness window
  --help                 Show this text

Recording options:
  --max-snippet <n>      Truncate stored snippets to n characters (0 = keep raw)

Examples:
  node scripts/bench.mjs --record
  node scripts/bench.mjs --json --out bench/results/0.12.0.json
  node scripts/bench.mjs --rrf 40
  node scripts/bench.mjs --weight anysearch=1
  node scripts/bench.mjs --compare bench/results/0.12.0.json`);
}

/** Parse `--flag value`, `--flag=value`, and repeatable `--weight`. */
function parseArgs(argv) {
  const options = {
    record: false,
    json: false,
    out: undefined,
    compare: undefined,
    label: undefined,
    rrf: undefined,
    weights: {},
    authorityBoost: undefined,
    freshnessBoost: undefined,
    freshnessDays: undefined,
    maxSnippet: 0,
    help: false,
  };
  const readValue = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const valueAt = (flag) => (inline !== undefined ? inline : readValue(flag, index));
    switch (name) {
      case '--record':
        options.record = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--out':
        options.out = valueAt('--out');
        if (inline === undefined) index += 1;
        break;
      case '--compare':
        options.compare = valueAt('--compare');
        if (inline === undefined) index += 1;
        break;
      case '--label':
        options.label = valueAt('--label');
        if (inline === undefined) index += 1;
        break;
      case '--rrf': {
        options.rrf = Number(valueAt('--rrf'));
        if (!Number.isFinite(options.rrf) || options.rrf <= 0) throw new Error('--rrf must be a positive number');
        if (inline === undefined) index += 1;
        break;
      }
      case '--weight': {
        const spec = valueAt('--weight');
        for (const pair of spec.split(',')) {
          const [id, raw] = pair.split('=');
          const weight = Number(raw);
          if (typeof id !== 'string' || id.trim() === '' || !Number.isFinite(weight) || weight < 0) {
            throw new Error(`--weight expects engine=n, got ${JSON.stringify(pair)}`);
          }
          options.weights[id.trim()] = weight;
        }
        if (inline === undefined) index += 1;
        break;
      }
      case '--authority-boost': {
        options.authorityBoost = Number(valueAt('--authority-boost'));
        if (!Number.isFinite(options.authorityBoost) || options.authorityBoost < 0) throw new Error('--authority-boost must be non-negative');
        if (inline === undefined) index += 1;
        break;
      }
      case '--freshness-boost': {
        options.freshnessBoost = Number(valueAt('--freshness-boost'));
        if (!Number.isFinite(options.freshnessBoost) || options.freshnessBoost < 0) throw new Error('--freshness-boost must be non-negative');
        if (inline === undefined) index += 1;
        break;
      }
      case '--freshness-days': {
        options.freshnessDays = Number(valueAt('--freshness-days'));
        if (!Number.isFinite(options.freshnessDays) || options.freshnessDays <= 0) throw new Error('--freshness-days must be positive');
        if (inline === undefined) index += 1;
        break;
      }
      case '--max-snippet': {
        options.maxSnippet = Number(valueAt('--max-snippet'));
        if (!Number.isFinite(options.maxSnippet) || options.maxSnippet < 0) throw new Error('--max-snippet must be non-negative');
        if (inline === undefined) index += 1;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${JSON.stringify(arg)}`);
    }
  }
  if (options.record && (options.json || options.out !== undefined || options.compare !== undefined || options.rrf !== undefined || Object.keys(options.weights).length > 0)) {
    throw new Error('--record cannot be combined with evaluation options');
  }
  return options;
}

/** Human-readable error text. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Read and validate the fixed corpus. */
async function loadQueries() {
  const raw = JSON.parse(await readFile(QUERIES_PATH, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('bench/queries.json must be an array');
  if (raw.length !== 20) throw new Error(`bench/queries.json must hold 20 queries, found ${raw.length}`);
  const ids = new Set();
  const languageCounts = {};
  const categoryCounts = {};
  const queries = raw.map((entry, index) => {
    const where = `bench/queries.json[${index}]`;
    if (entry === null || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const { id, query, language, category, expectedDomains } = entry;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) throw new Error(`${where}.id must be lower-case kebab-case`);
    if (ids.has(id)) throw new Error(`${where}.id ${JSON.stringify(id)} is duplicated`);
    ids.add(id);
    if (typeof query !== 'string' || query.trim() === '') throw new Error(`${where}.query must be non-empty`);
    if (!LANGUAGES.includes(language)) throw new Error(`${where}.language must be one of ${LANGUAGES.join(', ')}`);
    if (!CATEGORIES.includes(category)) throw new Error(`${where}.category must be one of ${CATEGORIES.join(', ')}`);
    if (!Array.isArray(expectedDomains) || expectedDomains.length < 1 || expectedDomains.length > 4) {
      throw new Error(`${where}.expectedDomains must hold 1 to 4 domains`);
    }
    const domains = expectedDomains.map((domain) => normaliseDomain(domain));
    if (domains.some((domain) => domain === '')) throw new Error(`${where}.expectedDomains contains an unusable domain`);
    languageCounts[language] = (languageCounts[language] ?? 0) + 1;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    return { id, query, language, category, expectedDomains: domains };
  });
  for (const language of LANGUAGES) {
    if (languageCounts[language] !== 10) throw new Error(`expected 10 ${language} queries, found ${languageCounts[language] ?? 0}`);
  }
  for (const category of CATEGORIES) {
    if ((categoryCounts[category] ?? 0) < 1) throw new Error(`category ${category} has no query`);
  }
  return { queries, languageCounts, categoryCounts };
}

/** Read the package version for the result header. */
async function packageVersion() {
  try {
    const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Write a file through a temporary name so an interrupted run leaves valid JSON. */
async function writeJsonAtomic(path, value, pretty = true) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`, 'utf8');
  await rename(temporary, path);
}

/** Clip a snippet when the caller explicitly accepts the size tradeoff. */
function clipSnippet(source, maxSnippet) {
  if (!Number.isFinite(maxSnippet) || maxSnippet <= 0) return source;
  if (typeof source.snippet !== 'string' || source.snippet.length <= maxSnippet) return source;
  return { ...source, snippet: source.snippet.slice(0, maxSnippet) };
}

/**
 * Record one query through the plugin's `search()`.
 * @param {any} query - corpus entry.
 * @param {any} config - resolved plugin defaults.
 * @param {number} maxSnippet - snippet limit, or 0 for raw.
 * @returns {Promise<any>} fixture.
 */
async function recordOne(query, config, maxSnippet) {
  let trace;
  const started = Date.now();
  const outcome = await search(query.query, undefined, {
    limit: DEFAULT_K,
    wait: config.wait,
    timeRange: config.timeRange,
    timeoutMs: config.timeoutMs,
    rank: config.rank,
    ...(config.proxy === undefined ? {} : { proxy: config.proxy }),
    trace: (snapshot) => {
      trace = snapshot;
    },
  });
  const elapsedMs = Date.now() - started;
  if (trace === undefined) throw new Error('search() returned without a trace snapshot');
  if (trace.cached) throw new Error('search() answered from cache; recording needs a fresh run');
  if (!Array.isArray(trace.answers) || trace.answers.length === 0) {
    throw new Error(`search() fused no engine answers (${outcome.failures.join('; ') || 'no failures reported'})`);
  }
  if (outcome.sources.length === 0) {
    throw new Error(`search() returned no sources (${outcome.failures.join('; ') || 'no failures reported'})`);
  }
  return {
    schemaVersion: 1,
    ok: true,
    id: query.id,
    query: query.query,
    language: query.language,
    category: query.category,
    expectedDomains: query.expectedDomains,
    recordedAt: new Date().toISOString(),
    elapsedMs,
    limit: trace.limit,
    lead: trace.lead,
    wait: trace.wait,
    timeRange: trace.timeRange,
    rank: trace.rank,
    usedProxy: outcome.proxy !== undefined,
    engines: trace.answers.map((answer) => ({
      id: answer.host.id,
      region: answer.host.region,
      ...(answer.host.weight === undefined ? {} : { weight: answer.host.weight }),
      tier: answer.host.tier,
      sources: answer.sources.map((source) => clipSnippet(source, maxSnippet)),
    })),
    finalUrls: outcome.sources.map((source) => source.url),
    failures: [...outcome.failures],
    ...(maxSnippet > 0 ? { snippetLimit: maxSnippet } : {}),
  };
}

/** `--record`: fetch the corpus, retry once, and write one fixture per id. */
async function record(options) {
  const { queries } = await loadQueries();
  const config = resolveConfig({}, undefined);
  await mkdir(FIXTURE_DIR, { recursive: true });
  const fixtures = [];
  let totalBytes = 0;
  console.log(`recording ${queries.length} queries with limit=${DEFAULT_K}, wait=${config.wait}, timeoutMs=${config.timeoutMs}${options.maxSnippet > 0 ? `, snippet<${options.maxSnippet}` : ''}`);
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    if (index > 0) await sleep(1500);
    let fixture;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        fixture = await recordOne(query, config, options.maxSnippet);
        break;
      } catch (error) {
        lastError = error;
        console.error(`  ${query.id}: attempt ${attempt}/2 failed: ${errorText(error)}`);
        if (attempt === 1) await sleep(1500);
      }
    }
    if (fixture === undefined) {
      fixture = {
        schemaVersion: 1,
        ok: false,
        id: query.id,
        query: query.query,
        language: query.language,
        category: query.category,
        expectedDomains: query.expectedDomains,
        recordedAt: new Date().toISOString(),
        limit: DEFAULT_K,
        wait: config.wait,
        timeRange: config.timeRange,
        attempts: 2,
        error: errorText(lastError),
        engines: [],
        finalUrls: [],
        failures: [],
      };
      console.error(`  ${query.id}: NO FIXTURE (recorded as ok=false)`);
    }
    const path = join(FIXTURE_DIR, `${query.id}.json`);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    await writeJsonAtomic(path, fixture);
    totalBytes += Buffer.byteLength(text);
    const engineSummary = fixture.ok
      ? `${fixture.engines.length} engines, ${fixture.engines.reduce((total, engine) => total + engine.sources.length, 0)} rows -> ${fixture.finalUrls.length} final`
      : `missing: ${fixture.error}`;
    console.log(`[${String(index + 1).padStart(2, '0')}/${queries.length}] ${query.id} ${fixture.ok ? 'ok' : 'FAIL'} ${engineSummary}`);
    fixtures.push(fixture);
  }
  const okCount = fixtures.filter((fixture) => fixture.ok).length;
  console.log(`FIXTURES ${okCount}/${fixtures.length} recorded, ${(totalBytes / 1024).toFixed(1)} KiB (budget ${(FIXTURE_BUDGET_BYTES / 1024).toFixed(0)} KiB)`);
  if (okCount < fixtures.length) {
    console.error(`MISSING ${fixtures.length - okCount} fixture(s): ${fixtures.filter((fixture) => !fixture.ok).map((fixture) => fixture.id).join(', ')}`);
    process.exitCode = 1;
  }
  if (totalBytes > FIXTURE_BUDGET_BYTES) {
    console.error(`FIXTURE BUDGET EXCEEDED by ${((totalBytes - FIXTURE_BUDGET_BYTES) / 1024).toFixed(1)} KiB`);
    process.exitCode = 1;
  }
}

/** Build the rank options used for one evaluation run. */
function rankOptions(config, options) {
  return {
    ...config.rank,
    ...(options.rrf === undefined ? {} : { rrfConstant: options.rrf }),
    ...(options.authorityBoost === undefined ? {} : { authorityBoost: options.authorityBoost }),
    ...(options.freshnessBoost === undefined ? {} : { freshnessBoost: options.freshnessBoost }),
    ...(options.freshnessDays === undefined ? {} : { freshnessDays: options.freshnessDays }),
  };
}

/** Reconstruct a minimal host when a fixture names an engine this build dropped. */
function hostFor(recorded) {
  const current = HOSTS.find((host) => host.id === recorded.id);
  if (current !== undefined) return current;
  return {
    id: recorded.id,
    tier: recorded.tier ?? 'primary',
    region: recorded.region ?? 'global',
    ...(typeof recorded.weight === 'number' ? { weight: recorded.weight } : {}),
  };
}

/** Load one fixture, distinguishing "no fixture" from a valid empty result. */
async function loadFixture(query) {
  const path = join(FIXTURE_DIR, `${query.id}.json`);
  if (!existsSync(path)) return { ok: false, reason: 'no fixture file' };
  let fixture;
  try {
    fixture = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${errorText(error)}` };
  }
  if (fixture === null || typeof fixture !== 'object') return { ok: false, reason: 'fixture is not an object' };
  if (fixture.ok !== true) return { ok: false, reason: fixture.error ?? 'recorded as ok=false' };
  if (!Array.isArray(fixture.engines) || fixture.engines.length === 0) return { ok: false, reason: 'fixture has no engine lists' };
  if (fixture.id !== query.id) return { ok: false, reason: `fixture id ${JSON.stringify(fixture.id)} does not match ${query.id}` };
  if (fixture.query !== query.query) return { ok: false, reason: 'fixture query does not match queries.json; re-record it' };
  const recordedAt = typeof fixture.recordedAt === 'string' ? Date.parse(fixture.recordedAt) : Number.NaN;
  if (!Number.isFinite(recordedAt)) return { ok: false, reason: 'fixture has no usable recordedAt' };
  return { ok: true, fixture };
}

/** Evaluate one query from its fixture with the current ranker. */
function evaluateOne(query, fixture, config, options) {
  const answers = fixture.engines.map((engine) => ({
    host: hostFor(engine),
    sources: Array.isArray(engine.sources) ? engine.sources : [],
  }));
  const rank = rankOptions(config, options);
  if (Object.keys(options.weights).length > 0) {
    // `weights` is indexed like `answers`, so fill every slot: an override for
    // one engine must not reset the others to 1.
    rank.weights = answers.map((answer) => options.weights[answer.host.id] ?? answer.host.weight ?? 1);
  }
  const limit = DEFAULT_K;
  const lead = fixture.lead === 'cn' || fixture.lead === 'global' ? fixture.lead : query.language === 'zh' ? 'cn' : 'global';
  // Pin freshness to the recording instant. Without this, a fixture replayed
  // weeks later would score differently even though neither the engine rows
  // nor the ranking code changed.
  const recordedAt = typeof fixture.recordedAt === 'string' ? Date.parse(fixture.recordedAt) : Number.NaN;
  if (Number.isFinite(recordedAt)) rank.now = recordedAt;
  const fused = mergeRegions(answers, lead, limit, rank);
  const sources = preferWindow(fused, config.timeRange, Number.isFinite(recordedAt) ? recordedAt : Date.now());
  const score = evaluateResults(sources, query.expectedDomains, limit);
  const stats = engineStats(
    answers.map((answer) => ({ engineId: answer.host.id, sources: answer.sources })),
    sources,
    limit,
  );
  return {
    id: query.id,
    query: query.query,
    language: query.language,
    category: query.category,
    expectedDomains: query.expectedDomains,
    lead,
    limit,
    resultCount: sources.length,
    hits: score.hits,
    precision: score.precision,
    recall: score.recall,
    rr: score.rr,
    firstHitRank: score.firstHitRank,
    matchedDomains: score.matchedDomains,
    resultUrls: sources.map((source) => source.url),
    votes: stats.totals.votes,
    contributions: {
      totals: stats.totals,
      engines: stats.engines,
      rows: stats.rows.map((row) => ({ url: row.url, votes: row.votes, engines: row.engines })),
    },
  };
}

/** Group metric rows and aggregate each group. */
function group(rows, key) {
  const groups = {};
  for (const row of rows) {
    const name = row[key];
    if (name === undefined) continue;
    (groups[name] ??= []).push(row);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, aggregateScores(list)]));
}

/** Aggregate per-engine contribution and consensus counts. */
function aggregateEngines(rows) {
  const engines = {};
  const allContributionRows = [];
  for (const row of rows) {
    allContributionRows.push(...row.contributions.rows);
    for (const [id, stats] of Object.entries(row.contributions.engines)) {
      const bucket = (engines[id] ??= { answered: 0, returned: 0, contributed: 0, first: 0 });
      bucket.returned += stats.returned;
      bucket.contributed += stats.contributed;
      bucket.first += stats.first;
      // `answered` is per query, not per row: an engine that returned any source.
      if (stats.returned > 0) bucket.answered += 1;
    }
  }
  const consensus = consensusSummary(allContributionRows);
  const n = rows.length;
  for (const bucket of Object.values(engines)) {
    bucket.contributedShare = n === 0 ? 0 : bucket.contributed / (n * DEFAULT_K);
  }
  return { engines, consensus };
}

/** Load a previous result and compute metric deltas. */
async function comparison(path, current) {
  const previous = JSON.parse(await readFile(path, 'utf8'));
  if (previous === null || typeof previous !== 'object' || previous.overall === undefined) {
    throw new Error(`${path} is not a bench result (missing overall)`);
  }
  const metricDelta = (before, after) => ({
    before: before ?? 0,
    after: after ?? 0,
    delta: (after ?? 0) - (before ?? 0),
  });
  const metricBlock = (before, after) => ({
    precision: metricDelta(before?.precision, after?.precision),
    recall: metricDelta(before?.recall, after?.recall),
    mrr: metricDelta(before?.mrr, after?.mrr),
    zeroHit: metricDelta(before?.zeroHit, after?.zeroHit),
  });
  const byLanguage = {};
  for (const language of LANGUAGES) {
    if (previous.byLanguage?.[language] === undefined && current.byLanguage?.[language] === undefined) continue;
    byLanguage[language] = metricBlock(previous.byLanguage?.[language], current.byLanguage?.[language]);
  }
  const byCategory = {};
  for (const category of CATEGORIES) {
    if (previous.byCategory?.[category] === undefined && current.byCategory?.[category] === undefined) continue;
    byCategory[category] = metricBlock(previous.byCategory?.[category], current.byCategory?.[category]);
  }
  return {
    path,
    label: previous.label ?? null,
    generatedAt: previous.generatedAt ?? null,
    previousConfig: previous.config ?? null,
    overall: metricBlock(previous.overall, current.overall),
    byLanguage,
    byCategory,
  };
}

/** Print the evaluation table and summary. */
function printReport(result) {
  const header = `Benchmark ${result.corpus.evaluated}/${result.corpus.total} queries, k=${result.k}, version ${result.version}`;
  console.log(header);
  console.log(`Ranking rrfConstant=${result.config.rrfConstant} authorityBoost=${result.config.authorityBoost} freshnessBoost=${result.config.freshnessBoost} freshnessDays=${result.config.freshnessDays}${Object.keys(result.config.weightOverrides).length > 0 ? ` weights=${JSON.stringify(result.config.weightOverrides)}` : ''}`);
  console.log('');
  console.log('id                      lang cat      P@8    R@8    RR     hit first votes');
  for (const row of result.queries) {
    const first = row.firstHitRank === 0 ? '-' : String(row.firstHitRank);
    console.log(
      `${row.id.padEnd(23)} ${row.language.padEnd(4)} ${row.category.padEnd(8)} ${row.precision.toFixed(3)}  ${row.recall.toFixed(3)}  ${row.rr.toFixed(3)}  ${String(row.hits).padStart(3)} ${first.padStart(5)} ${String(row.votes).padStart(5)}`,
    );
  }
  console.log('');
  for (const language of LANGUAGES) {
    const block = result.byLanguage[language];
    if (block === undefined) continue;
    console.log(`LANG ${language}  P@8=${block.precision.toFixed(4)} R@8=${block.recall.toFixed(4)} MRR@8=${block.mrr.toFixed(4)} n=${block.queries} zero_hit=${block.zeroHit}`);
  }
  for (const category of CATEGORIES) {
    const block = result.byCategory[category];
    if (block === undefined) continue;
    console.log(`CAT  ${category.padEnd(7)} P@8=${block.precision.toFixed(4)} R@8=${block.recall.toFixed(4)} MRR@8=${block.mrr.toFixed(4)} n=${block.queries} zero_hit=${block.zeroHit}`);
  }
  console.log('');
  console.log('engine                 answered returned contributed share  first');
  const engines = Object.entries(result.engines).sort((a, b) => b[1].contributed - a[1].contributed || a[0].localeCompare(b[0]));
  for (const [id, stats] of engines) {
    console.log(`${id.padEnd(22)} ${String(stats.answered).padStart(8)} ${String(stats.returned).padStart(8)} ${String(stats.contributed).padStart(11)} ${(stats.contributedShare * 100).toFixed(1).padStart(5)}% ${String(stats.first).padStart(6)}`);
  }
  const histogram = Object.entries(result.consensus.histogram)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([votes, count]) => `${votes}:${count}`)
    .join(' ');
  console.log(`CONSENSUS votes=${result.consensus.votes} rows=${result.consensus.rows} avg=${result.consensus.averageVotes.toFixed(3)} hist=${histogram}`);
  if (result.missingFixtures.length > 0) {
    for (const missing of result.missingFixtures) console.log(`MISSING ${missing.id}: ${missing.reason}`);
  }
  console.log('');
  for (const row of result.worst) {
    console.log(`WORST ${row.id} P@8=${row.precision.toFixed(3)} R@8=${row.recall.toFixed(3)} RR=${row.rr.toFixed(3)} hits=${row.hits}${row.hits === 0 ? ' (zero hit)' : ''}`);
  }
  console.log(`SUMMARY P@8=${result.overall.precision.toFixed(4)} R@8=${result.overall.recall.toFixed(4)} MRR@8=${result.overall.mrr.toFixed(4)} n=${result.overall.queries} zh=${result.byLanguage.zh?.queries ?? 0} en=${result.byLanguage.en?.queries ?? 0} zero_hit=${result.overall.zeroHit} missing=${result.missingFixtures.length}`);
}

/** Print deltas against a previous result. */
function printComparison(compare) {
  console.log('');
  console.log(`COMPARE ${compare.path} (${compare.label ?? 'unlabelled'})`);
  const blocks = [['overall', compare.overall], ...Object.entries(compare.byLanguage), ...Object.entries(compare.byCategory)];
  for (const [name, block] of blocks) {
    console.log(
      `${name.padEnd(10)} P@8 ${block.precision.before.toFixed(4)} -> ${block.precision.after.toFixed(4)} (${block.precision.delta >= 0 ? '+' : ''}${block.precision.delta.toFixed(4)})  R@8 ${block.recall.before.toFixed(4)} -> ${block.recall.after.toFixed(4)} (${block.recall.delta >= 0 ? '+' : ''}${block.recall.delta.toFixed(4)})  MRR@8 ${block.mrr.before.toFixed(4)} -> ${block.mrr.after.toFixed(4)} (${block.mrr.delta >= 0 ? '+' : ''}${block.mrr.delta.toFixed(4)})`,
    );
  }
}

/** Evaluate fixtures offline. */
async function evaluate(options) {
  const { queries, languageCounts, categoryCounts } = await loadQueries();
  const config = resolveConfig({}, undefined);
  const rows = [];
  const missingFixtures = [];
  for (const query of queries) {
    const loaded = await loadFixture(query);
    if (!loaded.ok) {
      missingFixtures.push({ id: query.id, reason: loaded.reason });
      continue;
    }
    rows.push(evaluateOne(query, loaded.fixture, config, options));
  }
  if (rows.length === 0) {
    throw new Error('no usable fixtures; run `node scripts/bench.mjs --record` first');
  }
  const overall = aggregateScores(rows);
  const byLanguage = group(rows, 'language');
  const byCategory = group(rows, 'category');
  const { engines, consensus } = aggregateEngines(rows);
  const worst = [...rows]
    .sort((a, b) => a.precision - b.precision || a.recall - b.recall || a.rr - b.rr || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((row) => ({
      id: row.id,
      query: row.query,
      language: row.language,
      category: row.category,
      precision: row.precision,
      recall: row.recall,
      rr: row.rr,
      hits: row.hits,
      firstHitRank: row.firstHitRank,
      resultUrls: row.resultUrls,
    }));
  const result = {
    schemaVersion: 1,
    mode: 'eval',
    label: options.label ?? null,
    generatedAt: new Date().toISOString(),
    version: await packageVersion(),
    k: DEFAULT_K,
    config: {
      source: 'src/config.ts defaults, current rank.ts',
      rrfConstant: options.rrf ?? config.rank.rrfConstant,
      authorityBoost: options.authorityBoost ?? config.rank.authorityBoost,
      freshnessBoost: options.freshnessBoost ?? config.rank.freshnessBoost,
      freshnessDays: options.freshnessDays ?? config.rank.freshnessDays,
      timeRange: config.timeRange,
      rankNow: 'fixture.recordedAt',
      weightOverrides: options.weights,
    },
    corpus: {
      total: queries.length,
      evaluated: rows.length,
      missing: missingFixtures.length,
      byLanguage: languageCounts,
      byCategory: categoryCounts,
    },
    overall,
    byLanguage,
    byCategory,
    engines,
    consensus,
    worst,
    missingFixtures,
    queries: rows,
  };
  if (options.compare !== undefined) {
    result.comparison = await comparison(options.compare, result);
  }
  if (options.out !== undefined) {
    await writeJsonAtomic(resolve(ROOT, options.out), result);
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
    if (result.comparison !== undefined) printComparison(result.comparison);
  }
}

/** Entry point. */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`bench: ${errorText(error)}`);
    usage();
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    usage();
    return;
  }
  if (options.record) {
    await record(options);
  } else {
    await evaluate(options);
  }
}

main().catch((error) => {
  console.error(`bench: ${errorText(error)}`);
  process.exitCode = 1;
});
