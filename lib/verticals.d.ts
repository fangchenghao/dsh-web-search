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
 * The original eight sources answer by default. The expanded repositories,
 * package registries, paper indexes and data sources are opt-in
 * (`defaultOn: false`): they are queried only when the caller names them, so a
 * bare `domain_search` stays a cheap eight-request fan-out instead of a
 * thirty-request one (GitHub alone allows ten unauthenticated searches a
 * minute). {@link DEFAULT_VERTICAL_IDS} is the default set and
 * {@link VERTICAL_IDS} is every supported source.
 *
 * @module @fangchenghao/dsh-web-search/verticals
 */
import type { Source, TimeRange } from './types.ts';
/** Identifiers accepted in `sources` and in the `domainSources` config field. */
export type VerticalId = 'github' | 'npm' | 'pypi' | 'arxiv' | 'wikipedia' | 'hn' | 'stackexchange' | 'crates' | 'githubissues' | 'gitlab' | 'codeberg' | 'dockerhub' | 'maven' | 'nuget' | 'rubygems' | 'packagist' | 'pubdev' | 'huggingface' | 'hfdatasets' | 'openvsx' | 'terraform' | 'terraformproviders' | 'wordpress' | 'jetbrains' | 'openalex' | 'crossref' | 'europepmc' | 'uniprot' | 'clinicaltrials' | 'nvd' | 'coingecko' | 'internetarchive' | 'wikidata' | 'nominatim';
/**
 * Every supported source, in the order results are interleaved.
 *
 * The eight original ids come first so the default set keeps its historical
 * order; expanded sources follow, grouped by kind.
 */
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
     * Include this source in {@link DEFAULT_VERTICAL_IDS}. The original eight are
     * on by default; expanded sources set `false` so a bare `domain_search` stays
     * a cheap eight-request fan-out. A missing value counts as on.
     */
    defaultOn?: boolean;
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
    /** Source ids to query; empty or absent means {@link DEFAULT_VERTICAL_IDS}. */
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
    /** Publication window; arXiv switches to submitted-date order when set. */
    timeRange?: TimeRange;
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
 * Turn a human query into an arXiv `search_query`.
 *
 * `all:retrieval augmented generation survey` is interpreted loosely and can
 * rank an image-generation paper above actual surveys. arXiv's API honours
 * explicit boolean operators, so a survey query becomes a quoted topic phrase
 * plus `all:survey`; other multi-word queries become ANDed terms. A query that
 * already contains field syntax or booleans is passed through unchanged.
 *
 * @param query - the human query.
 * @returns a value for the `search_query` parameter.
 */
export declare function arxivSearchQuery(query: string): string;
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
/**
 * Parse GitHub's issue-and-pull-request search envelope.
 * @param payload - `api.github.com/search/issues` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns issues and pull requests as sources, in API order.
 */
