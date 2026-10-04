// Canvas renderer for the Poincaré-disk universe. Implements the README renderer contract:
// loadTree, flyTo, highlight, addChildren, setMode, onSelect. It only draws when something changes.
import { alongGeodesic, fromOrigin, layoutTree, toOrigin, type C } from './geometry';

export type UNode = {
  id: number;
  title: string;
  summary: string;
  parentId: number | null;
  depth: number;
  url: string;
  type: string;
};
export type Mode = 'hyperbolic' | 'euclid';

type Pt = { x: number; y: number };
type Flight = { start: number; duration: number; from: C; target: C; flatFrom: Pt; flatTo: Pt; zoomFrom: number; zoomTo: number };
type Morph = { start: number; duration: number; from: number; to: number };
type Label = { i: number; x: number; y: number; w: number; h: number };

// Branch colours run around the disk from purple through blue to green.
const PALETTE: [number, number, number][] = [
  [191, 90, 242],
  [137, 104, 255],
  [94, 92, 230],
  [10, 132, 255],
  [90, 200, 250],
  [102, 212, 207],
  [48, 209, 88],
];
const ACCENT = '255, 214, 10'; // search highlights
const ROOT_RGB: [number, number, number] = [245, 245, 247];
const ALPHA_STEPS = 16;
const FLAT_ZOOM = 2.4;
const MAX_LABELS = 56;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

export class Universe {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly font: string;
  private nodes: UNode[] = [];
  private index = new Map<number, number>();
  private parent = new Int32Array(0);
  private isCategory = new Uint8Array(0);
  private branch = new Int32Array(0);
  private hx = new Float64Array(0); // hyperbolic layout
  private hy = new Float64Array(0);
  private fx = new Float64Array(0); // flat layout, for the Euclid comparison
  private fy = new Float64Array(0);
  private sx = new Float32Array(0); // screen positions this frame
  private sy = new Float32Array(0);
  private sf = new Float32Array(0); // how much room a node has here: 1 at the centre, 0 at the rim
  private branchRgb: [number, number, number][] = [];
  private styleCache = new Map<number, string>();
  private textWidths = new Map<string, number>();
  private labels: Label[] = [];

