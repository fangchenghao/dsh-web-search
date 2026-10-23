/** Milliseconds in one day, shared with the ranking module. */
export const MS_PER_DAY = 86_400_000;
/** Rolling window length per range. `off` is handled separately. */
export const TIME_RANGE_MS = {
    day: MS_PER_DAY,
    week: 7 * MS_PER_DAY,
    month: 30 * MS_PER_DAY,
    year: 365 * MS_PER_DAY,
};
/** Every accepted `timeRange` value, in settings order. */
export const TIME_RANGES = ['off', 'day', 'week', 'month', 'year'];
/** Longest relative age accepted, so a stray huge number cannot overflow. */
const MAX_RELATIVE = 10_000;
/** Plausible absolute years; anything outside is a number, not a date. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;
/** Month names as the scraped engines spell them. */
const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};
/** Boundaries that make a relative phrase a whole token, not prose. */
const BEFORE = '(?:^|[\\s,，。;；:：|(（【\\[])';
const AFTER = '(?=$|[\\s,，。;；:：|)）】\\]])';
/** Chinese relative stamps: `3 天前`, `10 小时之前`, `昨天`, `刚刚`. */
const CN_RELATIVE = new RegExp(`${BEFORE}(\\d{1,5})\\s*(分钟|小时|天|周|个月|年)\\s*(?:前|之前)${AFTER}`, 'u');
/** Chinese named days, which carry no number. */
const CN_NAMED = new RegExp(`${BEFORE}(今天|昨天|前天|刚刚)${AFTER}`, 'u');
/** English relative stamps: `3 days ago`, `22 hours ago`, `yesterday`. */
const EN_RELATIVE = new RegExp(`${BEFORE}(\\d{1,5})\\s+(minute|hour|day|week|month|year)s?\\s+ago${AFTER}`, 'i');
/** English named days. */
const EN_NAMED = new RegExp(`${BEFORE}(today|yesterday)${AFTER}`, 'i');
/** `2024年5月1日` and `2024年5月1号`. */
const CN_ABSOLUTE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u;
/** `2024-05-01`, `2024/5/1`, and the date part of a full ISO instant. */
const ISO_ABSOLUTE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/u;
/** `May 1, 2024`, `Sept 25 2025`, `Oct 3rd, 2025`. */
const EN_MONTH_FIRST = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
/** `1 May 2024`, `3rd Oct 2025`. */
const EN_DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i;
/** The marker AnySearch appends to `content`, e.g. `date: 22 hours ago`. */
const DATE_MARKER = /(?:^|[\s|])date\s*[:：]\s*([^|\n]+?)\s*$/i;
/**
 * Build a UTC instant for a calendar date.
 *
 * The time of day is fixed at noon UTC on purpose: a date without a time
 * belongs to no particular hour, and noon keeps it inside its own calendar day
 * for every timezone from UTC-11 to UTC+12. `Date.UTC` also means the machine's
 * `TZ` is never consulted.
 *
 * @param year - four-digit year.
 * @param month - 1-based month.
 * @param day - day of month.
 * @returns epoch milliseconds, or `undefined` when the components are not a
 *   real calendar date (for example 31 February).
 */
function utcDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day))
        return undefined;
    if (year < MIN_YEAR || year > MAX_YEAR)
        return undefined;
    if (month < 1 || month > 12 || day < 1 || day > 31)
        return undefined;
    const at = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
    const check = new Date(at);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        return undefined;
    }
    return at;
}
/**
 * Convert epoch milliseconds to the canonical ISO string.
 * @param at - epoch milliseconds.
 * @returns ISO 8601 in UTC, the only shape `Source.publishedAt` carries.
 */
function iso(at) {
    return new Date(at).toISOString();
}
/**
 * Read the unit multiplier for a Chinese relative unit.
 * @param unit - `分钟`, `小时`, `天`, `周`, `个月` or `年`.
 * @returns milliseconds per unit, or `undefined` for an unknown unit.
 */
function cnUnitMs(unit) {
    switch (unit) {
        case '分钟':
            return 60_000;
        case '小时':
            return 3_600_000;
        case '天':
            return MS_PER_DAY;
        case '周':
            return 7 * MS_PER_DAY;
        case '个月':
            return 30 * MS_PER_DAY;
        case '年':
            return 365 * MS_PER_DAY;
        default:
            return undefined;
    }
}
/**
 * Read the unit multiplier for an English relative unit.
 * @param unit - `minute`, `hour`, `day`, `week`, `month` or `year`.
 * @returns milliseconds per unit, or `undefined` for an unknown unit.
 */
function enUnitMs(unit) {
    switch (unit.toLowerCase()) {
        case 'minute':
            return 60_000;
        case 'hour':
            return 3_600_000;
        case 'day':
            return MS_PER_DAY;
        case 'week':
            return 7 * MS_PER_DAY;
        case 'month':
            return 30 * MS_PER_DAY;
        case 'year':
            return 365 * MS_PER_DAY;
        default:
            return undefined;
    }
}
/**
 * Parse the first relative phrase in a fragment.
 *
 * Relative stamps are rolling: `3 days ago` means `now - 3 * 24h`, not three
 * calendar days. That avoids the timezone and daylight-saving questions a
 * calendar subtraction would raise, and matches how the engines mean them.
 *
 * @param value - normalised text.
 * @param now - evaluation instant in epoch milliseconds.
 * @returns epoch milliseconds, or `undefined` when there is no relative phrase.
 */
