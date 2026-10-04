import type { Node } from "@/types/contracts";
import { type C, ZERO, c, clampToDisk } from "./complex";
import { mobiusFromOrigin } from "./mobius";

const STEP = 0.48;

function childrenMap(nodes: Node[]): Map<number | null, Node[]> {
  const map = new Map<number | null, Node[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const list = map.get(key) ?? [];
    list.push(node);
    map.set(key, list);
  }
  // Stable order by title for deterministic wedges
  for (const [, list] of map) {
    list.sort((a, b) => a.title.localeCompare(b.title));
  }
  return map;
}

function rootOf(nodes: Node[]): Node {
  const root = nodes.find((n) => n.parentId === null) ?? nodes[0];
  if (!root) throw new Error("No nodes for layout");
  return root;
}

/** Place Dilpreet’s tree in the Poincaré disk via recursive Möbius offsets. */
export function layoutHyperbolic(nodes: Node[]): Map<number, C> {
  const positions = new Map<number, C>();
  if (!nodes.length) return positions;

  const kids = childrenMap(nodes);
  const root = rootOf(nodes);

  function visit(node: Node, pos: C, angle: number, wedge: number) {
    positions.set(node.id, clampToDisk(pos));
    const children = kids.get(node.id) ?? [];
    if (!children.length) return;

    const span = wedge * 0.94;
    const start = angle - span / 2;
    const step = span / children.length;

    children.forEach((child, i) => {
      const a = start + step * (i + 0.5);
      const local = c(
        Math.tanh(STEP / 2) * Math.cos(a),
        Math.tanh(STEP / 2) * Math.sin(a),
      );
      visit(child, mobiusFromOrigin(pos, local), a, step);
    });
  }

  visit(root, ZERO, -Math.PI / 2, Math.PI * 2);
  return positions;
}

export function layoutEuclid(nodes: Node[]): Map<number, C> {
  const positions = new Map<number, C>();
  if (!nodes.length) return positions;

  const kids = childrenMap(nodes);
  const root = rootOf(nodes);
  const levelGap = 88;
  const leafGap = 12;

  function leaves(node: Node): number {
    const ch = kids.get(node.id) ?? [];
    if (!ch.length) return 1;
    return ch.reduce((s, k) => s + leaves(k), 0);
  }

  function visit(node: Node, depth: number, x0: number): number {
    const ch = kids.get(node.id) ?? [];
    const width = leaves(node) * leafGap;
    if (!ch.length) {
      positions.set(node.id, c(x0 + width / 2, depth * levelGap));
      return width;
    }
    let x = x0;
    for (const child of ch) x += visit(child, depth + 1, x);
    positions.set(node.id, c(x0 + width / 2, depth * levelGap));
    return width;
  }

  const total = leaves(root) * leafGap;
  visit(root, 0, -total / 2);
  const rp = positions.get(root.id) ?? ZERO;
  for (const [id, p] of positions) {
    positions.set(id, c(p.re - rp.re, p.im - rp.im));
  }
  return positions;
}

export function edgeList(nodes: Node[]): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (const n of nodes) {
    if (n.parentId != null) edges.push([n.parentId, n.id]);
  }
  return edges;
}