export declare function parseGithubIssues(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse GitLab's project search envelope.
 * @param payload - `gitlab.com/api/v4/projects` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns projects as sources.
 */
export declare function parseGitlab(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Codeberg's Gitea repository search envelope.
 * @param payload - `codeberg.org/api/v1/repos/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns repositories as sources.
 */
export declare function parseCodeberg(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Docker Hub's repository search envelope.
 * @param payload - `hub.docker.com/v2/search/repositories` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns container repositories as sources.
 */
export declare function parseDockerHub(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Maven Central's Solr search envelope.
 * @param payload - `search.maven.org/solrsearch/select` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns artifacts as sources.
 */
export declare function parseMaven(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse NuGet's search envelope.
 * @param payload - `azuresearch-usnc.nuget.org/query` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns packages as sources.
 */
export declare function parseNuget(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse RubyGems' search envelope.
 * @param payload - `rubygems.org/api/v1/search.json` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns gems as sources.
 */
export declare function parseRubyGems(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Packagist's search envelope.
 * @param payload - `packagist.org/search.json` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns Composer packages as sources.
 */
export declare function parsePackagist(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse pub.dev's package search envelope.
 * @param payload - `pub.dev/api/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends a fixed page; rows are capped).
 * @returns Dart packages as sources.
 */
export declare function parsePubDev(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Hugging Face's model search envelope.
 * @param payload - `huggingface.co/api/models` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns models as sources.
 */
export declare function parseHuggingFaceModels(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Hugging Face's dataset search envelope.
 * @param payload - `huggingface.co/api/datasets` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns datasets as sources.
 */
export declare function parseHuggingFaceDatasets(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the Open VSX extension search envelope.
 * @param payload - `open-vsx.org/api/-/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns extensions as sources.
 */
export declare function parseOpenVsx(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the Terraform Registry module search envelope.
 * @param payload - `registry.terraform.io/v1/modules` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns registry modules as sources.
 */
export declare function parseTerraformModules(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the Terraform Registry provider search envelope.
 * @param payload - `registry.terraform.io/v1/providers` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns registry providers as sources.
 */
export declare function parseTerraformProviders(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse WordPress.org's plugin search envelope.
 * @param payload - `api.wordpress.org/plugins/info/1.2` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns plugins as sources.
 */
export declare function parseWordpress(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the JetBrains Marketplace plugin search envelope.
 * @param payload - `plugins.jetbrains.com/api/searchPlugins` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns plugins as sources.
 */
export declare function parseJetbrains(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse OpenAlex's work search envelope.
 * @param payload - `api.openalex.org/works` JSON (`select`ed fields).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns works as sources.
 */
export declare function parseOpenAlex(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Crossref's work search envelope.
 * @param payload - `api.crossref.org/works` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns DOIs as sources.
 */
export declare function parseCrossref(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Europe PMC's search envelope.
 * @param payload - `ebi.ac.uk/europepmc/webservices/rest/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns articles and preprints as sources.
 */
export declare function parseEuropepmc(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse UniProt's protein search envelope.
 * @param payload - `rest.uniprot.org/uniprotkb/search` JSON (`select`ed fields).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns protein records as sources.
 */
export declare function parseUniprot(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse ClinicalTrials.gov's study search envelope.
 * @param payload - `clinicaltrials.gov/api/v2/studies` JSON (`fields` narrowed).
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns trials as sources.
 */
export declare function parseClinicaltrials(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse NVD's CVE search envelope.
 * @param payload - `services.nvd.nist.gov/rest/json/cves/2.0` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns CVEs as sources.
 */
export declare function parseNvd(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse CoinGecko's coin search envelope.
 * @param payload - `api.coingecko.com/api/v3/search` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep (the endpoint sends no row cap; rows are capped).
 * @returns coins as sources.
 */
export declare function parseCoinGecko(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse the Internet Archive's advanced-search envelope.
 * @param payload - `archive.org/advancedsearch.php` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns archive items as sources.
 */
export declare function parseInternetarchive(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Wikidata's entity search envelope.
 * @param payload - `www.wikidata.org/w/api.php?action=wbsearchentities` JSON.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns entities as sources.
 */
export declare function parseWikidata(payload: string, _url: string, limit?: number): Source[];
/**
 * Parse Nominatim's place search envelope.
 * @param payload - `nominatim.openstreetmap.org/search?format=jsonv2` JSON array.
 * @param _url - request URL, unused by this JSON shape.
 * @param limit - rows to keep.
 * @returns places as sources.
 */
export declare function parseNominatim(payload: string, _url: string, limit?: number): Source[];
/** A source id that this module actually knows. */
export declare function isVerticalId(value: unknown): value is VerticalId;
/** Every adapter, keyed by id. */
export declare const VERTICALS: readonly VerticalSpec[];
/** One adapter by id, or `undefined` for a typo. */
export declare function verticalById(id: string): VerticalSpec | undefined;
/**
 * Sources queried when the caller names none.
 *
 * The original eight answer by default; every expanded source is
 * `defaultOn: false`. Fanning a bare tool call out to all of
 * {@link VERTICAL_IDS} would spend the whole GitHub unauthenticated search
 * budget in one request and make the common case slow, so participation is
 * declared per spec rather than implied by membership.
 */
export declare const DEFAULT_VERTICAL_IDS: readonly VerticalId[];
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
