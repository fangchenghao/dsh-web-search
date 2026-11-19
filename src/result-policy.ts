import { filterByTimeRange, publishedTimestamp } from './freshness.ts';
import type { Source, TimeRange } from './types.ts';

function normaliseDomain(value: string): string {
  let text = value.trim().toLowerCase();
  if (text.includes('://')) {
    try {
      text = new URL(text).hostname;
    } catch {
      return '';
    }
  }
  return text.replace(/\/.*$/u, '').replace(/^\*\./u, '').replace(/^\.+|\.+$/gu, '').trim();
}

export function normaliseBlockedDomains(values: readonly string[] = []): string[] {
  return values.map(normaliseDomain).filter((domain) => domain.length > 0);
}

export function removeBlocked(sources: Source[], domains: readonly string[]): Source[] {
  if (domains.length === 0) return sources;
  return sources.filter((source) => {
    try {
      const host = new URL(source.url).hostname.toLowerCase().replace(/\.$/u, '');
      return !domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    } catch {
      return true;
    }
  });
}

export function eligibleSearchSources(sources: Source[], blocked: readonly string[], range: TimeRange): Source[] {
  const allowed = removeBlocked(sources, blocked);
  return range === 'off' ? allowed : filterByTimeRange(allowed, range);
}

export function mergePreferredSources(preferred: readonly Source[], ordinary: readonly Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const source of [...preferred, ...ordinary]) {
    if (!source.url) continue;
    const first = byUrl.get(source.url);
    if (first === undefined) {
      byUrl.set(source.url, source);
    } else if (source.publishedAt && publishedTimestamp(source.publishedAt) !== undefined && publishedTimestamp(first.publishedAt) === undefined) {
      byUrl.set(source.url, { ...first, publishedAt: source.publishedAt });
    }
  }
  return [...byUrl.values()];
}
