/**
 * Live smoke for the key-free vertical sources.
 *
 * Not part of `npm test` and not run in CI: it really hits the network. Run it
 * after exporting a proxy if the network needs one:
 *
 *   https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 \
 *     node scripts/smoke-verticals.mjs [limit] [expanded|all]
 *
 * `expanded` limits the run to the sources added after the original eight;
 * `all` (the default) queries every source. Each source is queried on its own
 * so one broken endpoint cannot hide behind another. If the tunnel returns
 * nothing, the source is retried directly and the route is printed with the
 * result.
 *
 * @module dsh-web-search-bing/scripts/smoke-verticals
 */
import { DEFAULT_VERTICAL_IDS, VERTICAL_IDS, searchVerticals } from '../src/verticals.ts';
import { resolveProxy } from '../src/proxy.ts';

/** One query that each endpoint is known to answer. */
const QUERIES = {
  github: 'react',
  npm: 'react',
  pypi: 'requests',
  arxiv: 'large language model',
  wikipedia: 'React',
  hn: 'react',
  stackexchange: 'react hooks',
  crates: 'serde',
  githubissues: 'kubernetes',
  gitlab: 'kubernetes',
  codeberg: 'kubernetes',
  dockerhub: 'kubernetes',
  maven: 'kubernetes',
  nuget: 'kubernetes',
  rubygems: 'kubernetes',
  packagist: 'kubernetes',
  pubdev: 'kubernetes',
  huggingface: 'react',
  hfdatasets: 'react',
  openvsx: 'react',
  terraform: 'kubernetes',
  terraformproviders: 'kubernetes',
  wordpress: 'kubernetes',
  jetbrains: 'kubernetes',
  openalex: 'kubernetes',
  crossref: 'kubernetes',
  europepmc: 'kubernetes',
  uniprot: 'p53',
  clinicaltrials: 'cancer',
  nvd: 'kubernetes',
  coingecko: 'bitcoin',
  internetarchive: 'kubernetes',
  wikidata: 'kubernetes',
  nominatim: 'paris',
};

const limit = Math.max(1, Math.min(20, Number(process.argv[2] ?? 3) || 3));
const scope = process.argv[3] === 'expanded' ? 'expanded' : 'all';
const ids = scope === 'expanded'
  ? VERTICAL_IDS.filter((id) => !DEFAULT_VERTICAL_IDS.includes(id))
  : [...VERTICAL_IDS];

/** Print the first three titles for one source's answer. */
function print(id, outcome, route, elapsed) {
  console.log(`\n${id} [${route}, ${elapsed}ms] -> ${outcome.sources.length} result(s)`);
  if (outcome.failures.length > 0) console.log(`  failures: ${outcome.failures.join('; ')}`);
  for (const source of outcome.sources.slice(0, 3)) {
    console.log(`  - ${source.title ?? '(untitled)'} | ${source.url}`);
  }
}

const envProxy = await resolveProxy(undefined);
const route = envProxy === undefined ? 'direct' : `proxy ${envProxy}`;
console.log(`sources: ${ids.length} (${scope}), queries/limit: ${limit}, route: ${route}`);

const counts = {};
for (const id of ids) {
  const started = Date.now();
  let outcome = await searchVerticals(QUERIES[id], {
    ids: [id],
    limit,
    ...(envProxy === undefined ? {} : { proxy: envProxy }),
  });
  let used = route;
  if (outcome.sources.length === 0 && envProxy !== undefined) {
    outcome = await searchVerticals(QUERIES[id], { ids: [id], limit });
    used = 'direct (tunnel returned nothing)';
  }
  counts[id] = outcome.sources.length;
  print(id, outcome, used, Date.now() - started);
}

const answered = Object.entries(counts).filter(([, value]) => value > 0);
console.log(`\nsummary: ${answered.length}/${ids.length} source(s) answered with at least one row`);
console.log('counts:', JSON.stringify(counts));
if (answered.length === 0) {
  console.error('every source returned zero results; check the network or the proxy');
  process.exitCode = 1;
}
