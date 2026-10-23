/**
 * Publication-date parsing and rolling time-window filtering.
 *
 * Search engines disagree about how they spell a date: Bing prints
 * `2025年9月25日` or `2 天之前` at the head of a snippet, 360 prints
 * `发贴时间：2026年1月22日`, DuckDuckGo usually prints nothing, and AnySearch
 * appends `date: 22 hours ago` to its `content` field. All of those become one
 * canonical value, an ISO 8601 UTC string, so ranking and filtering never have
 * to care which engine answered.
 *
 * Two rules keep this safe:
 *
 * - Nothing depends on the machine's timezone. An absolute date is built with
 *   `Date.UTC` and anchored at noon UTC, so `2024-05-01` is the same instant in
 *   Shanghai, Berlin and Los Angeles and cannot drift into the previous day.
 * - A missing or unparsable date never discards a result. Filtering only drops
 *   a result whose date is *known* to be outside the window; unknown dates are
 *   kept and merely rank lower (see `rank.ts`), because most documentation pages
 *   carry no date at all.
 *
 * @module @fangchenghao/dsh-web-search/freshness
 */
import type { Source, TimeRange } from './types.ts';
/** Milliseconds in one day, shared with the ranking module. */
export declare const MS_PER_DAY = 86400000;
/** Rolling window length per range. `off` is handled separately. */
export declare const TIME_RANGE_MS: Readonly<Record<Exclude<TimeRange, 'off'>, number>>;
/** Every accepted `timeRange` value, in settings order. */
export declare const TIME_RANGES: readonly TimeRange[];
/**
 * Extract a publication date from one fragment of result text.
 *
 * The search order is deliberate: an explicit `date:` marker wins (AnySearch
 * puts the engine's stamp there), then a relative phrase, then an absolute
 * date. `今天` inside a sentence such as `但是我们今天讲的逻辑复制` is not a
 * publication stamp, so relative words only match as whole tokens; a bare date
 * such as `2024-05-01` is unambiguous enough to match anywhere.
 *
 * @param fragment - summary, stamp or result text.
 * @param now - evaluation instant, injected so tests are deterministic.
 * @returns ISO 8601 UTC, or `undefined` when the fragment carries no date.
 */
export declare function parsePublishedAt(fragment: string, now?: number): string | undefined;
/**
 * Parse the first fragment that carries a usable date.
 *
 * Parsers pass the most authoritative fragment first (a dedicated timestamp
 * element, then the snippet), so a date mentioned in prose cannot override the
 * stamp the engine printed.
 *
 * @param fragments - candidate texts, most authoritative first.
 * @param now - evaluation instant, injected for tests.
 * @returns the first parsed ISO 8601 UTC value, or `undefined`.
 */
export declare function extractPublishedAt(fragments: readonly (string | undefined)[], now?: number): string | undefined;
/**
 * Read a publication date as epoch milliseconds.
 * @param publishedAt - canonical ISO string, or `undefined`.
 * @returns epoch milliseconds, or `undefined` when absent or unparsable.
 */
export declare function publishedTimestamp(publishedAt: string | undefined): number | undefined;
/**
 * Whether a result belongs to the rolling window.
 *
 * `off` accepts everything. A missing or unparsable date is accepted on
 * purpose: filtering exists to remove results known to be stale, not to punish
 * pages that publish no metadata. A date in the future is accepted too — it is
 * still inside the window, and ranking clamps its age to zero.
 *
 * @param publishedAt - canonical ISO string, or `undefined`.
 * @param range - active window.
 * @param now - evaluation instant.
 * @returns `true` when the result may stay.
 */
export declare function isWithinTimeRange(publishedAt: string | undefined, range: TimeRange, now?: number): boolean;
/**
 * Keep only results inside the window.
 *
 * A result whose date could not be parsed is not evidence of an old page, so it
 * is held back rather than dropped: when at least one dated result falls inside
 * the window, only those are returned; when none does, the undated results are
 * returned as a fallback so the caller is not left empty-handed. That trades a
 * little precision for never answering "last 24 hours" with nothing at all.
 * @param sources - parsed sources, in engine order.
 * @param range - active window.
 * @param now - evaluation instant.
 * @returns a new list; the input array and its objects are untouched.
 */
export declare function filterByTimeRange(sources: readonly Source[], range: TimeRange, now?: number): Source[];
/**
 * Apply a window to an already merged list.
 *
 * Per-engine filtering can only see one engine's dates, so an engine that dates
 * nothing keeps all of its rows; this pass runs after the merge, where a dated
 * row from any engine can speak for the whole list. When nothing is dated inside
 * the window the merged list is returned unchanged rather than emptied.
 * @param sources - merged sources.
 * @param range - active window.
 * @param now - evaluation instant.
 * @returns the rows to keep.
 */
export declare function preferWindow(sources: readonly Source[], range: TimeRange, now?: number): Source[];
