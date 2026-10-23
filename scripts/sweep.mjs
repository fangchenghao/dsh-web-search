#!/usr/bin/env node
/**
 * Sweep the ranking knobs over the recorded corpus and report what the data can
 * actually support.
 *
 * Each configuration is evaluated by `scripts/bench.mjs` in its offline replay
 * mode, so a sweep costs seconds and never touches the network. The corpus is
 * twenty queries: differences below roughly 0.04 MRR are inside the noise, and
 * the paired bootstrap at the end says so instead of letting a leaderboard
 * imply significance it does not have.
 *
 * Usage:
 *   node scripts/sweep.mjs            # full 81-configuration matrix
 *   node scripts/sweep.mjs --quick    # 27 configurations, rrf and freshness only
 *   node scripts/sweep.mjs --json     # machine-readable result
 *
 * @module dsh-web-search-bing/scripts/sweep
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bench = join(here, 'bench.mjs');
const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const asJson = argv.includes('--json');

/** The grid: each entry is one knob value vector. */
const axis = {
  rrf: [40, 60, 80],
  authority: [0.1, 0.25, 0.4],
  freshness: [0.1, 0.2, 0.35],
  anysearch: quick ? [2] : [1, 2, 3],
};

/** The shipped defaults, used as the comparison baseline. */
const DEFAULTS = { rrf: 60, authority: 0.25, freshness: 0.2, anysearch: 2 };

/** Run one configuration and return its parsed result. */
function evaluate(rrf, authority, freshness, anysearch) {
  const args = [
    bench,
    '--json',
    '--rrf', String(rrf),
    '--authority-boost', String(authority),
    '--freshness-boost', String(freshness),
    '--weight', `anysearch=${anysearch}`,
    '--label', `r${rrf}-a${authority}-f${freshness}-w${anysearch}`,
  ];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`bench failed for ${args.join(' ')}\n${run.stderr ?? ''}`);
  return JSON.parse(run.stdout);
}

/** Mean of the numbers. */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Paired bootstrap over per-query reciprocal ranks. */
function bootstrap(a, b, rounds = 5000, seed = 7) {
  const ids = Object.keys(a).filter((id) => id in b);
  const diffs = ids.map((id) => b[id] - a[id]);
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const means = [];
  for (let round = 0; round < rounds; round += 1) {
    let total = 0;
    for (let i = 0; i < diffs.length; i += 1) total += diffs[Math.floor(random() * diffs.length)];
    means.push(total / diffs.length);
  }
  means.sort((x, y) => x - y);
  return {
    delta: mean(diffs),
    low: means[Math.floor(0.025 * rounds)],
    high: means[Math.floor(0.975 * rounds)],
  };
}

const results = [];
for (const rrf of axis.rrf) {
  for (const authority of axis.authority) {
    for (const freshness of axis.freshness) {
      for (const anysearch of axis.anysearch) {
        const data = evaluate(rrf, authority, freshness, anysearch);
        results.push({
          config: { rrf, authority, freshness, anysearch },
          label: data.label,
          precision: data.overall.precision,
          recall: data.overall.recall,
          mrr: data.overall.mrr,
          rr: Object.fromEntries(data.queries.map((q) => [q.id, q.rr])),
        });
      }
    }
  }
}

const key = (c) => `r${c.rrf}-a${c.authority}-f${c.freshness}-w${c.anysearch}`;
const baseline = results.find((r) => key(r.config) === key(DEFAULTS));
const ranked = [...results].sort((a, b) => b.mrr - a.mrr);

const marginals = {};
for (const knob of Object.keys(axis)) {
  marginals[knob] = axis[knob].map((value) => {
    const subset = results.filter((r) => r.config[knob] === value);
    return {
      value,
      mrr: mean(subset.map((r) => r.mrr)),
      precision: mean(subset.map((r) => r.precision)),
      recall: mean(subset.map((r) => r.recall)),
    };
  });
}

const report = {
  schemaVersion: 1,
  corpus: results.length,
  baseline: baseline === undefined ? null : {
    label: baseline.label,
    precision: baseline.precision,
    recall: baseline.recall,
    mrr: baseline.mrr,
  },
  leaderboard: ranked.slice(0, 5).map((r) => ({
    label: r.label,
    precision: r.precision,
    recall: r.recall,
    mrr: r.mrr,
    ...bootstrap(baseline.rr, r.rr),
  })),
  marginals,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const line = (cells) => cells.map((cell) => String(cell).padStart(8)).join(' ');
  process.stdout.write(`corpus: 20 queries at k=8 (offline replay)\n\n`);
  process.stdout.write(`baseline ${baseline.label}: P@8=${baseline.precision.toFixed(4)} R@8=${baseline.recall.toFixed(4)} MRR=${baseline.mrr.toFixed(4)}\n\n`);
  process.stdout.write(`top 5 by MRR, with the delta against the baseline (paired bootstrap):\n`);
  process.stdout.write(`${line(['config', 'P@8', 'R@8', 'MRR', 'delta', '95% CI'])}\n`);
  for (const row of report.leaderboard) {
    const delta = `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(4)}`;
    const ci = `[${row.low.toFixed(4)}, ${row.high.toFixed(4)}]`;
    process.stdout.write(`${line([row.label, row.precision.toFixed(4), row.recall.toFixed(4), row.mrr.toFixed(4), delta, ci])}\n`);
  }
  process.stdout.write(`\nmarginal means over the whole grid:\n`);
  for (const [knob, rows] of Object.entries(marginals)) {
    for (const row of rows) {
      process.stdout.write(`  ${knob.padEnd(10)} ${String(row.value).padEnd(6)} MRR=${row.mrr.toFixed(4)} P@8=${row.precision.toFixed(4)} R@8=${row.recall.toFixed(4)}\n`);
    }
  }
  process.stdout.write(`\nA confidence interval that straddles zero means the corpus cannot tell these configurations apart.\n`);
}
