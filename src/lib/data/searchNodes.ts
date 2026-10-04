import type { Node, SearchResponse } from "@/types/contracts";
import { searchLocal } from "@/lib/data/searchLocal";

/**
 * Prefer POST /api/search; fall back to keyword search over the in-memory nodes.
 * Same shape either way.
 */
export async function searchNodes(
  query: string,
  nodes: Node[],
): Promise<SearchResponse> {
  const q = query.trim();
  if (!q) return { matches: [], focusNodeId: nodes[0]?.id ?? 0 };

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    if (res.ok) {
      const data = (await res.json()) as SearchResponse;
      if (data?.matches && typeof data.focusNodeId === "number") return data;
    }
  } catch {
    // API missing — local fallback
  }

  return searchLocal(nodes, q);
}