function parseRelative(value, now) {
    const cnNumbered = CN_RELATIVE.exec(value);
    if (cnNumbered !== null) {
        const amount = Number(cnNumbered[1]);
        const unit = cnUnitMs(cnNumbered[2] ?? '');
        if (Number.isFinite(amount) && amount >= 0 && amount <= MAX_RELATIVE && unit !== undefined) {
            return now - amount * unit;
        }
    }
    const enNumbered = EN_RELATIVE.exec(value);
    if (enNumbered !== null) {
        const amount = Number(enNumbered[1]);
        const unit = enUnitMs(enNumbered[2] ?? '');
        if (Number.isFinite(amount) && amount >= 0 && amount <= MAX_RELATIVE && unit !== undefined) {
            return now - amount * unit;
        }
    }
    const cnNamed = CN_NAMED.exec(value);
    if (cnNamed !== null) {
        switch (cnNamed[1]) {
            case '昨天':
                return now - MS_PER_DAY;
            case '前天':
                return now - 2 * MS_PER_DAY;
            case '今天':
            case '刚刚':
            default:
                return now;
        }
    }
    const enNamed = EN_NAMED.exec(value);
    if (enNamed !== null)
        return enNamed[1]?.toLowerCase() === 'yesterday' ? now - MS_PER_DAY : now;
    return undefined;
}
/**
 * Parse the first absolute date in a fragment.
 *
 * Checked before relative stamps only when declared explicitly; the caller
 * decides the order. All arithmetic is UTC.
 *
 * @param value - normalised text.
 * @returns epoch milliseconds, or `undefined` when no valid date is present.
 */
function parseAbsolute(value) {
    const cn = CN_ABSOLUTE.exec(value);
    if (cn !== null) {
        const at = utcDate(Number(cn[1]), Number(cn[2]), Number(cn[3]));
        if (at !== undefined)
            return at;
    }
    const isoDate = ISO_ABSOLUTE.exec(value);
    if (isoDate !== null) {
        const at = utcDate(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]));
        if (at !== undefined)
            return at;
    }
    const monthFirst = EN_MONTH_FIRST.exec(value);
    if (monthFirst !== null) {
        const month = MONTHS[(monthFirst[1] ?? '').toLowerCase()];
        if (month !== undefined) {
            const at = utcDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
            if (at !== undefined)
                return at;
        }
    }
    const dayFirst = EN_DAY_FIRST.exec(value);
    if (dayFirst !== null) {
        const month = MONTHS[(dayFirst[2] ?? '').toLowerCase()];
        if (month !== undefined) {
            const at = utcDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
            if (at !== undefined)
                return at;
        }
    }
    return undefined;
}
/**
 * Normalise whitespace so the boundary patterns see one predictable shape.
 * @param value - raw fragment.
 * @returns single-spaced trimmed text.
 */
function normalise(value) {
    return value.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
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
export function parsePublishedAt(fragment, now = Date.now()) {
    if (typeof fragment !== 'string' || fragment.trim().length === 0)
        return undefined;
    const value = normalise(fragment);
    const marker = DATE_MARKER.exec(value);
    if (marker !== null) {
        const marked = normalise(marker[1] ?? '');
        const at = parseRelative(marked, now) ?? parseAbsolute(marked);
        if (at !== undefined)
            return iso(at);
    }
    const relative = parseRelative(value, now);
    if (relative !== undefined)
        return iso(relative);
    const absolute = parseAbsolute(value);
    if (absolute !== undefined)
        return iso(absolute);
    return undefined;
}
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
export function extractPublishedAt(fragments, now = Date.now()) {
    for (const fragment of fragments) {
        if (typeof fragment !== 'string')
            continue;
        const parsed = parsePublishedAt(fragment, now);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
/**
 * Read a publication date as epoch milliseconds.
 * @param publishedAt - canonical ISO string, or `undefined`.
 * @returns epoch milliseconds, or `undefined` when absent or unparsable.
 */
export function publishedTimestamp(publishedAt) {
    if (typeof publishedAt !== 'string' || publishedAt.length === 0)
        return undefined;
    const at = Date.parse(publishedAt);
    return Number.isNaN(at) ? undefined : at;
}
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
export function isWithinTimeRange(publishedAt, range, now = Date.now()) {
    if (range === 'off')
        return true;
    const at = publishedTimestamp(publishedAt);
    if (at === undefined)
        return true;
    return at >= now - TIME_RANGE_MS[range];
}
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
export function filterByTimeRange(sources, range, now = Date.now()) {
    if (range === 'off')
        return [...sources];
    // "Undated" means the timestamp could not be parsed, not merely absent: a
    // junk value is no more evidence of age than a missing one.
    const dated = sources.filter((source) => publishedTimestamp(source.publishedAt) !== undefined);
    const inside = dated.filter((source) => isWithinTimeRange(source.publishedAt, range, now));
    if (inside.length > 0)
        return inside;
    const undated = sources.filter((source) => publishedTimestamp(source.publishedAt) === undefined);
    return undated.length > 0 ? undated : [];
}
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
export function preferWindow(sources, range, now = Date.now()) {
    if (range === 'off')
        return [...sources];
    const inside = sources.filter((source) => publishedTimestamp(source.publishedAt) !== undefined && isWithinTimeRange(source.publishedAt, range, now));
    return inside.length > 0 ? inside : [...sources];
}
