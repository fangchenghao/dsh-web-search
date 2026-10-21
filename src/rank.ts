/**
 * Ranking: reciprocal rank fusion with authority and freshness boosts.
 *
 * The engines agree on nothing except that a result near the top of their own
 * list is the one they consider relevant, and they do not expose a comparable
 * score. Reciprocal rank fusion turns those ranks into one number the merge can
 * sort on: a source is worth `engineWeight / (rrfConstant + rank)` for every
 * engine that returned it, so agreement between engines compounds and a row
 * carried by two engines beats a row only one engine found.
 *
 * Two corrections ride on top of that score, because rank alone says nothing
 * about the page itself:
 *
 * - authority: official documentation and standards bodies (`postgresql.org`,
 *   `developer.mozilla.org`, `rfc-editor.org`, ...) outrank an SEO page that
 *   happens to sit at the same rank;
 * - freshness: a result published a few days ago is more useful than the same
 *   result published years ago, with the boost fading linearly to zero at
 *   `freshnessDays`.
 *
 * The bilingual region policy is kept intact: engines whose region matches the
 * query language's lead (or are marked `both`) are fused first and fill the
 * caller's budget; the other region only appends when the leading side came up
 * short, so an English query is not half-filled with dictionary pages from a
 * domestic engine that matched one word of it.
 *
 * @module dsh-web-search-bing/rank
 */
import type { EngineAnswer, HostSpec, RankOptions, Region, Source } from './types.ts';

/** Reciprocal-rank-fusion constant; larger flattens the rank curve. */
export const RRF_CONSTANT = 60;

/** Domains that earn the authority boost by default: official documentation. */
export const DEFAULT_AUTHORITY_DOMAINS: readonly string[] = [
  'postgresql.org',
  'kubernetes.io',
  'doc.rust-lang.org',
  'rust-lang.org',
  'rust-lang.github.io',
  'sqlite.org',
  'docs.python.org',
  'python.org',
  'nodejs.org',
  'developer.mozilla.org',
  'docs.aws.amazon.com',
  'learn.microsoft.com',
  'cloud.google.com',
  'w3.org',
  'rfc-editor.org',
  'man7.org',
  'docs.docker.com',
  'git-scm.com',
  'dev.mysql.com',
  'redis.io',
  'nginx.org',
];

/** Multiplier added for an authoritative domain by default. */
export const DEFAULT_AUTHORITY_BOOST = 0.25;

/** Multiplier added for a brand-new result by default. */
export const DEFAULT_FRESHNESS_BOOST = 0.2;

/** Age in days after which the freshness boost has faded to zero. */
export const DEFAULT_FRESHNESS_DAYS = 30;

/**
 * Scores closer together than this count as equal, so the deterministic
 * tie-break decides instead of floating-point summation order.
 */
const SCORE_EPSILON = 1e-12;

/** Milliseconds in a day, for the freshness age. */
const MS_PER_DAY = 86_400_000;

/** One engine's list, still carrying its original index. */
interface RankedEntry {
  host: HostSpec;
  sources: readonly Source[];
  engineIndex: number;
}

/** A source plus the evidence the fusion gathered for it. */
interface RankedSource {
  source: Source;
  key: string;
  /** Fused score after the authority and freshness multipliers. */
  score: number;
  /** Earliest engine that returned the source; the first tie-break. */
  engineIndex: number;
  /** Rank inside that earliest engine; the second tie-break. */
  rank: number;
}

/** Ranking options with every default applied. */
interface ResolvedOptions {
  rrfConstant: number;
  authorityDomains: readonly string[];
  authorityBoost: number;
  freshnessBoost: number;
  freshnessDays: number;
  weights: readonly number[] | undefined;
}

/**
 * Canonical form used to decide whether two rows are the same document.
 * `www.` and a trailing slash are the same page served twice, and the scraped
 * engines disagree about both.
 *
 * @param url - raw source URL.
 * @returns the comparison key; the source itself is left untouched.
 */
