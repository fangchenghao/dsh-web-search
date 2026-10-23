import { publishedTimestamp } from "./freshness.js";
import { filterRelevant } from "./relevance.js";
/**
 * Reciprocal-rank-fusion constant over the interleaved slot order; a larger
 * value flattens the curve so authority and freshness reorder more freely.
 */
export const RRF_CONSTANT = 60;
/** Domains that earn the authority boost by default: official documentation. */
export const DEFAULT_AUTHORITY_DOMAINS = [
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
    // Chinese official domains: policy and standards pages from a ministry or a
    // university outrank the SEO reposts and dictionary pages that a scraped
    // Chinese engine returns at the same rank. The suffix match in
    // `isAuthoritative` makes `gov.cn` cover every ministry subdomain.
    'gov.cn',
    'edu.cn',
    'news.cn',
    'people.com.cn',
    'xinhuanet.com',
    'ncsti.gov.cn',
    'cas.cn',
];
/** Multiplier added for an authoritative domain by default. */
export const DEFAULT_AUTHORITY_BOOST = 0.25;
/** Multiplier added for a brand-new result by default. */
export const DEFAULT_FRESHNESS_BOOST = 0.2;
/** Age in days after which the freshness boost has faded to zero. */
export const DEFAULT_FRESHNESS_DAYS = 30;
/**
 * Score factor for a result with no usable date while a time window is active.
 *
 * Ten percent is roughly six fusion positions at `rrfConstant = 60`: enough for
 * a dated result to win a close comparison, small enough that an undated result
 * still outranks a dated one that is clearly less relevant. With every result
 * undated the factor is uniform, so the order is unchanged.
 */
export const UNDATED_WHEN_FILTERING_FACTOR = 0.9;
/**
 * Scores closer together than this count as equal, so the deterministic
 * tie-break decides instead of floating-point summation order.
 */
const SCORE_EPSILON = 1e-12;
/** Milliseconds in a day, for the freshness age. */
const MS_PER_DAY = 86_400_000;
/**
 * Canonical form used to decide whether two rows are the same document.
 * `www.` and a trailing slash are the same page served twice, and the scraped
 * engines disagree about both.
 *
 * @param url - raw source URL.
 * @returns the comparison key; the source itself is left untouched.
 */
function normaliseUrl(url) {
    return url.replace(/\/$/, '').replace(/^(https?:\/\/)www\./i, '$1');
}
/**
 * Deduplicate by URL, preserving first-seen order.
 *
 * @param sources - rows in priority order.
 * @returns the rows with repeated documents dropped, keeping the first object.
 */
