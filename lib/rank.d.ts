/**
 * Ranking: reciprocal rank fusion with authority and freshness boosts.
 *
 * The engines agree on nothing except that a result near the top of their own
 * list is the one they consider relevant, and they do not expose a comparable
 * score. Reciprocal rank fusion turns those ranks into one number the merge can
 * sort on, but the weight cannot simply multiply that number: at
 * `rrfConstant = 60` the distance between rank 1 and rank 10 is `1/61` versus
 * `1/70`, so a weight of 2 would let one engine outscore every other engine at
 * every rank and fill the whole list by itself. Measured on a CJK query, that is
 * exactly what happened: AnySearch (weight 2) returned all 8 sources and no
 * Chinese engine appeared at all.
 *
 * Weight therefore shapes *admission*, not score. The engines' lists are walked
 * in a weighted round robin (a weight-2 engine takes two consecutive rows per
 * round, so it owns roughly twice the slots), and that interleaved order gives
 * each candidate a position. A source then scores
 *
 *     votes / (rrfConstant + position)
 *
 * where `votes` is the number of distinct engines that returned it: appearing
 * near the top of the merged list is what earns a slot, and cross-engine
 * agreement doubles the evidence instead of letting one engine's weight double
 * its every row.
 *
 * Two corrections ride on top of that score, because position alone says nothing
 * about the page itself:
 *
 * - authority: official documentation and standards bodies (`postgresql.org`,
 *   `developer.mozilla.org`, `rfc-editor.org`, ...) outrank an SEO page that
 *   happens to sit at the same rank;
 * - freshness: a result published a few days ago is more useful than the same
 *   result published years ago, with the boost fading linearly to zero at
 *   `freshnessDays`;
 * - an active time filter: a dated in-window result beats a result with no
 *   date at the same rank. The penalty is small and applied only while
 *   filtering is on, so an undated page can still win on relevance and the
 *   default (`timeRange: off`) is byte-for-byte the old behaviour.
 *
 * The bilingual region policy is kept intact: engines whose region matches the
 * query language's lead (or are marked `both`) are fused first and fill the
 * caller's budget; the other region only appends when the leading side came up
 * short, so an English query is not half-filled with dictionary pages from a
 * domestic engine that matched one word of it.
 *
 * @module @fangchenghao/dsh-web-search/rank
 */
import type { EngineAnswer, RankOptions, Region, Source } from './types.ts';
/**
 * Reciprocal-rank-fusion constant over the interleaved slot order; a larger
 * value flattens the curve so authority and freshness reorder more freely.
 */
export declare const RRF_CONSTANT = 60;
/** Domains that earn the authority boost by default: official documentation. */
export declare const DEFAULT_AUTHORITY_DOMAINS: readonly string[];
/** Multiplier added for an authoritative domain by default. */
export declare const DEFAULT_AUTHORITY_BOOST = 0.25;
/** Multiplier added for a brand-new result by default. */
export declare const DEFAULT_FRESHNESS_BOOST = 0.2;
/** Age in days after which the freshness boost has faded to zero. */
export declare const DEFAULT_FRESHNESS_DAYS = 30;
/**
 * Score factor for a result with no usable date while a time window is active.
 *
 * Ten percent is roughly six fusion positions at `rrfConstant = 60`: enough for
 * a dated result to win a close comparison, small enough that an undated result
 * still outranks a dated one that is clearly less relevant. With every result
 * undated the factor is uniform, so the order is unchanged.
 */
export declare const UNDATED_WHEN_FILTERING_FACTOR = 0.9;
/**
 * Deduplicate by URL, preserving first-seen order.
 *
 * @param sources - rows in priority order.
 * @returns the rows with repeated documents dropped, keeping the first object.
 */
export declare function dedupe(sources: Source[]): Source[];
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
export declare function interleave(lists: Source[][], weights?: number[]): Source[];
/**
 * Fuse every engine's answer into one ranking.
 *
 * @param answers - per-engine answers, in engine priority order.
 * @param limit - maximum sources to return.
 * @param options - ranking knobs; `weights` is a per-engine slot share indexed like `answers`.
 * @returns the fused sources, highest score first, at most `limit` of them.
 */
export declare function fuse(answers: EngineAnswer[], limit: number, options?: RankOptions): Source[];
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
export declare function mergeRegions(answers: EngineAnswer[], lead: Region, limit: number, options?: RankOptions): Source[];
