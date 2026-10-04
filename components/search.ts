import type { UNode } from './universe/Universe';

export type Match = { id: number; title: string; score: number; path: number[] };
export type SearchResult = { matches: Match[]; focusNodeId: number | null; offline?: boolean };

const STOP_WORDS = new Set(['the', 'and', 'for', 'how', 'what', 'that', 'with', 'does', 'into', 'are', 'about', 'relate', 'to', 'of', 'do', 'is', 'in', 'a', 'an']);

// POST /api/search (README contract). If the API is unreachable, e.g. in an offline demo, fall back
// to keyword search over the universe already loaded in the browser, in the same response shape.
// Returns null when `signal` aborts, i.e. a newer query has replaced this one.
export async function searchUniverse(
  query: string,
  nodes: UNode[],
  byId: Map<number, UNode>,
  signal?: AbortSignal
): Promise<SearchResult | null> {
  try {
    const timeout = AbortSignal.timeout(5000);
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.ok) return (await res.json()) as SearchResult;
  } catch {
    // fall through to the offline search, unless this query was superseded
  }
  if (signal?.aborted) return null;
  return { ...keywordSearch(query, nodes, byId), offline: true };
}

function keywordSearch(query: string, nodes: UNode[], byId: Map<number, UNode>): SearchResult {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
  if (!terms.length) return { matches: [], focusNodeId: null };

  const scored = nodes
    .map((node) => {
      const title = node.title.toLowerCase();
      const summary = node.summary.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title === term) score += 6;
        else if (new RegExp(`\\b${term}`).test(title)) score += 3;
        if (summary.includes(term)) score += 1;
      }
      return { node, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.node.depth - b.node.depth)
    .slice(0, 8);

  const top = scored[0]?.score ?? 1;
  const matches = scored.map(({ node, score }) => ({
    id: node.id,
    title: node.title,
    score: Number((score / top).toFixed(3)),
    path: pathOf(node.id, byId),
  }));
  return { matches, focusNodeId: matches[0]?.id ?? null };
}

export function pathOf(id: number, byId: Map<number, UNode>): number[] {
  const path: number[] = [];
  for (let node = byId.get(id); node; node = node.parentId === null ? undefined : byId.get(node.parentId)) path.unshift(node.id);
  return path;
}