export function dedupe(sources) {
    const seen = new Set();
    const out = [];
    for (const source of sources) {
        const key = normaliseUrl(source.url);
        if (seen.has(key))
            continue;
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
function slotWeight(weights, index) {
    const weight = weights[index];
    if (typeof weight === 'number' && Number.isFinite(weight))
        return Math.max(0, Math.floor(weight));
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
export function interleave(lists, weights = []) {
    let rounds = 0;
    for (let index = 0; index < lists.length; index += 1) {
        const list = lists[index];
        if (list === undefined)
            continue;
        const weight = slotWeight(weights, index);
        if (weight === 0)
            continue;
        rounds = Math.max(rounds, Math.ceil(list.length / weight));
    }
    const merged = [];
    for (let round = 0; round < rounds; round += 1) {
        for (let index = 0; index < lists.length; index += 1) {
            const list = lists[index];
            if (list === undefined)
                continue;
            const weight = slotWeight(weights, index);
            for (let slot = 0; slot < weight; slot += 1) {
                const item = list[round * weight + slot];
                if (item !== undefined)
                    merged.push(item);
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
function positiveOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Read one non-negative ranking knob, falling back when it is unusable.
 *
 * @param value - caller value.
 * @param fallback - documented default.
 * @returns the value when it is finite and non-negative, else the fallback.
 */
function nonNegativeOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
/**
 * Normalise one configured authority domain.
 *
 * @param raw - domain, possibly a full URL with `www.` and a trailing slash.
 * @returns the bare lower-case hostname, or `''` when nothing usable remains.
 */
function normaliseDomain(raw) {
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
function resolveDomainList(list) {
    if (!Array.isArray(list))
        return DEFAULT_AUTHORITY_DOMAINS;
    const domains = new Set();
    for (const raw of list) {
        if (typeof raw !== 'string')
            continue;
        const domain = normaliseDomain(raw);
        if (domain !== '')
            domains.add(domain);
    }
    return [...domains];
}
/**
 * Apply every documented default to the caller's ranking options.
 *
 * @param options - caller options, possibly empty.
 * @returns the fully resolved configuration.
 */
function resolveOptions(options) {
    return {
        rrfConstant: positiveOr(options?.rrfConstant, RRF_CONSTANT),
        authorityDomains: resolveDomainList(options?.authorityDomains),
        authorityBoost: nonNegativeOr(options?.authorityBoost, DEFAULT_AUTHORITY_BOOST),
        freshnessBoost: nonNegativeOr(options?.freshnessBoost, DEFAULT_FRESHNESS_BOOST),
        freshnessDays: positiveOr(options?.freshnessDays, DEFAULT_FRESHNESS_DAYS),
        timeRange: options?.timeRange,
        weights: Array.isArray(options?.weights) ? options.weights : undefined,
        now: typeof options?.now === 'number' && Number.isFinite(options.now)
            ? options.now
            : Date.now(),
    };
}
/**
 * Slot share of one engine in the fusion: how many consecutive rows it takes
 * per weighted round robin, not a score multiplier.
 *
 * @param weights - per-engine weights from the options.
 * @param engineIndex - position of the engine in the answer array.
 * @param host - the engine itself, whose `weight` is the fallback.
 * @returns the configured weight, the host's weight, or `1`.
 */
function engineWeight(weights, engineIndex, host) {
    const configured = weights?.[engineIndex];
    if (typeof configured === 'number' && Number.isFinite(configured))
        return Math.max(0, configured);
    const declared = host.weight;
    if (typeof declared === 'number' && Number.isFinite(declared))
        return Math.max(0, declared);
    return 1;
}
/**
 * Hostname of a source URL.
 *
 * @param url - absolute URL as the parser emitted it.
 * @returns the lower-case hostname, or `undefined` when it does not parse.
 */
function hostnameOf(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    }
    catch {
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
function isAuthoritative(url, domains) {
    const hostname = hostnameOf(url);
    if (hostname === undefined || hostname === '')
        return false;
    for (const domain of domains) {
        if (hostname === domain || hostname.endsWith(`.${domain}`))
            return true;
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
function freshnessFactor(publishedAt, freshnessDays, freshnessBoost, now) {
    if (publishedAt === undefined || freshnessBoost <= 0)
        return 1;
    const at = Date.parse(publishedAt);
    if (Number.isNaN(at))
        return 1;
    const ageDays = Math.max(0, (now - at) / MS_PER_DAY);
    if (ageDays >= freshnessDays)
        return 1;
    return 1 + freshnessBoost * (1 - ageDays / freshnessDays);
}
/**
 * Sort key ordering: score first, then the deterministic tie-breaks.
 *
 * @param a - first ranked source.
 * @param b - second ranked source.
 * @returns negative when `a` ranks first.
 */
function compareRanked(a, b) {
    if (Math.abs(a.score - b.score) > SCORE_EPSILON)
        return b.score - a.score;
    if (a.engineIndex !== b.engineIndex)
        return a.engineIndex - b.engineIndex;
    if (a.rank !== b.rank)
        return a.rank - b.rank;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
/**
 * Normalise the caller's budget.
 *
 * @param limit - requested source count.
 * @returns a whole, non-negative budget.
 */
function budgetOf(limit) {
    if (!Number.isFinite(limit))
        return 0;
    return Math.max(0, Math.floor(limit));
}
/**
 * Fuse a group of engines and slice to the budget.
 *
 * Weight is a slot share, not a score multiplier: the engines' lists are walked
 * in a weighted round robin (the same order {@link interleave} produces), and a
 * source's fused rank is its 1-based position in that merged walk. Because every
 * engine owns its share of each round, no weight can outscore the other engines
 * at every rank; because a source returned by two engines earns two votes, the
 * engines that agree can still push a row to the top.
 *
 * Entry indices are the ones from the caller's `answers` array, so weights and
 * tie-breaks stay aligned even when {@link mergeRegions} fuses two subgroups.
 *
 * @param entries - engines in caller order, with their original indices.
 * @param limit - maximum sources to return.
 * @param options - ranking knobs.
 * @returns the highest-scoring sources, at most `limit` of them.
 */
function fuseEntries(entries, limit, options) {
    const budget = budgetOf(limit);
    if (budget === 0)
        return [];
    const config = resolveOptions(options);
    const now = config.now;
    // Per-engine lists, deduplicated so one engine gets at most one vote per
    // document and the earliest row keeps its rank.
    const lists = [];
    const weights = [];
    for (const entry of entries) {
        const seen = new Set();
        const rows = [];
        const sources = options.query === undefined ? entry.sources : filterRelevant(entry.sources, options.query);
        for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            if (source === undefined)
                continue;
            if (typeof source.url !== 'string' || source.url.trim() === '')
                continue;
            const key = normaliseUrl(source.url);
            if (seen.has(key))
                continue;
            seen.add(key);
            rows.push({ key, source, rank: index + 1, engineIndex: entry.engineIndex });
        }
        lists.push(rows);
        weights.push(engineWeight(config.weights, entry.engineIndex, entry.host));
    }
    const rounds = lists.reduce((deepest, rows, index) => {
        const weight = weights[index] ?? 1;
        if (weight === 0 || rows.length === 0)
            return deepest;
        return Math.max(deepest, Math.ceil(rows.length / weight));
    }, 0);
    // The weighted round robin itself: it assigns every row a slot, which is the
    // fused rank, and counts the distinct engines behind every URL. A repeated
    // document still occupies its slot (so later rows do not shift up) but only
    // the first appearance sets the position.
    const candidates = new Map();
    const votes = new Map();
    let slot = 0;
    for (let round = 0; round < rounds; round += 1) {
        for (let index = 0; index < lists.length; index += 1) {
            const rows = lists[index];
            if (rows === undefined)
                continue;
            const weight = weights[index] ?? 1;
            for (let offset = 0; offset < weight; offset += 1) {
                const row = rows[round * weight + offset];
                if (row === undefined)
                    continue;
                slot += 1;
                votes.set(row.key, (votes.get(row.key) ?? 0) + 1);
                if (candidates.has(row.key))
                    continue;
                candidates.set(row.key, {
                    source: row.source,
                    key: row.key,
                    position: slot,
                    score: 0,
                    engineIndex: row.engineIndex,
                    rank: row.rank,
                });
            }
        }
    }
    if (candidates.size === 0)
        return [];
    const ranked = [...candidates.values()];
    const filtering = config.timeRange !== undefined && config.timeRange !== 'off';
    for (const candidate of ranked) {
        const voteCount = votes.get(candidate.key) ?? 1;
        let score = voteCount / (config.rrfConstant + candidate.position);
        if (isAuthoritative(candidate.source.url, config.authorityDomains))
            score *= 1 + config.authorityBoost;
        score *= freshnessFactor(candidate.source.publishedAt, config.freshnessDays, config.freshnessBoost, now);
        // A missing (or unparsable) date is not evidence of staleness, so the row
        // is kept. While a window is active it is discounted instead of being
        // dropped, which keeps the long tail of undated documentation visible.
        if (filtering && publishedTimestamp(candidate.source.publishedAt) === undefined) {
            score *= UNDATED_WHEN_FILTERING_FACTOR;
        }
        candidate.score = score;
    }
    ranked.sort(compareRanked);
    return ranked.slice(0, budget).map((candidate) => candidate.source);
}
/**
 * Fuse every engine's answer into one ranking.
 *
 * @param answers - per-engine answers, in engine priority order.
 * @param limit - maximum sources to return.
 * @param options - ranking knobs; `weights` is a per-engine slot share indexed like `answers`.
 * @returns the fused sources, highest score first, at most `limit` of them.
 */
export function fuse(answers, limit, options = {}) {
    const entries = answers.map((answer, engineIndex) => ({
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
function leadsRegion(region, lead) {
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
 * @param options - ranking knobs; `weights` is a per-engine slot share indexed like `answers`.
 * @returns the merged sources, at most `limit` of them.
 */
export function mergeRegions(answers, lead, limit, options = {}) {
    const budget = budgetOf(limit);
    if (budget === 0)
        return [];
    const head = [];
    const tail = [];
    answers.forEach((answer, engineIndex) => {
        const entry = { host: answer.host, sources: answer.sources, engineIndex };
        if (leadsRegion(answer.host.region, lead))
            head.push(entry);
        else
            tail.push(entry);
    });
    const headSources = fuseEntries(head, budget, options);
    if (headSources.length >= budget || tail.length === 0)
        return headSources;
    const taken = new Set(headSources.map((source) => normaliseUrl(source.url)));
    const tailSources = fuseEntries(tail, budget, options).filter((source) => !taken.has(normaliseUrl(source.url)));
    return [...headSources, ...tailSources].slice(0, budget);
}
