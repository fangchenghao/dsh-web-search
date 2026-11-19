import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = process.argv[2] === undefined
  ? new URL('../src/cache-persist.ts', import.meta.url)
  : pathToFileURL(resolve(process.argv[2]));
const { serializeCache } = await import(moduleUrl.href);
const now = 1_700_000_000_000;
const entries = Array.from({ length: 100 }, (_, index) => ({
  key: `query-${index}`,
  expiresAt: now + 60_000,
  sources: Array.from({ length: 8 }, (_, row) => ({
    url: `https://example.com/${index}/${row}`, title: `搜索结果 ${index}-${row}`, snippet: '文档搜索摘要'.repeat(32),
  })),
}));

for (const budget of [4 * 1024 * 1024, 64 * 1024]) {
  for (let warmup = 0; warmup < 10; warmup += 1) serializeCache(entries, now, budget);
  const samples = [];
  for (let run = 0; run < 41; run += 1) {
    const started = performance.now();
    serializeCache(entries, now, budget);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const snapshot = serializeCache(entries, now, budget);
  console.log(`${budget / 1024} KiB: ${snapshot.entries}/${entries.length} entries, ${snapshot.bytes} bytes, median ${samples[20].toFixed(3)} ms`);
}
