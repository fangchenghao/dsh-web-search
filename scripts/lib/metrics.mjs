/**
 * Scoring for the offline retrieval benchmark.
 *
 * Everything here is pure: no network, no filesystem, no clock. The benchmark
 * recorder stores each engine's raw rows; this module turns a ranked list into
 * precision@k, recall@k and reciprocal rank, and attributes the final rows back
 * to the engines that returned them.
 *
 * Two conventions are deliberate and are covered by `test/bench-metrics.test.ts`:
 *
 * - precision@k uses a fixed k as the denominator, not the number of rows that
 *   happen to be present. A run that returns four rows and hits all four scores
 *   0.5 at k=8; an empty run scores 0. This keeps versions comparable when one
 *   of them returns a short list.
 * - a domain matches itself and its subdomains, in that direction only:
 *   `docs.python.org` matches the expected domain `python.org`, while
 *   `python.org` does not match the expected domain `docs.python.org`. Both
 *   sides are lower-cased and lose a leading `www.`.
 *
 * @module bench/metrics
 */

/** Default cutoff used by the benchmark. */
export const DEFAULT_K = 8;

/**
 * Turn a URL or a bare hostname into a lower-case hostname.
 *
 * A leading `www.`, a trailing dot, a port and a trailing path are removed, so
 * `https://WWW.Example.com:443/a` and `example.com` compare equal. An
 * unparsable value yields `''` rather than throwing.
 *
 * @param {unknown} value - URL or hostname.
 * @returns {string} hostname, or `''` when nothing usable remains.
 */
export function hostnameOf(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim().toLowerCase();
  if (text === '') return '';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
      text = new URL(text).hostname;
    } else if (/[/?#]/.test(text)) {
      text = new URL(`http://${text}`).hostname;
    } else {
      text = text.replace(/:\d+$/, '');
    }
  } catch {
    return '';
  }
  return text.replace(/\.$/, '').replace(/^www\./, '');
}

/**
 * Normalise one expected domain.
 *
 * @param {unknown} value - domain, URL, or `*.domain` wildcard spelling.
 * @returns {string} the bare lower-case domain, or `''`.
 */
export function normaliseDomain(value) {
  const host = hostnameOf(value);
  return host.replace(/^\*\./, '');
}

/**
 * Whether a hostname belongs to an expected domain, exactly or as a subdomain.
 *
 * @param {unknown} hostOrUrl - result URL, hostname, or domain.
 * @param {unknown} expectedDomain - annotated domain from `bench/queries.json`.
 * @returns {boolean} `true` for `example.com` and `docs.example.com` against
 *   expected `example.com`; `false` in the other direction.
 */
export function domainMatches(hostOrUrl, expectedDomain) {
  const host = hostnameOf(hostOrUrl);
  const domain = normaliseDomain(expectedDomain);
  if (host === '' || domain === '') return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Read the URL out of a result row.
 * @param {unknown} result - URL string or `{ url }` object.
 * @returns {string} the URL, or `''`.
 */
export function urlOf(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && typeof result.url === 'string') return result.url;
  return '';
}

/**
 * Take the first `k` result rows.
 * @param {unknown} results - result rows.
 * @param {number} k - cutoff.
 * @returns {Array<unknown>} at most `k` rows.
 */
export function topK(results, k = DEFAULT_K) {
  if (!Array.isArray(results)) return [];
  const cutoff = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : DEFAULT_K;
  return results.slice(0, cutoff);
}

/**
 * Unique, normalised expected domains.
 * @param {unknown} expectedDomains - annotated domains.
 * @returns {string[]} non-empty unique domains, in input order.
 */
