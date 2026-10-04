// Poincaré-disk maths for the universe. Points are complex numbers inside the unit disk.
export type C = { re: number; im: number };

// The disk automorphism (a hyperbolic "translation") that slides `a` to the centre:
// z ↦ (z − a) / (1 − āz). Applying it to every point is what bends the universe.
export function toOrigin(z: C, a: C): C {
  const nr = z.re - a.re;
  const ni = z.im - a.im;
  const dr = 1 - (a.re * z.re + a.im * z.im);
  const di = -(a.re * z.im - a.im * z.re);
  const d = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / d, im: (ni * dr - nr * di) / d };
}

// Its inverse, sliding the centre back out to `a`: w ↦ (w + a) / (1 + āw).
export function fromOrigin(w: C, a: C): C {
  return toOrigin(w, { re: -a.re, im: -a.im });
}

// The point a fraction `s` of the way along the geodesic from the centre to `q`. Hyperbolic distance
// grows linearly with s, which makes flights feel even instead of rushing near the rim.
export function alongGeodesic(q: C, s: number): C {
  const r = Math.hypot(q.re, q.im);
  if (r < 1e-12) return { re: 0, im: 0 };
  const k = Math.tanh(s * Math.atanh(Math.min(r, 1 - 1e-12))) / r;
  return { re: q.re * k, im: q.im * k };
}

type TreeInput = { id: number; parentId: number | null };

const SPACING = 0.36; // hyperbolic arc length between neighbouring siblings
const MIN_EDGE = 0.95; // hyperbolic edge length bounds
const MAX_EDGE = 2.1;
const MAX_WEDGE = 1.4 * Math.PI; // how far a fan may open around its node

// Classic hyperbolic tree layout (Lamping & Rao). Each node fans its children out inside a wedge of its
// own local frame, sized by subtree weight. A child's wedge is its parent's wedge as seen from the child,
// which opens up quickly because hyperbolic space has exponentially more room further out.
export function layoutTree(nodes: TreeInput[]): Map<number, C> {
  const children = new Map<number, number[]>(nodes.map((node) => [node.id, []]));
  let rootId: number | null = null;
  for (const node of nodes) {
    if (node.parentId === null) rootId = node.id;
    else children.get(node.parentId)?.push(node.id);
  }
  if (rootId === null) throw new Error('The tree has no root');

  // Subtree sizes, children before parents.
  const order = [rootId];
  for (let i = 0; i < order.length; i++) order.push(...children.get(order[i])!);
  const size = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    size.set(id, 1 + children.get(id)!.reduce((sum, kid) => sum + size.get(kid)!, 0));
  }
  // The +1.2 floor keeps single articles from being squeezed into slivers beside big fields.
  const weight = (id: number) => Math.pow(size.get(id)!, 0.55) + 1.2;

  const pos = new Map<number, C>([[rootId, { re: 0, im: 0 }]]);
  const stack: [id: number, wedge: number, direction: number][] = [[rootId, 2 * Math.PI, -Math.PI / 2]];
  while (stack.length) {
    const [id, wedge, direction] = stack.pop()!;
    const kids = children.get(id)!;
    if (!kids.length) continue;
    const p = pos.get(id)!;
    const total = kids.reduce((sum, kid) => sum + weight(kid), 0);
    const edge = Math.min(MAX_EDGE, Math.max(MIN_EDGE, Math.asinh(Math.max(1, (kids.length * SPACING) / wedge))));
    const r = Math.tanh(edge / 2);
    let angle = direction - wedge / 2;
    for (const kid of kids) {
      const share = (wedge * weight(kid)) / total;
      const phi = angle + share / 2;
      const kidPos = fromOrigin({ re: r * Math.cos(phi), im: r * Math.sin(phi) }, p);
      pos.set(kid, kidPos);
      // Half-angle the kid's share subtends from the kid itself.
      const half = share / 2;
      const seen =
        Math.atan2(Math.sin(half), Math.cos(half) - r) - Math.atan2(-r * Math.sin(half), 1 - r * Math.cos(half));
      // The kid fans its own children away from its parent.
      const back = toOrigin(p, kidPos);
      stack.push([kid, Math.min(2 * seen * 0.92, MAX_WEDGE), Math.atan2(-back.im, -back.re)]);
      angle += share;
    }
  }
  return pos;
}
