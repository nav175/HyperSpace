/**
 * Tree-path helpers for Gate C flyTo (LCA waypoints).
 * IDs are Wikipedia page numbers from Dilpreet’s nodes.json.
 */

/** Ancestors from node → root, inclusive. */
export function ancestorsOf(
  id: number,
  parentOf: Map<number, number | null>,
): number[] {
  const path: number[] = [];
  let cur: number | null | undefined = id;
  let guard = 0;
  while (cur != null && guard++ < 64) {
    path.push(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return path;
}

/** Lowest common ancestor id, or null if disconnected. */
export function lowestCommonAncestor(
  a: number,
  b: number,
  parentOf: Map<number, number | null>,
): number | null {
  const seen = new Set(ancestorsOf(a, parentOf));
  for (const id of ancestorsOf(b, parentOf)) {
    if (seen.has(id)) return id;
  }
  return null;
}

/**
 * Shortest tree path from → to via LCA.
 * Example: sibling hop goes up to parent then down; no duplicate LCA.
 */
export function treePath(
  fromId: number | null,
  toId: number,
  parentOf: Map<number, number | null>,
): number[] {
  if (fromId == null || fromId === toId) {
    return ancestorsOf(toId, parentOf).reverse(); // root → to
  }

  const upFrom = ancestorsOf(fromId, parentOf);
  const upTo = ancestorsOf(toId, parentOf);
  const lca = lowestCommonAncestor(fromId, toId, parentOf);
  if (lca == null) {
    return ancestorsOf(toId, parentOf).reverse();
  }

  const ascent: number[] = [];
  for (const id of upFrom) {
    ascent.push(id);
    if (id === lca) break;
  }

  const descent: number[] = [];
  for (const id of upTo) {
    if (id === lca) break;
    descent.push(id);
  }
  descent.reverse();

  return [...ascent, ...descent];
}

/** Full highlight set: every node on the traversal (union). */
export function pathHighlight(ids: number[]): number[] {
  return [...new Set(ids)];
}