function normaliseUrl(url: string): string {
  return url.replace(/\/$/, '').replace(/^(https?:\/\/)www\./i, '$1');
}

/**
 * Deduplicate by URL, preserving first-seen order.
 *
 * @param sources - rows in priority order.
 * @returns the rows with repeated documents dropped, keeping the first object.
 */
export function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = normaliseUrl(source.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

/**
 * How many consecutive entries one list takes per round.
 *
 * @param weights - per-list weights, possibly shorter than the list count.
 * @param index - list position.
 * @returns a whole number of slots, `1` when unset or unusable.
 */
function slotWeight(weights: readonly number[], index: number): number {
  const weight = weights[index];
  if (typeof weight === 'number' && Number.isFinite(weight)) return Math.max(0, Math.floor(weight));
  return 1;
}

/**
 * Interleave per-engine lists so no single engine fills every slot.
 *
 * A list's weight decides how many of its entries each round takes, so a
 * high-precision engine holds more of the merged list without silencing the
 * others entirely.
 *
 * @param lists - one list per engine, in engine priority order.
 * @param weights - optional per-list weight, defaulting to 1.
 * @returns the merged list, deduplicated.
 */
export function interleave(lists: Source[][], weights: number[] = []): Source[] {
  let rounds = 0;
  for (let index = 0; index < lists.length; index += 1) {
    const list = lists[index];
    if (list === undefined) continue;
    const weight = slotWeight(weights, index);
    if (weight === 0) continue;
    rounds = Math.max(rounds, Math.ceil(list.length / weight));
  }
  const merged: Source[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let index = 0; index < lists.length; index += 1) {
      const list = lists[index];
      if (list === undefined) continue;
      const weight = slotWeight(weights, index);
      for (let slot = 0; slot < weight; slot += 1) {
        const item = list[round * weight + slot];
        if (item !== undefined) merged.push(item);
      }
    }
  }
  return dedupe(merged);
}

/**
 * Read one ranking knob, falling back when it is missing or unusable.
 *
 * @param value - caller value.
 * @param fallback - documented default.
 * @returns the value when it is finite and positive, else the fallback.
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Read one non-negative ranking knob, falling back when it is unusable.
 *
 * @param value - caller value.
 * @param fallback - documented default.
 * @returns the value when it is finite and non-negative, else the fallback.
 */
function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Normalise one configured authority domain.
 *
 * @param raw - domain, possibly a full URL with `www.` and a trailing slash.
 * @returns the bare lower-case hostname, or `''` when nothing usable remains.
 */
function normaliseDomain(raw: string): string {
  const withoutScheme = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = withoutScheme.split('/')[0] ?? '';
  return host.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * Resolve the authority domain list: options override the built-in list.
 *
 * @param list - caller list, or `undefined` for the defaults.
 * @returns unique, normalised domains; an explicit empty list disables the boost.
 */
function resolveDomainList(list: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(list)) return DEFAULT_AUTHORITY_DOMAINS;
  const domains = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const domain = normaliseDomain(raw);
    if (domain !== '') domains.add(domain);
  }
  return [...domains];
}

/**
 * Apply every documented default to the caller's ranking options.
 *
 * @param options - caller options, possibly empty.
 * @returns the fully resolved configuration.
 */
function resolveOptions(options: RankOptions | undefined): ResolvedOptions {
  return {
    rrfConstant: positiveOr(options?.rrfConstant, RRF_CONSTANT),
    authorityDomains: resolveDomainList(options?.authorityDomains),
    authorityBoost: nonNegativeOr(options?.authorityBoost, DEFAULT_AUTHORITY_BOOST),
    freshnessBoost: nonNegativeOr(options?.freshnessBoost, DEFAULT_FRESHNESS_BOOST),
    freshnessDays: positiveOr(options?.freshnessDays, DEFAULT_FRESHNESS_DAYS),
    weights: Array.isArray(options?.weights) ? options.weights : undefined,
  };
}

