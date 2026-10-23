/**
 * Key-free vertical (domain-specific) search sources.
 *
 * `web_search` answers "what is on the open web". This module answers the
 * narrower question a coding agent asks far more often: "which package, which
 * paper, which repository, which Q&A thread". Every endpoint here is a public,
 * documented, credential-free API, so the feature costs no key and no account.
 *
 * A source is a build/parse pair: {@link VerticalSpec.build} turns the query
 * into an absolute URL, and the parser turns the served body into the same
 * {@link Source} shape `web_search` returns. Parsers never throw on markup or
 * payload drift — a source that changes shape yields an empty list so the other
 * sources still answer. Timeouts, status classification and failure isolation
 * live in {@link searchVerticals}, not in the parsers.
 *
 * @module @fangchenghao/dsh-web-search/verticals
 */
import type { Source } from './types.ts';
/** Identifiers accepted in `sources` and in the `domainSources` config field. */
export type VerticalId = 'github' | 'npm' | 'pypi' | 'arxiv' | 'wikipedia' | 'hn' | 'stackexchange' | 'crates';
/** Every supported source, in the order results are interleaved. */
export declare const VERTICAL_IDS: readonly VerticalId[];
/** Default and maximum result budget for one source. */
export declare const DEFAULT_VERTICAL_LIMIT = 5;
/** Upper bound the tool and the adapters both respect. */
export declare const MAX_VERTICAL_LIMIT = 20;
/** One vertical source definition. */
export interface VerticalSpec {
    /** Stable id, also what configuration and tool arguments name. */
    id: VerticalId;
    /** Human label used in failure messages and smoke output. */
    label: string;
    /** `Accept` header this endpoint serves. */
    accept: string;
    /**
     * Treat HTTP 404 as "no such record" rather than a failure. Only PyPI needs
     * this: its endpoint is an exact-package lookup, and a missing package is a
     * legitimate empty answer, not a broken source.
     */
    notFoundIsEmpty?: boolean;
    /** Absolute request URL for a query and result budget. */
    build: (query: string, limit: number) => string;
    /** Extra request headers, merged over the defaults. */
    headers?: Record<string, string>;
    /** Turn the served body into sources; must never throw on drift. */
    parse: (payload: string, finalUrl: string, limit: number) => Source[];
}
/** `fetch`-compatible function, injectable so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Options for {@link searchVerticals}. */
export interface VerticalSearchOptions {
    /** Source ids to query; empty or absent means every source. */
    ids?: readonly string[];
    /** Results wanted per source; clamped to 1…20. */
    limit?: number;
    /** Per-source deadline in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation, propagated to every source. */
    signal?: AbortSignal;
    /** Tunnel URL from the plugin's `proxy` setting, when configured. */
    proxy?: string;
    /** Test seam; defaults to the platform `fetch`. */
    fetch?: FetchLike;
}
/** What one vertical run reports. */
export interface VerticalOutcome {
    /** Merged, de-duplicated sources, capped at the caller's budget. */
    sources: Source[];
    /** One `id: reason` line per source that failed. */
    failures: string[];
    /** Parsed row count per source, before the global cap. */
    counts: Record<string, number>;
    /** Whether rows were dropped because of the global cap. */
    truncated: boolean;
}
/**
 * Parse GitHub's repository search envelope.
 * @param payload - `api.github.com/search/repositories` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns repositories as sources, in API order.
 */
export declare function parseGithub(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse npm's registry search envelope.
 * @param payload - `registry.npmjs.org/-/v1/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns packages as sources.
 */
export declare function parseNpm(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse PyPI's exact-package envelope.
 *
 * PyPI no longer publishes a credential-free search API, so the adapter asks
 * for the query as a package name. A 404 is handled by the orchestrator
 * (`notFoundIsEmpty`) and never reaches this parser; a body without `info`
 * still parses to `[]`.
 * @param payload - `pypi.org/pypi/<name>/json`.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (PyPI answers one).
 * @returns the package as one source, or `[]`.
 */
export declare function parsePypi(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the arXiv Atom feed.
 * @param payload - `export.arxiv.org/api/query` XML.
 * @param _url - request URL, unused by this XML shape.
 * @param limit - entries to keep.
 * @returns papers as sources, in feed order.
 */
export declare function parseArxiv(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Wikipedia's REST search envelope (zh or en host).
 * @param payload - `*.wikipedia.org/w/rest.php/v1/search/page` JSON.
 * @param finalUrl - the request URL, whose host decides the wiki language.
 * @param limit - pages to keep.
 * @returns wiki pages as sources.
 */
export declare function parseWikipedia(payload: string, finalUrl: string, limit?: number): Source[];
/**
 * Parse Hacker News's Algolia search envelope.
 * @param payload - `hn.algolia.com/api/v1/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - hits to keep.
 * @returns stories or comments as sources.
 */
export declare function parseHn(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Stack Exchange's advanced-search envelope.
 * @param payload - `api.stackexchange.com/2.3/search/advanced` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - questions to keep.
 * @returns questions as sources.
 */
export declare function parseStackExchange(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse crates.io's crate search envelope.
 * @param payload - `crates.io/api/v1/crates` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - crates to keep.
 * @returns crates as sources.
 */
export declare function parseCrates(payload: string, _url: string, limit?: number): Source[];
/** A source id that this module actually knows. */
export declare function isVerticalId(value: unknown): value is VerticalId;
/** Every adapter, keyed by id. */
export declare const VERTICALS: readonly VerticalSpec[];
/** One adapter by id, or `undefined` for a typo. */
export declare function verticalById(id: string): VerticalSpec | undefined;
/**
 * Query every requested vertical concurrently and merge the answers.
 *
 * One source failing never fails the run: its reason is recorded in
 * `failures`, its count stays `0`, and the other sources still answer. Answers
 * are interleaved by rank (one row from each source, then the second row from
 * each) so a single prolific source cannot crowd the others out.
 *
 * @param query - what to search for; must be non-empty.
 * @param options - sources, budget, deadline, cancellation, tunnel, fetch seam.
 * @returns merged sources plus per-source counts and failures.
 * @throws SearchError `SEARCH_ABORTED` when the caller cancelled the run.
 */
export declare function searchVerticals(query: string, options?: VerticalSearchOptions): Promise<VerticalOutcome>;
