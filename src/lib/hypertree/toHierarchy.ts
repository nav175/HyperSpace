import type { Node } from "@/types/contracts";

export type NestedNode = Node & { children?: NestedNode[] };

/**
 * Prune for d3-hypertree layout cost.
 * Keep depth ≤ 2 plus all categories (~470). Search still uses the full list;
 * flyTo can graft missing path nodes via ensurePathInTree.
 */
export function pruneForRender(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.depth <= 2 || n.type === "category");
}

/** Ensure ancestors (and the node) exist in the render set so flyTo can find them. */
export function ensurePathInTree(full: Node[], render: Node[], id: number): Node[] {
  const byId = new Map(full.map((n) => [n.id, n]));
  const have = new Set(render.map((n) => n.id));
  const extra: Node[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 64) {
    if (!have.has(cur.id)) {
      extra.push(cur);
      have.add(cur.id);
    }
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  // Also keep a few siblings of the target for context
  const target = byId.get(id);
  if (target?.parentId != null) {
    const sibs = full
      .filter((n) => n.parentId === target.parentId)
      .slice(0, 8);
    for (const s of sibs) {
      if (!have.has(s.id)) {
        extra.push(s);
        have.add(s.id);
      }
    }
  }
  return extra.length ? [...render, ...extra] : render;
}

/**
 * When focusing a region, graft that node's children (and light grandchildren)
 * so the zoomed area shows real nodes/labels — not empty dots.
 */
export function expandAroundFocus(
  full: Node[],
  render: Node[],
  focusId: number,
  childLimit = 28,
): Node[] {
  const next = ensurePathInTree(full, render, focusId);
  const have = new Set(next.map((n) => n.id));
  const extra: Node[] = [];

  const kids = full.filter((n) => n.parentId === focusId).slice(0, childLimit);
  for (const k of kids) {
    if (!have.has(k.id)) {
      extra.push(k);
      have.add(k.id);
    }
    // One level of grandchildren if the fan-out is small
    const grand = full.filter((n) => n.parentId === k.id).slice(0, 6);
    for (const g of grand) {
      if (!have.has(g.id)) {
        extra.push(g);
        have.add(g.id);
      }
    }
  }

  return extra.length ? [...next, ...extra] : next;
}

/**
 * Flat Dilpreet nodes → nested plain object for d3-hypertree dataloader.
 * IMPORTANT: pass a plain tree, NOT d3.hierarchy() — Hypertree calls hierarchy() itself.
 */
export function nodesToNested(nodes: Node[]): NestedNode {
  if (!nodes.length) throw new Error("nodesToNested: empty");

  const map = new Map<number, NestedNode>();
  for (const n of nodes) {
    map.set(n.id, { ...n, children: [] });
  }

  let root: NestedNode | undefined;
  for (const n of nodes) {
    const cur = map.get(n.id)!;
    if (n.parentId == null) {
      root = cur;
      continue;
    }
    const parent = map.get(n.parentId);
    if (parent) parent.children!.push(cur);
    else {
      // orphan — attach to root later
      if (!root) root = cur;
      else root.children!.push(cur);
    }
  }

  if (!root) throw new Error("nodesToNested: no root");

  // Leaves: drop empty children arrays (cleaner for d3.hierarchy)
  for (const cur of map.values()) {
    if (cur.children && cur.children.length === 0) delete cur.children;
  }

  return root;
}