/**
 * Weight of one engine in the fusion.
 *
 * @param weights - per-engine weights from the options.
 * @param engineIndex - position of the engine in the answer array.
 * @param host - the engine itself, whose `weight` is the fallback.
 * @returns the configured weight, the host's weight, or `1`.
 */
function engineWeight(weights: readonly number[] | undefined, engineIndex: number, host: HostSpec): number {
  const configured = weights?.[engineIndex];
  if (typeof configured === 'number' && Number.isFinite(configured)) return Math.max(0, configured);
  const declared = host.weight;
  if (typeof declared === 'number' && Number.isFinite(declared)) return Math.max(0, declared);
  return 1;
}

/**
 * Hostname of a source URL.
 *
 * @param url - absolute URL as the parser emitted it.
 * @returns the lower-case hostname, or `undefined` when it does not parse.
 */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Whether a source belongs to an authoritative domain, exactly or as a subdomain.
 *
 * @param url - source URL.
 * @param domains - normalised authority domains.
 * @returns `true` when the hostname is the domain or ends with `.<domain>`.
 */
function isAuthoritative(url: string, domains: readonly string[]): boolean {
  const hostname = hostnameOf(url);
  if (hostname === undefined || hostname === '') return false;
  for (const domain of domains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Linear freshness multiplier.
 *
 * An unparsable date is ignored rather than penalised: a page without metadata
 * is not older evidence, just quieter. A future date is clamped to "just
 * published" so it can never earn more than the full boost.
 *
 * @param publishedAt - the page's own publication date, if the parser found one.
 * @param freshnessDays - window after which the boost is zero.
 * @param freshnessBoost - multiplier at age zero.
 * @param now - evaluation time in milliseconds.
 * @returns `1` when stale or unknown, up to `1 + freshnessBoost` when new.
 */
function freshnessFactor(
  publishedAt: string | undefined,
  freshnessDays: number,
  freshnessBoost: number,
  now: number,
): number {
  if (publishedAt === undefined || freshnessBoost <= 0) return 1;
  const at = Date.parse(publishedAt);
  if (Number.isNaN(at)) return 1;
  const ageDays = Math.max(0, (now - at) / MS_PER_DAY);
  if (ageDays >= freshnessDays) return 1;
  return 1 + freshnessBoost * (1 - ageDays / freshnessDays);
}

/**
 * Sort key ordering: score first, then the deterministic tie-breaks.
 *
 * @param a - first ranked source.
 * @param b - second ranked source.
 * @returns negative when `a` ranks first.
 */
function compareRanked(a: RankedSource, b: RankedSource): number {
  if (Math.abs(a.score - b.score) > SCORE_EPSILON) return b.score - a.score;
  if (a.engineIndex !== b.engineIndex) return a.engineIndex - b.engineIndex;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Normalise the caller's budget.
 *
 * @param limit - requested source count.
 * @returns a whole, non-negative budget.
 */
function budgetOf(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

/**
 * Fuse a group of engines and slice to the budget.
 *
 * Entry indices are the ones from the caller's `answers` array, so weights and
 * tie-breaks stay aligned even when {@link mergeRegions} fuses two subgroups.
 *
 * @param entries - engines in caller order, with their original indices.
 * @param limit - maximum sources to return.
 * @param options - ranking knobs.
 * @returns the highest-scoring sources, at most `limit` of them.
 */
function fuseEntries(entries: readonly RankedEntry[], limit: number, options: RankOptions): Source[] {
  const budget = budgetOf(limit);
  if (budget === 0) return [];
  const config = resolveOptions(options);
  const now = Date.now();
  const buckets = new Map<string, RankedSource>();

  for (const entry of entries) {
    const weight = engineWeight(config.weights, entry.engineIndex, entry.host);
    const seen = new Set<string>();
    for (let position = 0; position < entry.sources.length; position += 1) {
      const source = entry.sources[position];
      if (source === undefined) continue;
      if (typeof source.url !== 'string' || source.url.trim() === '') continue;
      const key = normaliseUrl(source.url);
      // One engine gets one vote per document, always at its best rank.
      if (seen.has(key)) continue;
      seen.add(key);
      const rank = position + 1;
      const contribution = weight / (config.rrfConstant + rank);
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, { source, key, score: contribution, engineIndex: entry.engineIndex, rank });
        continue;
      }
      bucket.score += contribution;
      if (
        entry.engineIndex < bucket.engineIndex ||
        (entry.engineIndex === bucket.engineIndex && rank < bucket.rank)
      ) {
        bucket.engineIndex = entry.engineIndex;
        bucket.rank = rank;
      }
    }
  }

  if (buckets.size === 0) return [];

  const ranked = [...buckets.values()];
  for (const bucket of ranked) {
    let score = bucket.score;
    if (isAuthoritative(bucket.source.url, config.authorityDomains)) score *= 1 + config.authorityBoost;
    score *= freshnessFactor(bucket.source.publishedAt, config.freshnessDays, config.freshnessBoost, now);
    bucket.score = score;
  }
  ranked.sort(compareRanked);
  return ranked.slice(0, budget).map((bucket) => bucket.source);
}

/**
 * Fuse every engine's answer into one ranking.
 *
 * @param answers - per-engine answers, in engine priority order.
 * @param limit - maximum sources to return.
 * @param options - ranking knobs; `weights` is indexed like `answers`.
 * @returns the fused sources, highest score first, at most `limit` of them.
 */
export function fuse(answers: EngineAnswer[], limit: number, options: RankOptions = {}): Source[] {
  const entries: RankedEntry[] = answers.map((answer, engineIndex) => ({
    host: answer.host,
    sources: answer.sources,
    engineIndex,
  }));
  return fuseEntries(entries, limit, options);
}

/**
 * Whether an engine answers for the leading side of the query.
 *
 * @param region - the engine's configured region.
 * @param lead - the side the query language belongs to.
 * @returns `true` when the engine is `both` or exactly the lead.
 */
function leadsRegion(region: Region, lead: Region): boolean {
  return region === 'both' || region === lead;
}

/**
 * Merge per-engine lists, leading with the region the query language belongs to.
 *
 * The leading region fills the caller's budget; the other region only appends
 * when the leading one did not answer enough, deduplicated against what the
 * head already returned. The head's order is never disturbed by the tail.
 *
 * @param answers - per-engine answers, in engine priority order.
 * @param lead - the region that leads this query (`global` for ASCII, `cn` for CJK).
 * @param limit - maximum sources to return.
 * @param options - ranking knobs; `weights` is indexed like `answers`.
 * @returns the merged sources, at most `limit` of them.
 */
export function mergeRegions(
  answers: EngineAnswer[],
  lead: Region,
  limit: number,
  options: RankOptions = {},
): Source[] {
  const budget = budgetOf(limit);
  if (budget === 0) return [];
  const head: RankedEntry[] = [];
  const tail: RankedEntry[] = [];
  answers.forEach((answer, engineIndex) => {
    const entry: RankedEntry = { host: answer.host, sources: answer.sources, engineIndex };
    if (leadsRegion(answer.host.region, lead)) head.push(entry);
    else tail.push(entry);
  });
  const headSources = fuseEntries(head, budget, options);
  if (headSources.length >= budget || tail.length === 0) return headSources;
  const taken = new Set(headSources.map((source) => normaliseUrl(source.url)));
  const tailSources = fuseEntries(tail, budget, options).filter((source) => !taken.has(normaliseUrl(source.url)));
  return [...headSources, ...tailSources].slice(0, budget);
}
