import { hierarchy } from "d3-hierarchy";
import type { Node } from "@/types/contracts";
import type { HypertreeInstance, HypertreeNode } from "@/lib/hypertree/loadHyt";

/**
 * Graft new nodes into a live d3-hypertree hierarchy without rebuilding it.
 *
 * Mirrors what Hypertree.initData does per node (mergeId / precalc / pathes /
 * layout), then re-runs weights + language init and asks the unit disk to
 * re-layout. layoutBergé positions each node lazily from its parent's wedge
 * during the cache pass, so new nodes need no explicit layout here.
 *
 * Returns the number of nodes actually added.
 */
export function graftNodes(tree: HypertreeInstance, delta: Node[]): number {
  if (!tree.data || !delta.length) return 0;

  const byId = new Map<number, HypertreeNode>();
  let maxMergeId = 0;
  tree.data.each((n) => {
    if (n.data?.id != null) byId.set(n.data.id, n);
    if ((n.mergeId ?? 0) > maxMergeId) maxMergeId = n.mergeId ?? 0;
  });

  const sorted = [...delta].sort((a, b) => a.depth - b.depth);
  const added: HypertreeNode[] = [];

  for (const d of sorted) {
    if (byId.has(d.id)) continue;
    const parent = d.parentId != null ? byId.get(d.parentId) : undefined;
    if (!parent) continue;

    // Fresh d3-hierarchy Node (gives us ancestors()/each()/etc.). Our Node has
    // no `children` property, so this is a single leaf.
    const hn = hierarchy({ ...d }) as unknown as HypertreeNode;
    hn.parent = parent;
    hn.depth = parent.depth + 1;
    hn.height = 0;
    hn.globelhtid = parent.globelhtid;
    hn.mergeId = ++maxMergeId;
    hn.precalc = {};
    hn.pathes = {};
    hn.layout = null;
    hn.layoutReference = null;

    (parent.children ??= []).push(hn);

    // Keep `height` consistent up the chain (d3-hierarchy invariant).
    let p: HypertreeNode | null = parent;
    let h = 1;
    while (p && p.height < h) {
      p.height = h;
      h += 1;
      p = p.parent;
    }

    byId.set(d.id, hn);
    added.push(hn);
  }

  if (!added.length) return 0;

  let count = 0;
  tree.data.each(() => {
    count += 1;
  });
  const cache = tree.args.geometry?.transformation?.cache;
  if (cache) cache.N = count;

  tree.updateWeights_?.();
  for (const n of added) {
    tree.args.dataInitBFS?.(tree, n);
    tree.args.langInitBFS?.(tree, n);
    n.precalc.clickable = true;
  }
  tree.updateLabelLen_?.();
  tree.update.data();

  return added.length;
}

/**
 * Make sure `n` (and its ancestors) have a layout so gotoNode can target it.
 * Same as Hypertree.updateLayoutPath_ but without moving the camera.
 */
export function ensurePathLayout(tree: HypertreeInstance, n: HypertreeNode) {
  const layoutType = tree.args.layout?.type;
  const λ = tree.args.geometry?.transformation?.state?.λ;
  if (!layoutType || λ == null) return;
  for (const a of n.ancestors().reverse()) {
    layoutType(a, λ, true);
  }
}