export function expectedSet(expectedDomains) {
  if (!Array.isArray(expectedDomains)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of expectedDomains) {
    const domain = normaliseDomain(raw);
    if (domain === '' || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

/**
 * Whether one result row matches any expected domain.
 * @param {unknown} result - result row.
 * @param {unknown} expectedDomains - annotated domains.
 * @returns {boolean} `true` on a match.
 */
export function isRelevant(result, expectedDomains) {
  const url = urlOf(result);
  if (url === '') return false;
  return expectedSet(expectedDomains).some((domain) => domainMatches(url, domain));
}

/**
 * Count result rows in the top `k` that match at least one expected domain.
 *
 * Multiple rows from the same domain each count, so this is the numerator of a
 * standard precision@k, not a distinct-domain count.
 *
 * @param {unknown} results - ranked result rows, best first.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {number} hit count.
 */
export function hitCount(results, expectedDomains, k = DEFAULT_K) {
  return topK(results, k).filter((result) => isRelevant(result, expectedDomains)).length;
}

/**
 * Precision@k with a fixed denominator of `k`.
 *
 * @param {unknown} results - ranked result rows.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {number} hits divided by `k`, or 0 for an invalid cutoff.
 */
export function precisionAt(results, expectedDomains, k = DEFAULT_K) {
  const cutoff = Number.isFinite(k) ? Math.floor(k) : DEFAULT_K;
  if (cutoff <= 0) return 0;
  return hitCount(results, expectedDomains, cutoff) / cutoff;
}

/**
 * Recall@k: how many of the annotated domains appear in the top `k`.
 *
 * Each expected domain contributes at most once, no matter how many of its
 * pages were returned. With no annotations the recall is defined as 0 rather
 * than `NaN`.
 *
 * @param {unknown} results - ranked result rows.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {number} matched domains divided by annotated domains.
 */
export function recallAt(results, expectedDomains, k = DEFAULT_K) {
  const expected = expectedSet(expectedDomains);
  if (expected.length === 0) return 0;
  const top = topK(results, k);
  const matched = new Set();
  for (const result of top) {
    const url = urlOf(result);
    if (url === '') continue;
    for (const domain of expected) {
      if (domainMatches(url, domain)) matched.add(domain);
    }
  }
  return matched.size / expected.length;
}

/**
 * 1-based rank of the first matching result, or 0 when none matched.
 * @param {unknown} results - ranked result rows.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {number} first hit rank, or 0.
 */
export function firstRelevantRank(results, expectedDomains, k = DEFAULT_K) {
  const top = topK(results, k);
  for (let index = 0; index < top.length; index += 1) {
    if (isRelevant(top[index], expectedDomains)) return index + 1;
  }
  return 0;
}

/**
 * Reciprocal rank of the first hit (1/rank), or 0 when there is no hit.
 * @param {unknown} results - ranked result rows.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {number} reciprocal rank in [0, 1].
 */
export function reciprocalRankAt(results, expectedDomains, k = DEFAULT_K) {
  const rank = firstRelevantRank(results, expectedDomains, k);
  return rank === 0 ? 0 : 1 / rank;
}

/**
 * Every per-query metric the benchmark reports.
 *
 * @param {unknown} results - ranked result rows.
 * @param {unknown} expectedDomains - annotated domains.
 * @param {number} k - cutoff.
 * @returns {{k:number,resultCount:number,hits:number,precision:number,
 *   recall:number,firstHitRank:number,rr:number,matchedDomains:string[],
 *   expectedDomains:string[]}} the metrics.
 */
export function evaluateResults(results, expectedDomains, k = DEFAULT_K) {
  const top = topK(results, k);
  const expected = expectedSet(expectedDomains);
  const matched = new Set();
  let hits = 0;
  for (const result of top) {
    const url = urlOf(result);
    if (url === '') continue;
    let rowHit = false;
    for (const domain of expected) {
      if (domainMatches(url, domain)) {
        matched.add(domain);
        rowHit = true;
      }
    }
    if (rowHit) hits += 1;
  }
  const firstHitRank = firstRelevantRank(top, expected, k);
  return {
    k: Number.isFinite(k) ? Math.floor(k) : DEFAULT_K,
    resultCount: top.length,
    hits,
    precision: precisionAt(top, expected, k),
    recall: expected.length === 0 ? 0 : matched.size / expected.length,
    firstHitRank,
    rr: firstHitRank === 0 ? 0 : 1 / firstHitRank,
    matchedDomains: expected.filter((domain) => matched.has(domain)),
    expectedDomains: expected,
  };
}

/**
 * Arithmetic mean; an empty list is 0 rather than `NaN`.
 * @param {number[]} values - numbers.
 * @returns {number} the mean.
 */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Mean reciprocal rank over per-query reciprocal ranks.
 *
 * A query with no hit contributes 0, so a tied rank 2 in two queries and one
 * miss gives `(0.5 + 0.5 + 0) / 3`. Ties are averaged as values; the rank
 * itself is already deterministic because the ranker's tie-break defines one.
 *
 * @param {number[]} reciprocalRanks - per-query 1/rank values.
 * @returns {number} MRR.
 */
export function meanReciprocalRank(reciprocalRanks) {
  return mean(reciprocalRanks);
}

/**
 * Aggregate per-query metric rows.
 *
 * @param {Array<{precision:number,recall:number,rr:number,hits:number}>} rows - evaluated queries.
 * @returns {{queries:number,precision:number,recall:number,mrr:number,
 *   zeroHit:number,anyHit:number}} macro averages plus hit coverage.
 */
export function aggregateScores(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    queries: list.length,
    precision: mean(list.map((row) => row.precision)),
    recall: mean(list.map((row) => row.recall)),
    mrr: meanReciprocalRank(list.map((row) => row.rr)),
    zeroHit: list.filter((row) => row.hits === 0).length,
    anyHit: list.filter((row) => row.hits > 0).length,
  };
}

/**
 * URL identity used by the ranker and by contribution counting.
 *
 * Mirrors `normaliseUrl` in `src/rank.ts`: a trailing slash and a leading
 * `www.` are the only differences treated as the same document.
 *
 * @param {unknown} url - source URL.
 * @returns {string} comparison key.
 */
export function normaliseUrlKey(url) {
  if (typeof url !== 'string') return '';
  return url.replace(/\/$/, '').replace(/^(https?:\/\/)www\./i, '$1');
}

/**
 * Engine id of one recorded answer.
 * @param {any} answer - `{id}`, `{engineId}` or `{host:{id}}`.
 * @returns {string} id, or `?`.
 */
function answerId(answer) {
  if (answer && typeof answer === 'object') {
    if (typeof answer.engineId === 'string') return answer.engineId;
    if (typeof answer.id === 'string') return answer.id;
    if (answer.host && typeof answer.host.id === 'string') return answer.host.id;
  }
  return '?';
}

/**
 * Attribute each final row to the engines that returned it.
 *
 * @param {Array<any>} answers - per-engine answers in engine priority order.
 * @param {Array<any>} finalSources - fused list returned by the ranker.
 * @param {number} k - cutoff.
 * @returns {Array<{url:string,key:string,votes:number,engines:string[],firstEngine:string|null}>}
 *   one row per final source; `votes` is the number of distinct engines that
 *   returned it, and `firstEngine` is the earliest such engine.
 */
export function contributionRows(answers, finalSources, k = DEFAULT_K) {
  const list = Array.isArray(answers) ? answers : [];
  const keysByEngine = list.map((answer) => {
    const seen = new Set();
    for (const source of Array.isArray(answer && answer.sources) ? answer.sources : []) {
      const key = normaliseUrlKey(urlOf(source));
      if (key !== '') seen.add(key);
    }
    return { id: answerId(answer), keys: seen };
  });
  return topK(finalSources, k).map((source) => {
    const url = urlOf(source);
    const key = normaliseUrlKey(url);
    const engines = [];
    for (const engine of keysByEngine) {
      if (engine.keys.has(key)) engines.push(engine.id);
    }
    return {
      url,
      key,
      votes: engines.length,
      engines,
      firstEngine: engines.length === 0 ? null : engines[0],
    };
  });
}

/**
 * Per-engine contribution counts for one query.
 *
 * `returned` is every raw row the engine supplied; `contributed` counts final
 * top-k rows the engine returned (a row backed by two engines counts once for
 * each); `first` counts rows where it was the earliest engine.
 *
 * @param {Array<any>} answers - per-engine answers in engine priority order.
 * @param {Array<any>} finalSources - fused list.
 * @param {number} k - cutoff.
 * @returns {{rows:Array<any>,totals:{rows:number,votes:number,averageVotes:number},
 *   engines:Object<string,{returned:number,contributed:number,first:number}>}} stats.
 */
export function engineStats(answers, finalSources, k = DEFAULT_K) {
  const list = Array.isArray(answers) ? answers : [];
  const rows = contributionRows(list, finalSources, k);
  const engines = {};
  for (const answer of list) {
    const id = answerId(answer);
    if (!engines[id]) engines[id] = { returned: 0, contributed: 0, first: 0 };
    engines[id].returned += Array.isArray(answer && answer.sources) ? answer.sources.length : 0;
  }
  for (const row of rows) {
    for (const id of row.engines) {
      if (!engines[id]) engines[id] = { returned: 0, contributed: 0, first: 0 };
      engines[id].contributed += 1;
    }
    if (row.firstEngine !== null) {
      if (!engines[row.firstEngine]) engines[row.firstEngine] = { returned: 0, contributed: 0, first: 0 };
      engines[row.firstEngine].first += 1;
    }
  }
  const votes = rows.reduce((total, row) => total + row.votes, 0);
  return {
    rows,
    totals: {
      rows: rows.length,
      votes,
      averageVotes: rows.length === 0 ? 0 : votes / rows.length,
    },
    engines,
  };
}

/**
 * Vote histogram for a set of contribution rows.
 *
 * @param {Array<{votes:number}>} rows - rows from {@link contributionRows}.
 * @returns {{rows:number,votes:number,averageVotes:number,histogram:Object<string,number>}}
 *   totals plus a histogram keyed by vote count (`"1"`, `"2"`, ...).
 */
export function consensusSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const votes = list.reduce((total, row) => total + (Number.isFinite(row.votes) ? row.votes : 0), 0);
  const histogram = {};
  for (const row of list) {
    const key = String(Number.isFinite(row.votes) ? row.votes : 0);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return {
    rows: list.length,
    votes,
    averageVotes: list.length === 0 ? 0 : votes / list.length,
    histogram,
  };
}
