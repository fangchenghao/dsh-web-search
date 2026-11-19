import type { Source, TimeRange } from './types.ts';
export declare function normaliseBlockedDomains(values?: readonly string[]): string[];
export declare function removeBlocked(sources: Source[], domains: readonly string[]): Source[];
export declare function eligibleSearchSources(sources: Source[], blocked: readonly string[], range: TimeRange): Source[];
export declare function mergePreferredSources(preferred: readonly Source[], ordinary: readonly Source[]): Source[];