  private center: C = { re: 0, im: 0 };
  private flatCenter: Pt = { x: 0, y: 0 };
  private zoom = 1;
  private blend = 0; // 0 hyperbolic, 1 flat
  private focus = -1;
  private hover = -1;
  private highlighted = new Set<number>();
  private highlightPath = new Set<number>();
  private flight: Flight | null = null;
  private morph: Morph | null = null;
  private selectHandler: ((node: UNode) => void) | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private radius = 0;
  private ox = 0;
  private oy = 0;
  private raf = 0;
  private inset = 0; // room kept free on the right, e.g. for the node card
  private targetInset = 0;
  private pointer: { id: number; x: number; y: number; startX: number; startY: number; dragging: boolean } | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, { fontFamily }: { fontFamily: string }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.font = fontFamily;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resize();
  }

  // ── Renderer contract ────────────────────────────────────────────────────────────────

  loadTree(nodes: UNode[]) {
    const focusId = this.focus >= 0 ? this.nodes[this.focus]?.id : undefined;
    this.nodes = nodes;
    const n = nodes.length;
    this.index = new Map(nodes.map((node, i) => [node.id, i]));
    this.parent = new Int32Array(n);
    this.isCategory = new Uint8Array(n);
    nodes.forEach((node, i) => {
      this.parent[i] = node.parentId === null ? -1 : (this.index.get(node.parentId) ?? -1);
      this.isCategory[i] = node.type === 'category' ? 1 : 0;
    });

    const layout = layoutTree(nodes);
    this.hx = new Float64Array(n);
    this.hy = new Float64Array(n);
    nodes.forEach((node, i) => {
      const p = layout.get(node.id)!;
      this.hx[i] = p.re;
      this.hy[i] = p.im;
    });

    // Flat layout: same angles, rings spaced evenly. Crowds at the edge, which is the point.
    const maxDepth = Math.max(1, ...nodes.map((node) => node.depth));
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    nodes.forEach((node, i) => {
      const angle = Math.atan2(this.hy[i], this.hx[i]);
      const r = (node.depth / maxDepth) * 0.94;
      this.fx[i] = r * Math.cos(angle);
      this.fy[i] = r * Math.sin(angle);
    });

    // Each top-level branch gets a colour, ordered by its angle around the root.
    this.branch = new Int32Array(n).fill(-1);
    const tops = nodes
      .map((node, i) => ({ node, i }))
      .filter(({ node }) => node.depth === 1)
      .sort((a, b) => Math.atan2(this.hy[a.i], this.hx[a.i]) - Math.atan2(this.hy[b.i], this.hx[b.i]));
    const branchOfTop = new Map(tops.map(({ i }, k) => [i, k]));
    nodes.forEach((_, i) => {
      let j = i;
      while (j >= 0 && !branchOfTop.has(j)) j = this.parent[j];
      this.branch[i] = j >= 0 ? branchOfTop.get(j)! : -1;
    });
    this.branchRgb = tops.map((_, k) => paletteAt(tops.length > 1 ? k / (tops.length - 1) : 0));
    this.styleCache.clear();

    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sf = new Float32Array(n);
    this.highlighted.clear();
    this.highlightPath.clear();
    this.focus = focusId !== undefined && this.index.has(focusId) ? this.index.get(focusId)! : this.parent.indexOf(-1);
    this.center = { re: this.hx[this.focus], im: this.hy[this.focus] };
    this.flatCenter = { x: this.fx[this.focus], y: this.fy[this.focus] };
    this.invalidate();
  }

  flyTo(id: number) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.focus = i;
    const target = toOrigin({ re: this.hx[i], im: this.hy[i] }, this.center);
    const distance = 2 * Math.atanh(Math.min(Math.hypot(target.re, target.im), 1 - 1e-12));
    this.flight = {
      start: performance.now(),
      duration: 650 + 150 * Math.min(distance, 4),
      from: this.center,
      target,
      flatFrom: { ...this.flatCenter },
      flatTo: { x: this.fx[i], y: this.fy[i] },
      zoomFrom: this.zoom,
      zoomTo: this.nodes[i].depth === 0 ? 1 : FLAT_ZOOM,
    };
    this.invalidate();
  }

  highlight(ids: number[]) {
    this.highlighted = new Set(ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined));
    // Light up the branches leading to each match, too.
    this.highlightPath = new Set();
    for (const i of this.highlighted) for (let j = i; j >= 0; j = this.parent[j]) this.highlightPath.add(j);
    this.invalidate();
  }

  addChildren(_parentId: number, nodes: UNode[]) {
    this.loadTree([...this.nodes, ...nodes.filter((node) => !this.index.has(node.id))]);
  }

  setMode(mode: Mode) {
    this.morph = { start: performance.now(), duration: 750, from: this.blend, to: mode === 'euclid' ? 1 : 0 };
    if (mode === 'euclid') this.zoom = this.nodes[this.focus]?.depth ? FLAT_ZOOM : 1;
    this.invalidate();
  }

  onSelect(handler: (node: UNode) => void) {
    this.selectHandler = handler;
  }

  // Keep `px` free on the right (the node card); the disk glides over to make room.
  setRightInset(px: number) {
    this.targetInset = px;
    this.invalidate();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  // ── Frame loop ───────────────────────────────────────────────────────────────────────

  private invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const animating = this.step(now);
    this.draw(now);
    // Matches pulse gently, so keep drawing while there are any.
    if (animating || this.highlighted.size) this.raf = requestAnimationFrame(this.frame);
  };

  private step(now: number): boolean {
    let active = false;
    if (this.flight) {
      const f = this.flight;
      const t = clamp01((now - f.start) / f.duration);
      const e = easeInOut(t);
      this.center = fromOrigin(alongGeodesic(f.target, e), f.from);
      this.flatCenter = { x: f.flatFrom.x + (f.flatTo.x - f.flatFrom.x) * e, y: f.flatFrom.y + (f.flatTo.y - f.flatFrom.y) * e };
      this.zoom = f.zoomFrom + (f.zoomTo - f.zoomFrom) * e;
      if (t >= 1) this.flight = null;
      active = true;
    }
    if (this.morph) {
      const m = this.morph;
      const t = clamp01((now - m.start) / m.duration);
      this.blend = m.from + (m.to - m.from) * easeInOut(t);
      if (t >= 1) this.morph = null;
      active = true;
    }
    if (this.inset !== this.targetInset) {
      const gap = this.targetInset - this.inset;
      this.inset = Math.abs(gap) < 0.5 ? this.targetInset : this.inset + gap * 0.16;
      this.layoutViewport();
      active = true;
    }
    return active;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.layoutViewport();
    // Resizing clears the canvas, so redraw right away rather than flashing a blank frame.
    this.draw(performance.now());
    this.invalidate();
  }

  private layoutViewport() {
    const usable = this.width - this.inset;
    this.radius = Math.min(usable, this.height) * 0.46;
    this.ox = usable / 2;
    this.oy = this.height / 2 + Math.min(24, this.height * 0.02);
  }

  // Screen positions for every node: hyperbolic view, flat view, or a blend while morphing.
  private project() {
    const { re: cr, im: ci } = this.center;
    const m = this.blend;
    for (let i = 0; i < this.nodes.length; i++) {
      const zr = this.hx[i];
      const zi = this.hy[i];
      const nr = zr - cr;
      const ni = zi - ci;
      const dr = 1 - (cr * zr + ci * zi);
      const di = -(cr * zi - ci * zr);
      const d = dr * dr + di * di;
      let x = (nr * dr + ni * di) / d;
      let y = (ni * dr - nr * di) / d;
      let f = Math.max(0, 1 - (x * x + y * y));
      if (m > 0) {
        const ex = (this.fx[i] - this.flatCenter.x) * this.zoom;
        const ey = (this.fy[i] - this.flatCenter.y) * this.zoom;
        x += (ex - x) * m;
        y += (ey - y) * m;
        f += (0.5 - f) * m;
      }
      this.sx[i] = this.ox + x * this.radius;
      this.sy[i] = this.oy + y * this.radius;
      this.sf[i] = f;
    }
  }

  private draw(now: number) {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.nodes.length) return;
    this.project();
    const hyperbolic = 1 - this.blend;

    // The disk itself: a faint glow and a hairline rim.
    if (hyperbolic > 0.01) {
      const glow = ctx.createRadialGradient(this.ox, this.oy, 0, this.ox, this.oy, this.radius);
      glow.addColorStop(0, `rgba(64, 92, 180, ${0.16 * hyperbolic})`);
      glow.addColorStop(0.7, `rgba(40, 56, 120, ${0.07 * hyperbolic})`);
      glow.addColorStop(1, 'rgba(20, 28, 60, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.ox, this.oy, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.09 * hyperbolic})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const curved = this.blend < 0.5;
    const onScreen = (i: number) => this.sx[i] > -40 && this.sx[i] < this.width + 40 && this.sy[i] > -40 && this.sy[i] < this.height + 40;

    // Edges, batched by colour and opacity so the canvas changes style a few hundred times, not thousands.
    const edgeGroups = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.parent[i];
      if (p < 0) continue;
      const f = this.sf[i];
      if (f < 0.002 || (!onScreen(i) && !onScreen(p))) continue;
      const alpha = Math.min(0.55, 0.08 + 0.6 * Math.pow(f, 0.85));
      const key = this.styleKey(this.branch[i], alpha);
      (edgeGroups.get(key) ?? edgeGroups.set(key, []).get(key)!).push(i);
    }
    ctx.lineWidth = 1;
    for (const [key, edges] of edgeGroups) {
      ctx.strokeStyle = this.styleFor(key);
      ctx.beginPath();
      for (const i of edges) this.edgePath(i, this.parent[i], curved);
      ctx.stroke();
    }

    // Branches leading to search matches.
    if (this.highlightPath.size) {
      ctx.strokeStyle = `rgba(${ACCENT}, 0.75)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const i of this.highlightPath) if (this.parent[i] >= 0) this.edgePath(i, this.parent[i], curved);
      ctx.stroke();
    }

    // Nodes, batched the same way.
    const nodeGroups = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      if (!onScreen(i)) continue;
      const alpha = Math.min(1, 0.32 + 0.9 * Math.pow(this.sf[i], 0.6));
      const key = this.styleKey(this.branch[i], alpha);
      (nodeGroups.get(key) ?? nodeGroups.set(key, []).get(key)!).push(i);
    }
    for (const [key, group] of nodeGroups) {
      ctx.fillStyle = this.styleFor(key);
      ctx.beginPath();
      for (const i of group) {
        const r = this.nodeRadius(i);
        ctx.moveTo(this.sx[i] + r, this.sy[i]);
        ctx.arc(this.sx[i], this.sy[i], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Search matches pulse.
    if (this.highlighted.size) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 380);
      for (const i of this.highlighted) {
        if (!onScreen(i)) continue;
        const r = this.nodeRadius(i);
        ctx.fillStyle = `rgba(${ACCENT}, ${0.18 + 0.12 * pulse})`;
        ctx.beginPath();
        ctx.arc(this.sx[i], this.sy[i], r + 5 + 4 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgb(${ACCENT})`;
        ctx.beginPath();
        ctx.arc(this.sx[i], this.sy[i], Math.max(2, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.hover >= 0 && this.hover !== this.focus) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this.sx[this.hover], this.sy[this.hover], this.nodeRadius(this.hover) + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.drawReticle();
    this.drawLabels();
  }

  // A focus ring with corner brackets around the node at the centre.
  private drawReticle() {
    const i = this.focus;
    if (i < 0) return;
    const { ctx } = this;
    const x = this.sx[i];
    const y = this.sy[i];
    const r = this.nodeRadius(i) + 6;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    const s = r + 9;
    const l = 6;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + dx * s, y + dy * (s - l));
      ctx.lineTo(x + dx * s, y + dy * s);
      ctx.lineTo(x + dx * (s - l), y + dy * s);
    }
    ctx.stroke();
  }

  // Labels go to the nodes with the most room, biggest first, skipping any that would collide.
  private drawLabels() {
    const { ctx } = this;
    const candidates: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.sf[i] > 0.14 || i === this.focus || this.highlighted.has(i) || i === this.hover) candidates.push(i);
    }
    const priority = (i: number) =>
      (i === this.focus ? 100 : 0) + (i === this.hover ? 50 : 0) + (this.highlighted.has(i) ? 20 : 0) + this.sf[i] * (this.isCategory[i] ? 1.6 : 1);
    candidates.sort((a, b) => priority(b) - priority(a));

    this.labels = [];
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const i of candidates) {
      if (this.labels.length >= MAX_LABELS) break;
      const node = this.nodes[i];
      const focused = i === this.focus;
      const category = this.isCategory[i] === 1;
      const f = this.sf[i];
      const size = focused ? 17 : category ? 10 + 3 * f : 10.5 + 3.5 * f;
      const text = category && !focused ? node.title.toUpperCase() : node.title;
      const font = `${focused || category ? 600 : 400} ${size.toFixed(1)}px ${this.font}`;
      ctx.font = font;
      ctx.letterSpacing = category && !focused ? '0.08em' : '0px';
      const width = this.measure(text, font, ctx.letterSpacing);
      const r = this.nodeRadius(i);
      const h = size + 4;
      const x = focused ? this.sx[i] - width / 2 : this.sx[i] + r + 6;
      const y = focused ? this.sy[i] + r + 30 : this.sy[i];
      const box = { i, x: x - 3, y: y - h / 2, w: width + 6, h };
      if (box.x + box.w < 0 || box.x > this.width || box.y + box.h < 0 || box.y > this.height) continue;
      if (this.labels.some((other) => overlaps(box, other))) continue;
      this.labels.push(box);

      const fade = focused || this.highlighted.has(i) || i === this.hover ? 1 : clamp01((f - 0.14) / 0.3);
      ctx.strokeStyle = `rgba(6, 9, 20, ${0.85 * fade})`;
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = this.highlighted.has(i)
        ? `rgba(${ACCENT}, ${fade})`
        : category || focused
          ? `rgba(245, 245, 247, ${0.95 * fade})`
          : `rgba(235, 235, 245, ${0.62 * fade})`;
      ctx.fillText(text, x, y);
    }
    ctx.letterSpacing = '0px';
  }

  private edgePath(i: number, p: number, curved: boolean) {
    const { ctx } = this;
    const x1 = this.sx[p];
    const y1 = this.sy[p];
    const x2 = this.sx[i];
    const y2 = this.sy[i];
    if (curved) {
      // Hyperbolic lines are arcs of circles that meet the rim at right angles.
      const ax = (x1 - this.ox) / this.radius;
      const ay = (y1 - this.oy) / this.radius;
      const bx = (x2 - this.ox) / this.radius;
      const by = (y2 - this.oy) / this.radius;
      const cross = ax * by - ay * bx;
      if (Math.abs(cross) > 1e-6) {
        const da = (ax * ax + ay * ay + 1) / 2;
        const db = (bx * bx + by * by + 1) / 2;
        const cx = (da * by - ay * db) / cross;
        const cy = (ax * db - bx * da) / cross;
        const r = Math.hypot(ax - cx, ay - cy);
        if (r < 60) {
          const a0 = Math.atan2(ay - cy, ax - cx);
          const a1 = Math.atan2(by - cy, bx - cx);
          let sweep = a1 - a0;
          if (sweep > Math.PI) sweep -= 2 * Math.PI;
          if (sweep < -Math.PI) sweep += 2 * Math.PI;
          ctx.moveTo(x1, y1);
          ctx.arc(this.ox + cx * this.radius, this.oy + cy * this.radius, r * this.radius, a0, a1, sweep < 0);
          return;
        }
      }
    }
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }

  private nodeRadius(i: number) {
    const base = this.parent[i] < 0 ? 6.5 : this.isCategory[i] ? 4.6 : 2.6;
    return Math.max(0.6, base * (0.12 + 0.88 * this.sf[i]));
  }

  private styleKey(branch: number, alpha: number) {
    return (branch + 1) * ALPHA_STEPS + Math.round(alpha * (ALPHA_STEPS - 1));
  }

  private styleFor(key: number) {
    let style = this.styleCache.get(key);
    if (!style) {
      const branch = Math.floor(key / ALPHA_STEPS) - 1;
      const alpha = (key % ALPHA_STEPS) / (ALPHA_STEPS - 1);
      const [r, g, b] = branch >= 0 ? this.branchRgb[branch] : ROOT_RGB;
      style = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
      this.styleCache.set(key, style);
    }
    return style;
  }

  private measure(text: string, font: string, spacing: string) {
    const key = `${font}|${spacing}|${text}`;
    let width = this.textWidths.get(key);
    if (width === undefined) {
      width = this.ctx.measureText(text).width;
      this.textWidths.set(key, width);
    }
    return width;
  }

  // ── Interaction ──────────────────────────────────────────────────────────────────────

  private nodeAt(x: number, y: number): number {
    for (let k = this.labels.length - 1; k >= 0; k--) {
      const label = this.labels[k];
      if (x >= label.x && x <= label.x + label.w && y >= label.y && y <= label.y + label.h) return label.i;
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const reach = this.nodeRadius(i) + 7;
      const d = (this.sx[i] - x) ** 2 + (this.sy[i] - y) ** 2;
      if (d < reach * reach && d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
    return best;
  }

  private local(e: PointerEvent | WheelEvent): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Drag the plane: the point under the cursor follows it, by a hyperbolic translation.
  private pan(x0: number, y0: number, x1: number, y1: number) {
    this.flight = null;
    if (this.blend < 0.5) {
      const toDisk = (x: number, y: number): C => {
        const re = (x - this.ox) / this.radius;
        const im = (y - this.oy) / this.radius;
        const r = Math.hypot(re, im);
        return r > 0.95 ? { re: (re / r) * 0.95, im: (im / r) * 0.95 } : { re, im };
      };
      const w0 = toDisk(x0, y0);
      const w1 = toDisk(x1, y1);
      const shift = toOrigin({ re: -w1.re, im: -w1.im }, { re: -w0.re, im: -w0.im });
      const next = fromOrigin(shift, this.center);
      const r = Math.hypot(next.re, next.im);
      this.center = r < 0.999999 ? next : { re: (next.re / r) * 0.999999, im: (next.im / r) * 0.999999 };
    } else {
      this.flatCenter = {
        x: this.flatCenter.x - (x1 - x0) / this.radius / this.zoom,
        y: this.flatCenter.y - (y1 - y0) / this.radius / this.zoom,
      };
    }
    this.invalidate();
  }

  private onPointerDown = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    this.pointer = { id: e.pointerId, x, y, startX: x, startY: y, dragging: false };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    const p = this.pointer;
    if (p && p.id === e.pointerId) {
      if (!p.dragging && Math.hypot(x - p.startX, y - p.startY) > 4) {
        p.dragging = true;
        this.canvas.style.cursor = 'grabbing';
      }
      if (p.dragging) this.pan(p.x, p.y, x, y);
      p.x = x;
      p.y = y;
      return;
    }
    const hover = this.nodeAt(x, y);
    if (hover !== this.hover) {
      this.hover = hover;
      this.canvas.style.cursor = hover >= 0 ? 'pointer' : 'grab';
      this.invalidate();
    }
  };

  private onPointerUp = () => {
    const p = this.pointer;
    this.pointer = null;
    this.canvas.style.cursor = this.hover >= 0 ? 'pointer' : 'grab';
    if (!p || p.dragging) return;
    const i = this.nodeAt(p.startX, p.startY);
    if (i >= 0) this.selectHandler?.(this.nodes[i]);
  };

  private onPointerLeave = () => {
    if (this.hover >= 0) {
      this.hover = -1;
      this.invalidate();
    }
  };

  // Trackpad scrolling glides across the plane too.
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.pan(this.ox, this.oy, this.ox - e.deltaX * 0.5, this.oy - e.deltaY * 0.5);
  };
}

function paletteAt(t: number): [number, number, number] {
  const scaled = t * (PALETTE.length - 1);
  const k = Math.min(PALETTE.length - 2, Math.floor(scaled));
  const u = scaled - k;
  const [a, b] = [PALETTE[k], PALETTE[k + 1]];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * u)) as [number, number, number];
}

function overlaps(a: Omit<Label, 'i'>, b: Omit<Label, 'i'>) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
