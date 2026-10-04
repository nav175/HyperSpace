import type { Node, SearchResponse } from "@/types/contracts";

function pathToRoot(nodes: Node[], id: number): number[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: number[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 64) {
    path.push(cur.id);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/** Keyword search over Dilpreet’s nodes.json — used offline / when TiDB is down. */
export function searchLocal(nodes: Node[], query: string): SearchResponse {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [], focusNodeId: nodes[0]?.id ?? 0 };
  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = nodes
    .map((n) => {
      const title = n.title.toLowerCase();
      const summary = n.summary.toLowerCase();
      let score = 0;
      if (title === q) score = 1;
      else if (title.startsWith(q)) score = 0.92;
      else if (title.includes(q)) score = 0.82;
      else if (tokens.length > 1 && tokens.every((t) => title.includes(t)))
        score = 0.78;
      else if (tokens.length > 1 && tokens.every((t) => summary.includes(t)))
        score = 0.42;
      else if (summary.includes(q)) score = 0.4;
      else if (tokens.some((t) => t.length >= 4 && title.includes(t)))
        score = 0.35;
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.n.depth - b.n.depth ||
        a.n.title.length - b.n.title.length,
    )
    .slice(0, 12);

  const matches = scored.map(({ n, score }) => ({
    id: n.id,
    title: n.title,
    score,
    path: pathToRoot(nodes, n.id),
  }));

  return {
    matches,
    focusNodeId: matches[0]?.id ?? nodes[0]?.id ?? 0,
  };
}
