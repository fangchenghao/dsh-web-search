/**
 * Shared types for the search provider.
 *
 * Every module in this package imports its contracts from here so the
 * parsers, the ranking, the cache, the engine health tracker and the plugin
 * entry cannot drift apart. Nothing in this file has a runtime side effect.
 *
 * @module @fangchenghao/dsh-web-search/types
 */
/** All failure kinds, in the order diagnostics should present them. */
export const FAILURE_KINDS = [
    'quota',
    'auth',
    'bot-wall',
    'transient',
    'invalid-response',
    'unknown',
];
