// Canvas renderer for the Poincaré-disk universe. Implements the README renderer contract:
// loadTree, flyTo, highlight, addChildren, setMode, onSelect. It only draws when something changes.
import { alongGeodesic, enclosingCenter, fromOrigin, layoutTree, toOrigin, type C } from './geometry';

export type UNode = {
  id: number;
  title: string;
  summary: string;
  parentId: number | null;
  depth: number;
  url: string;
  type: string;
  reason?: string; // why Gemini put a grown node here (Expand)
};
export type Mode = 'hyperbolic' | 'euclid';
export type ThemeName = 'dark' | 'light';

type Pt = { x: number; y: number };
type RGB = [number, number, number];
type Flight = { start: number; duration: number; from: C; target: C; flatFrom: Pt; flatTo: Pt; zoomFrom: number; zoomTo: number };
type Morph = { start: number; duration: number; from: number; to: number };
// After addChildren: every node glides from where it was (new ones from their parent) to the new layout.
// `camera` keeps the view steady while the layout shifts, until a flight or a drag takes over.
type Growth = { start: number; duration: number; fromH: Float64Array; fromF: Float64Array; camera: { from: C; to: C } | null };
type ZoomAnimation = { start: number; duration: number; fromScale: number; toScale: number; fromOffset: Pt; toOffset: Pt };
type Label = { i: number; x: number; y: number; w: number; h: number };
export type Insets = { top: number; right: number; bottom: number; left: number };
type Theme = {
  palette: RGB[]; // branch colours, run around the disk from purple through blue to green
  root: RGB;
  accent: string; // search highlights
  label: string;
  labelSoft: string;
  labelSoftAlpha: number;
  halo: string; // outline that keeps labels readable over edges
  ink: string; // focus ring and hover ring
  glow: string;
  glowAlpha: number;
  rimAlpha: number;
  inkBoost: number; // pale lines wash out on a light background, so they are drawn stronger there
  disk: { fill: string; shadow: string } | null; // a lit surface under the universe, light theme only
};

const THEMES: Record<ThemeName, Theme> = {
  dark: {
    palette: [
      [191, 90, 242],
      [137, 104, 255],
      [94, 92, 230],
      [10, 132, 255],
      [90, 200, 250],
      [102, 212, 207],
      [48, 209, 88],
    ],
    root: [245, 245, 247],
    accent: '255, 214, 10',
    label: '245, 245, 247',
    labelSoft: '235, 235, 245',
    labelSoftAlpha: 0.62,
    halo: '6, 9, 20',
    ink: '255, 255, 255',
    glow: '64, 92, 180',
    glowAlpha: 0.16,
    rimAlpha: 0.09,
    inkBoost: 1,
    disk: null,
  },
  // Deeper, richer versions of the same hues, so lines and dots hold up on white.
  light: {
    palette: [
      [142, 58, 200],
      [104, 70, 226],
      [64, 74, 206],
      [0, 102, 214],
      [0, 128, 178],
      [0, 136, 124],
      [30, 140, 70],
    ],
    root: [29, 29, 31],
    accent: '240, 120, 0',
    label: '29, 29, 31',
    labelSoft: '72, 72, 80',
    labelSoftAlpha: 0.78,
    halo: '255, 255, 255',
    ink: '29, 29, 31',
    glow: '0, 113, 227',
    glowAlpha: 0.05,
    rimAlpha: 0.1,
    inkBoost: 1.3,
    disk: { fill: 'rgba(255, 255, 255, 0.82)', shadow: 'rgba(40, 60, 120, 0.12)' },
  },
};

const ALPHA_STEPS = 16;
const FLAT_ZOOM = 2.4;
const MAX_LABELS = 56;
const MIN_MAGNIFY = 0.7;
const SEARCH_FADE = 0.6; // how much of everything that isn't a match (or on the way to one) fades during a search
// The field lens that follows the mouse over the disk.
const LENS_PUSH = 0.9; // fisheye strength: points near the cursor spread out by up to 1.9×
const LENS_GROW = 0.45; // how much more room (and so size and labels) the hovered field's topics get
const LENS_DIM = 0.6; // how much other fields' topics inside the lens fade
// Out toward the rim topics are packed tightly, so the lens grows and magnifies more there: up to
// (1 + 1.4) × LENS_PUSH ≈ 2.2×, still under 3, so it stays monotonic.
const LENS_RIM_BOOST = 1.4;
const CLICK_ZOOM = 1.8; // clicking empty space zooms in this much
const MAX_MAGNIFY = 8;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Universe {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly font: string;
  private theme: Theme = THEMES.dark;
  private nodes: UNode[] = [];
  private index = new Map<number, number>();
  private parent = new Int32Array(0);
  private isCategory = new Uint8Array(0);
  private branch = new Int32Array(0);
  private branchPosition: number[] = []; // each branch's place along the palette, 0..1
  private hx = new Float64Array(0); // hyperbolic layout
  private hy = new Float64Array(0);
  private fx = new Float64Array(0); // flat layout, for the Euclid comparison
  private fy = new Float64Array(0);
  private sx = new Float32Array(0); // screen positions this frame
  private sy = new Float32Array(0);
  private sf = new Float32Array(0); // how much room a node has on screen: about 1 at the centre, 0 at the rim
  private branchRgb: RGB[] = [];
  private styleCache = new Map<number, string>();
  private textWidths = new Map<string, number>();
  private labels: Label[] = [];

  private center: C = { re: 0, im: 0 };
  private flatCenter: Pt = { x: 0, y: 0 };
  private zoom = 1; // flat-mode zoom on the focused node
  private blend = 0; // 0 hyperbolic, 1 flat
  private focus = -1;
  private hover = -1;
  private highlighted = new Set<number>();
  private highlightPath = new Set<number>();
  private dim = 0; // 0 → 1 as a search's non-matches fade back, eased in step()
  private flight: Flight | null = null;
  private growth: Growth | null = null;
  private route: number[] = []; // stops still to visit on a flyAlong tour
  private routeEnd: { ids: number[]; focusId: number } | null = null; // framed once the tour is over
  private gx = new Float64Array(0); // positions mid-growth (hyperbolic, then flat)
  private gy = new Float64Array(0);
  private gfx = new Float64Array(0);
  private gfy = new Float64Array(0);
  private morph: Morph | null = null;
  private zoomAnimation: ZoomAnimation | null = null;
  private selectHandler: ((node: UNode) => void) | null = null;
  private hoverHandler: ((node: UNode | null) => void) | null = null;
  private settleHandler: ((node: UNode | null) => void) | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private lens = false; // the geometry lens: rings of equal hyperbolic distance
  // Field lens: follows the mouse over the disk, spreading nodes apart like a fisheye and bringing out
  // the field (top-level branch) under the cursor.
  private mouse: Pt | null = null; // mouse or pen over the canvas; touch has no hover
  private lensAmount = 0; // eased 0 → 1 while the mouse is over the disk
  private lensBranch = -1; // the field under the cursor
  private lensSince = 0; // when that field was entered, so its topics can pop in
  private lensWeight = new Float32Array(0); // per node: 0 outside the lens, up to 1 at its centre
  private branchTop: number[] = []; // each field's top-level node
  private branchSize: number[] = [];
  private intro: number | null = null; // 0 → 1 while the universe unfolds (unfold, or the opening titles' setIntro)
  private introAlpha = new Float32Array(0); // per node, how far it has faded in during the unfolding
  private unfolding: { start: number; duration: number } | null = null; // an unfold() playing by itself
  private readonly calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  private width = 0;
  private height = 0;
  private dpr = 1;
  // The resting disk fits the screen. `magnify` scales it like a lens and `offset` moves it, so you can
  // zoom into any spot; ox, oy and radius are the result, and everything else draws from them.
  private baseRadius = 0;
  private baseOx = 0;
  private baseOy = 0;
  private magnify = 1;
  private offset: Pt = { x: 0, y: 0 };
  private radius = 0;
  private ox = 0;
  private oy = 0;
  private inset: Insets = { top: 0, right: 0, bottom: 0, left: 0 }; // room kept free for panels, e.g. the node card
  private targetInset: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private raf = 0;
  private pointer: { id: number; x: number; y: number; startX: number; startY: number; dragging: boolean } | null = null;
  private touches = new Map<number, Pt>();
  private pinchDistance = 0;
  private gestureScale = 1;
  private gesturing = false;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, { fontFamily, theme = 'dark' }: { fontFamily: string; theme?: ThemeName }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.font = fontFamily;
    this.theme = THEMES[theme];
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // Safari reports trackpad pinches as gesture events rather than ctrl+wheel.
    canvas.addEventListener('gesturestart', this.onGestureStart);
    canvas.addEventListener('gesturechange', this.onGestureChange);
    canvas.addEventListener('gestureend', this.onGestureEnd);
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
    this.branchPosition = tops.map((_, k) => (tops.length > 1 ? k / (tops.length - 1) : 0));
    this.branchTop = tops.map(({ i }) => i);
    this.branchSize = tops.map(() => 0);
    for (let i = 0; i < n; i++) if (this.branch[i] >= 0) this.branchSize[this.branch[i]]++;
    this.recolor();

    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sf = new Float32Array(n);
    this.lensWeight = new Float32Array(n);
    this.introAlpha = new Float32Array(n).fill(1);
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
    this.route = [];
    this.routeEnd = null;
    this.flyToIndex(i);
  }

  // Fly through `ids` one after another, a little quicker per hop than flyTo: e.g. the path between two
  // topics, up to the field they share and back down. Then pull back to frame the whole path, so both
  // ends are in view. Any other flight or a drag ends the tour.
  flyAlong(ids: number[]) {
    const stops = ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined);
    if (!stops.length) return;
    this.route = stops.slice(1);
    this.routeEnd = { ids, focusId: ids[ids.length - 1] };
    this.flyToIndex(stops[0], 0.6);
  }

  // Hyperbolic distance between two topics, in the same units as the lens rings.
  distanceBetween(a: number, b: number): number | null {
    const i = this.index.get(a);
    const j = this.index.get(b);
    if (i === undefined || j === undefined) return null;
    const z = toOrigin({ re: this.hx[i], im: this.hy[i] }, { re: this.hx[j], im: this.hy[j] });
    return 2 * Math.atanh(Math.min(Math.hypot(z.re, z.im), 1 - 1e-12));
  }

  private flyToIndex(i: number, pace = 1) {
    this.focus = i;
    this.flyToPoint({ re: this.hx[i], im: this.hy[i] }, { x: this.fx[i], y: this.fy[i] }, this.nodes[i].depth === 0 ? 1 : FLAT_ZOOM, pace);
  }

  // Fly to where all of `ids` are in view together (e.g. every search match) instead of putting one
  // at the centre, which would push the rest out to the rim. `focusId` keeps the focus ring on one.
  flyToAll(ids: number[], focusId?: number) {
    const members = ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined);
    if (!members.length) return;
    const focus = focusId === undefined ? undefined : this.index.get(focusId);
    this.route = [];
    this.routeEnd = null;
    this.focus = focus ?? members[0];
    if (members.length === 1) {
      this.flyTo(this.nodes[members[0]].id);
      return;
    }
    const center = enclosingCenter(members.map((i) => ({ re: this.hx[i], im: this.hy[i] })));
    // Flat view: centre their bounding box and zoom until it fills most of the disk.
    const xs = members.map((i) => this.fx[i]);
    const ys = members.map((i) => this.fy[i]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const extent = Math.max(maxX - minX, maxY - minY) / 2;
    const zoom = Math.min(FLAT_ZOOM, Math.max(1, 0.8 / Math.max(extent, 1e-3)));
    this.flyToPoint(center, { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, zoom);
  }

  // `ancestors: false` lights just these nodes and the edges between them, e.g. the path between two
  // topics, instead of every branch back to the root.
  highlight(ids: number[], { ancestors = true }: { ancestors?: boolean } = {}) {
    this.highlighted = new Set(ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined));
    // Light up the branches leading to each match, too.
    this.highlightPath = new Set();
    for (const i of this.highlighted) {
      if (ancestors) for (let j = i; j >= 0; j = this.parent[j]) this.highlightPath.add(j);
      else this.highlightPath.add(i);
    }
    this.invalidate();
  }

  // New branches grow out of their parent: the tree is laid out again with them, and every node glides
  // from its old place to its new one along a geodesic, the new ones starting at the parent.
  addChildren(parentId: number, nodes: UNode[]) {
    const fresh = nodes.filter((node) => !this.index.has(node.id));
    if (!fresh.length) return;
    const before = new Map(this.nodes.map((node, i) => [node.id, i]));
    const oldHx = this.hx;
    const oldHy = this.hy;
    const oldFx = this.fx;
    const oldFy = this.fy;
    const oldFocus = this.focus >= 0 ? { re: oldHx[this.focus], im: oldHy[this.focus] } : null;
    const centerFrom = this.center;
    const lit = [...this.highlighted].map((i) => this.nodes[i].id);

    this.loadTree([...this.nodes, ...fresh]);
    this.highlight(lit);

    const n = this.nodes.length;
    const fromH = new Float64Array(2 * n);
    const fromF = new Float64Array(2 * n);
    const parentBefore = before.get(parentId);
    this.nodes.forEach((node, i) => {
      const j = before.get(node.id) ?? parentBefore;
      fromH[2 * i] = j === undefined ? this.hx[i] : oldHx[j];
      fromH[2 * i + 1] = j === undefined ? this.hy[i] : oldHy[j];
      fromF[2 * i] = j === undefined ? this.fx[i] : oldFx[j];
      fromF[2 * i + 1] = j === undefined ? this.fy[i] : oldFy[j];
    });
    // Keep the camera where it was relative to the focused node, which may itself move a little.
    const newFocus = { re: this.hx[this.focus], im: this.hy[this.focus] };
    const centerTo = oldFocus ? fromOrigin(toOrigin(centerFrom, oldFocus), newFocus) : newFocus;
    this.center = centerFrom;
    this.gx = new Float64Array(n);
    this.gy = new Float64Array(n);
    this.gfx = new Float64Array(n);
    this.gfy = new Float64Array(n);
    this.growth = { start: performance.now(), duration: 950, fromH, fromF, camera: { from: centerFrom, to: centerTo } };
    // A flight under way was aimed at the old layout; re-aim it at the focused node's new place.
    if (this.flight) this.flyTo(this.nodes[this.focus].id);
    this.invalidate();
  }

  setMode(mode: Mode) {
    this.morph = { start: performance.now(), duration: 750, from: this.blend, to: mode === 'euclid' ? 1 : 0 };
    if (mode === 'euclid') this.zoom = this.nodes[this.focus]?.depth ? FLAT_ZOOM : 1;
    this.invalidate();
  }

  onSelect(handler: (node: UNode) => void) {
    this.selectHandler = handler;
  }

  // ── Beyond the contract: the geometry lens ───────────────────────────────────────────

  // Rings one unit of hyperbolic distance apart around the centre, and around whatever is under the
  // pointer, so you can see the geometry the layout lives in.
  setLens(on: boolean) {
    this.lens = on;
    this.invalidate();
  }

  onHover(handler: (node: UNode | null) => void) {
    this.hoverHandler = handler;
  }

  // Called when the camera comes to rest (a flight lands, or a drag or scroll stops) with the topic
  // nearest the middle of the view, or null if nothing is near it. Used to grow the map at its edges.
  onSettle(handler: (node: UNode | null) => void) {
    this.settleHandler = handler;
  }

  private settleSoon(delay: number) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.flight || this.pointer?.dragging || !this.settleHandler) return;
      // Mid-unfold, topics are still on their way out from the centre; wait until they're in place.
      if (this.intro !== null) return this.settleSoon(250);
      let nearest = -1;
      let best = (this.radius * 0.22) ** 2;
      for (let i = 0; i < this.nodes.length; i++) {
        const d2 = (this.sx[i] - this.ox) ** 2 + (this.sy[i] - this.oy) ** 2;
        if (d2 < best) {
          best = d2;
          nearest = i;
        }
      }
      this.settleHandler(nearest >= 0 ? this.nodes[nearest] : null);
    }, delay);
  }

  // Zoom into a spot on the disk, bringing it toward the middle of the view.
  private zoomInto(x: number, y: number) {
    const scale = Math.min(MAX_MAGNIFY, this.magnify * CLICK_ZOOM);
    if (scale <= this.magnify + 1e-3) return;
    const u = (x - this.ox) / this.radius;
    const v = (y - this.oy) / this.radius;
    const radius = this.baseRadius * scale;
    this.animateView(scale, { x: -u * radius, y: -v * radius }, 460);
  }

  // How far a node is from the centre of the view: in hyperbolic distance, and as the fraction of the
  // way to the rim it is drawn at (tanh(d / 2), which never reaches 1).
  distanceFromCenter(id: number): { hyperbolic: number; drawn: number } | null {
    const i = this.index.get(id);
    if (i === undefined) return null;
    const z = toOrigin({ re: this.hx[i], im: this.hy[i] }, this.center);
    const drawn = Math.min(Math.hypot(z.re, z.im), 1 - 1e-12);
    return { hyperbolic: 2 * Math.atanh(drawn), drawn };
  }

  // ── Beyond the contract: zoom, theme, layout ─────────────────────────────────────────

  zoomBy(factor: number) {
    // Buttons and keys zoom around the middle of the disk.
    const scale = Math.min(MAX_MAGNIFY, Math.max(MIN_MAGNIFY, this.magnify * factor));
    const k = scale / this.magnify;
    this.animateView(scale, { x: this.offset.x * k, y: this.offset.y * k }, 320);
  }

  resetZoom() {
    this.animateView(1, { x: 0, y: 0 }, 480);
  }

  // The universe unfolds from its centre: at 0 nothing shows yet, and as `progress` runs to 1 every
  // topic flies out along its geodesic, nearest first, while the rim draws itself around them. null
  // (or 1) is the universe as usual. The opening titles (?intro) drive this frame by frame.
  setIntro(progress: number | null) {
    this.unfolding = null;
    this.applyIntro(progress);
    this.invalidate();
  }

  // Plays the unfolding by itself, as the page loads. The clock starts on the first frame drawn, so
  // the work of loading the page doesn't eat into it.
  unfold(duration = 2300) {
    if (this.calm) return this.setIntro(null);
    this.applyIntro(0);
    this.unfolding = { start: -1, duration };
    this.invalidate();
  }

  private applyIntro(progress: number | null) {
    this.intro = progress === null || progress >= 1 ? null : Math.max(0, progress);
    if (this.intro === null) this.introAlpha.fill(1);
    this.applyView();
  }

  setTheme(name: ThemeName) {
    this.theme = THEMES[name];
    this.recolor();
    this.invalidate();
  }

  // Keep room free at the edges for panels (the node card, the search suggestions); the disk glides
  // over to make room, shrinking only if the space left is narrower than the screen is tall.
  setInsets(insets: Partial<Insets>) {
    this.targetInset = { top: 0, right: 0, bottom: 0, left: 0, ...insets };
    this.invalidate();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('gesturestart', this.onGestureStart);
    this.canvas.removeEventListener('gesturechange', this.onGestureChange);
    this.canvas.removeEventListener('gestureend', this.onGestureEnd);
  }

  // ── Frame loop ───────────────────────────────────────────────────────────────────────

  // Glide the centre of the disk to `point` (and the flat view to `flatTo` at `zoomTo`).
  // `pace` scales the duration, e.g. shorter hops on a tour.
  private flyToPoint(point: C, flatTo: Pt, zoomTo: number, pace = 1) {
    if (this.growth) this.growth.camera = null; // the flight drives the camera from here
    const target = toOrigin(point, this.center);
    const distance = 2 * Math.atanh(Math.min(Math.hypot(target.re, target.im), 1 - 1e-12));
    const duration = (650 + 150 * Math.min(distance, 4)) * pace;
    this.flight = {
      start: performance.now(),
      duration,
      from: this.center,
      target,
      flatFrom: { ...this.flatCenter },
      flatTo,
      zoomFrom: this.zoom,
      zoomTo,
    };
    // When zoomed into a spot off to one side, drift back so the destination lands on screen,
    // keeping any zoom change already under way (e.g. the reset that "back to the centre" starts).
    if (this.offset.x || this.offset.y) {
      this.animateView(this.zoomAnimation?.toScale ?? this.magnify, { x: 0, y: 0 }, duration);
    }
    this.invalidate();
  }

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
      this.flatCenter = { x: lerp(f.flatFrom.x, f.flatTo.x, e), y: lerp(f.flatFrom.y, f.flatTo.y, e) };
      this.zoom = lerp(f.zoomFrom, f.zoomTo, e);
      if (t >= 1) {
        this.flight = null;
        const next = this.route.shift();
        if (next !== undefined) this.flyToIndex(next, 0.6);
        else if (this.routeEnd) {
          const { ids, focusId } = this.routeEnd;
          this.routeEnd = null;
          this.flyToAll(ids, focusId);
        } else this.settleSoon(120);
      }
      active = true;
    }
    if (this.morph) {
      const m = this.morph;
      const t = clamp01((now - m.start) / m.duration);
      this.blend = lerp(m.from, m.to, easeInOut(t));
      if (t >= 1) this.morph = null;
      active = true;
    }
    if (this.growth) {
      const g = this.growth;
      const t = clamp01((now - g.start) / g.duration);
      const e = 1 - Math.pow(1 - t, 3); // ease out: branches shoot out, then settle
      for (let i = 0; i < this.nodes.length; i++) {
        const from = { re: g.fromH[2 * i], im: g.fromH[2 * i + 1] };
        const z = fromOrigin(alongGeodesic(toOrigin({ re: this.hx[i], im: this.hy[i] }, from), e), from);
        this.gx[i] = z.re;
        this.gy[i] = z.im;
        this.gfx[i] = lerp(g.fromF[2 * i], this.fx[i], e);
        this.gfy[i] = lerp(g.fromF[2 * i + 1], this.fy[i], e);
      }
      if (g.camera) this.center = fromOrigin(alongGeodesic(toOrigin(g.camera.to, g.camera.from), e), g.camera.from);
      if (t >= 1) this.growth = null;
      active = true;
    }
    if (this.unfolding) {
      const u = this.unfolding;
      if (u.start < 0) u.start = now;
      const t = clamp01((now - u.start) / u.duration);
      this.applyIntro(t);
      if (t >= 1) this.unfolding = null;
      active = true;
    }
    if (this.zoomAnimation) {
      const z = this.zoomAnimation;
      const t = clamp01((now - z.start) / z.duration);
      const e = easeInOut(t);
      this.magnify = lerp(z.fromScale, z.toScale, e);
      this.offset = { x: lerp(z.fromOffset.x, z.toOffset.x, e), y: lerp(z.fromOffset.y, z.toOffset.y, e) };
      this.applyView();
      if (t >= 1) this.zoomAnimation = null;
      active = true;
    }
    // The field lens shows while the mouse rests over the disk, and steps aside for a drag or a pinch.
    const overDisk = this.mouse && Math.hypot(this.mouse.x - this.ox, this.mouse.y - this.oy) < this.radius * 1.02;
    const lensTarget = overDisk && !this.calm && this.intro === null && !this.pointer?.dragging && this.touches.size < 2 ? 1 : 0;
    if (this.lensAmount !== lensTarget) {
      const gap = lensTarget - this.lensAmount;
      this.lensAmount = Math.abs(gap) < 0.01 ? lensTarget : this.lensAmount + gap * 0.14;
    }
    if (this.lensAmount > 0) active = true; // its ring keeps turning

    const dimTarget = this.highlighted.size ? 1 : 0;
    if (this.dim !== dimTarget) {
      const gap = dimTarget - this.dim;
      this.dim = Math.abs(gap) < 0.01 ? dimTarget : this.dim + gap * 0.18;
      active = true;
    }
    let moved = false;
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const gap = this.targetInset[side] - this.inset[side];
      if (!gap) continue;
      this.inset[side] = Math.abs(gap) < 0.5 ? this.targetInset[side] : this.inset[side] + gap * 0.16;
      moved = true;
    }
    if (moved) {
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
    const { top, right, bottom, left } = this.inset;
    const usableWidth = this.width - left - right;
    const usableHeight = this.height - top - bottom;
    this.baseRadius = Math.min(usableWidth, usableHeight) * 0.46;
    this.baseOx = left + usableWidth / 2;
    this.baseOy = top + usableHeight / 2 + Math.min(24, usableHeight * 0.02);
    this.applyView();
  }

  private applyView() {
    // While it unfolds, the disk also grows the last few percent into place.
    const unfold = this.intro === null ? 1 : 0.9 + 0.1 * easeOut(this.intro);
    this.radius = this.baseRadius * this.magnify * unfold;
    this.ox = this.baseOx + this.offset.x;
    this.oy = this.baseOy + this.offset.y;
  }

  // Zoom by `factor` keeping the point (x, y) under the cursor where it is.
  private zoomAt(factor: number, x: number, y: number) {
    const scale = Math.min(MAX_MAGNIFY, Math.max(MIN_MAGNIFY, this.magnify * factor));
    if (scale === this.magnify) return;
    const k = scale / this.magnify;
    this.offset = this.clampOffset({ x: x - this.baseOx - (x - this.ox) * k, y: y - this.baseOy - (y - this.oy) * k }, scale);
    this.magnify = scale;
    this.zoomAnimation = null;
    this.applyView();
    this.invalidate();
  }

  private animateView(toScale: number, toOffset: Pt, duration: number) {
    this.zoomAnimation = {
      start: performance.now(),
      duration,
      fromScale: this.magnify,
      toScale,
      fromOffset: { ...this.offset },
      toOffset: this.clampOffset(toOffset, toScale),
    };
    this.invalidate();
  }

  // A zoomed disk may slide around, but never so far that it leaves the screen.
  private clampOffset(offset: Pt, scale: number): Pt {
    const limit = Math.max(0, this.baseRadius * (scale - 1));
    return { x: Math.max(-limit, Math.min(limit, offset.x)), y: Math.max(-limit, Math.min(limit, offset.y)) };
  }

  private recolor() {
    this.branchRgb = this.branchPosition.map((t) => paletteAt(this.theme.palette, t));
    this.styleCache.clear();
  }

  // Screen positions for every node: hyperbolic view, flat view, or a blend while morphing.
  private project(now: number) {
    const { re: cr, im: ci } = this.center;
    const m = this.blend;
    for (let i = 0; i < this.nodes.length; i++) {
      const zr = this.growth ? this.gx[i] : this.hx[i];
      const zi = this.growth ? this.gy[i] : this.hy[i];
      const nr = zr - cr;
      const ni = zi - ci;
      const dr = 1 - (cr * zr + ci * zi);
      const di = -(cr * zi - ci * zr);
      const d = dr * dr + di * di;
      let x = (nr * dr + ni * di) / d;
      let y = (ni * dr - nr * di) / d;
      let f = Math.max(0, 1 - (x * x + y * y));
      if (this.intro !== null) {
        // Unfolding: each topic sets off a little after the ones nearer the centre, so a wave runs out
        // to the rim, and travels along its geodesic from the centre to where it belongs.
        const r = Math.sqrt(x * x + y * y);
        const s = easeOut(clamp01((this.intro - 0.3 * r) / 0.7));
        this.introAlpha[i] = clamp01(s * 2.5);
        const q = alongGeodesic({ re: x, im: y }, s);
        x = q.re;
        y = q.im;
      }
      if (m > 0) {
        const ex = ((this.growth ? this.gfx[i] : this.fx[i]) - this.flatCenter.x) * this.zoom;
        const ey = ((this.growth ? this.gfy[i] : this.fy[i]) - this.flatCenter.y) * this.zoom;
        x += (ex - x) * m;
        y += (ey - y) * m;
        f += (0.5 - f) * m;
      }
      this.sx[i] = this.ox + x * this.radius;
      this.sy[i] = this.oy + y * this.radius;
      // Zooming in gives every node more room on screen, so more of them earn labels.
      this.sf[i] = Math.min(1, f * this.magnify);
    }
    this.applyFieldLens(now);
  }

  // How far toward the rim the cursor is: 0 at the centre of the disk, 1 at the rim.
  private lensRim() {
    if (!this.mouse) return 0;
    return clamp01(Math.hypot(this.mouse.x - this.ox, this.mouse.y - this.oy) / this.radius);
  }

  private lensRadius() {
    const base = Math.max(80, Math.min(150, Math.min(this.width, this.height) * 0.14));
    return base * (1 + 0.25 * this.lensRim() ** 2); // a little wider out where topics are packed
  }

  // The field lens, applied on screen after projection: a fisheye around the cursor (points spread out
  // most at the centre and not at all at the edge, so there's no seam), with the hovered field's
  // topics given more room so they grow and earn labels around the cursor.
  private applyFieldLens(now: number) {
    this.lensWeight.fill(0);
    const a = this.lensAmount;
    if (a < 0.01 || !this.mouse) return;
    const { x: mx, y: my } = this.mouse;
    const R = this.lensRadius();
    // The field under the cursor is the field of the nearest node.
    let nearest = -1;
    let best = R * R;
    for (let i = 0; i < this.nodes.length; i++) {
      const d2 = (this.sx[i] - mx) ** 2 + (this.sy[i] - my) ** 2;
      if (d2 < best) {
        best = d2;
        nearest = i;
      }
    }
    if (nearest >= 0 && this.branch[nearest] >= 0 && this.branch[nearest] !== this.lensBranch) {
      this.lensBranch = this.branch[nearest];
      this.lensSince = now;
    }
    const pop = clamp01((now - this.lensSince) / 420); // a new field's topics populate over ~0.4 s
    const rim = this.lensRim();
    const strength = LENS_PUSH * (1 + LENS_RIM_BOOST * rim * rim);
    for (let i = 0; i < this.nodes.length; i++) {
      const dx = this.sx[i] - mx;
      const dy = this.sy[i] - my;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      const u = 1 - Math.sqrt(d2) / R; // 1 at the cursor, 0 at the edge
      const push = 1 + strength * a * u * u; // stays monotonic while strength < 3, so nothing crosses over
      this.sx[i] = mx + dx * push;
      this.sy[i] = my + dy * push;
      this.lensWeight[i] = a * u;
      // The field's topics grow most; near the rim everything under the cursor gets room for a name.
      const grow = this.branch[i] === this.lensBranch ? LENS_GROW : LENS_GROW * 0.6 * rim;
      this.sf[i] = Math.min(1, this.sf[i] + grow * a * u * pop);
    }
  }

  private draw(now: number) {
    const { ctx, theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.nodes.length) return;
    this.project(now);
    const hyperbolic = 1 - this.blend;
    // While the universe unfolds, the glow brightens with it and the rim draws itself, clockwise from the top.
    const reveal = this.intro === null ? 1 : easeInOut(clamp01(this.intro / 0.6));
    const rimSweep = this.intro === null ? 1 : easeInOut(clamp01(this.intro / 0.8));

    // The disk itself: a faint glow and a hairline rim, on a soft lit surface in the light theme.
    if (hyperbolic > 0.01) {
      if (theme.disk) {
        ctx.save();
        ctx.globalAlpha = hyperbolic * reveal;
        ctx.shadowColor = theme.disk.shadow;
        ctx.shadowBlur = 70;
        ctx.shadowOffsetY = 18;
        ctx.fillStyle = theme.disk.fill;
        ctx.beginPath();
        ctx.arc(this.ox, this.oy, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      const glow = ctx.createRadialGradient(this.ox, this.oy, 0, this.ox, this.oy, this.radius);
      glow.addColorStop(0, `rgba(${theme.glow}, ${theme.glowAlpha * hyperbolic * reveal})`);
      glow.addColorStop(0.7, `rgba(${theme.glow}, ${theme.glowAlpha * 0.45 * hyperbolic * reveal})`);
      glow.addColorStop(1, `rgba(${theme.glow}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(this.ox, this.oy, this.radius, 0, Math.PI * 2);
      ctx.fill();
      if (rimSweep < 1) {
        // The pen tip leads the rim round, brighter than the line it leaves behind.
        ctx.beginPath();
        ctx.arc(this.ox, this.oy, this.radius, -Math.PI / 2, -Math.PI / 2 + rimSweep * Math.PI * 2);
      }
      ctx.strokeStyle = `rgba(${theme.ink}, ${(this.intro === null ? theme.rimAlpha : theme.rimAlpha * 2.2) * hyperbolic})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const curved = this.blend < 0.5;
    const onScreen = (i: number) => this.sx[i] > -40 && this.sx[i] < this.width + 40 && this.sy[i] > -40 && this.sy[i] < this.height + 40;

    if (this.lens && hyperbolic > 0.01) this.drawDistanceRings(hyperbolic);

    // Edges, batched by colour and opacity so the canvas changes style a few hundred times, not thousands.
    const edgeGroups = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.parent[i];
      if (p < 0) continue;
      const f = this.sf[i];
      if (f < 0.002 || (!onScreen(i) && !onScreen(p))) continue;
      const alpha = Math.min(0.75, (0.08 + 0.6 * Math.pow(f, 0.85)) * theme.inkBoost) * this.fadeFor(i);
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
      ctx.strokeStyle = `rgba(${theme.accent}, 0.75)`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const i of this.highlightPath) if (this.parent[i] >= 0) this.edgePath(i, this.parent[i], curved);
      ctx.stroke();
    }

    // Nodes, batched the same way.
    const nodeGroups = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      if (!onScreen(i)) continue;
      const alpha = Math.min(1, (0.32 + 0.9 * Math.pow(this.sf[i], 0.6)) * theme.inkBoost) * this.fadeFor(i);
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
        ctx.fillStyle = `rgba(${theme.accent}, ${0.18 + 0.12 * pulse})`;
        ctx.beginPath();
        ctx.arc(this.sx[i], this.sy[i], r + 5 + 4 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgb(${theme.accent})`;
        ctx.beginPath();
        ctx.arc(this.sx[i], this.sy[i], Math.max(2, r), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.hover >= 0 && this.hover !== this.focus) {
      ctx.strokeStyle = `rgba(${theme.ink}, 0.85)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this.sx[this.hover], this.sy[this.hover], this.nodeRadius(this.hover) + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.lensAmount > 0.01 && this.mouse) this.drawFieldLens(now);
    if (this.lens && hyperbolic > 0.5 && this.hover >= 0 && this.hover !== this.focus) this.drawHoverRings(this.hover);

    // Names come in once the universe has mostly unfolded.
    ctx.save();
    ctx.globalAlpha = this.intro === null ? 1 : clamp01((this.intro - 0.6) / 0.4);
    this.drawReticle();
    this.drawLabels();
    this.drawFieldLensLabel();
    ctx.restore();
  }

  // Circles of hyperbolic radius 1, 2, 3… around the centre. In the Poincaré disk a circle of hyperbolic
  // radius d around the centre is a Euclidean circle of radius tanh(d / 2), so they crowd toward the
  // rim: there is exponentially more room out there.
  private drawDistanceRings(alpha: number) {
    const { ctx, theme } = this;
    ctx.save();
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.font = `500 10.5px ${this.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 1; d <= 5; d++) {
      const r = Math.tanh(d / 2) * this.radius;
      ctx.strokeStyle = `rgba(${theme.ink}, ${0.3 * alpha})`;
      ctx.beginPath();
      ctx.arc(this.ox, this.oy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (d === 5) continue; // the outer rings bunch up too tightly to label
      // Distance labels along the lower-left diagonal, out of the way of the focus label.
      const x = this.ox - r * Math.SQRT1_2;
      const y = this.oy + r * Math.SQRT1_2;
      ctx.fillStyle = `rgba(${theme.halo}, ${0.9 * alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${theme.ink}, ${0.55 * alpha})`;
      ctx.fillText(String(d), x, y + 0.5);
    }
    ctx.restore();
  }

  // The lens itself: a soft glow and a slowly turning ring in the field's colour, three points orbiting
  // it, and the field's name and size above.
  private drawFieldLens(now: number) {
    const { ctx, theme } = this;
    const a = this.lensAmount;
    const { x, y } = this.mouse!;
    const R = this.lensRadius();
    const k = this.lensBranch;
    const [r, g, b] = k >= 0 ? this.branchRgb[k] : theme.root;
    ctx.save();
    const glow = ctx.createRadialGradient(x, y, 0, x, y, R);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.12 * a})`);
    glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = -now / 45;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.55 * a})`;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([1, 9]);
    ctx.lineDashOffset = now / 60;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.3 * a})`;
    ctx.beginPath();
    ctx.arc(x, y, R * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.85 * a})`;
    for (let j = 0; j < 3; j++) {
      const t = now / 1400 + (j * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(x + Math.cos(t) * R, y + Math.sin(t) * R, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // The field's name and size, above the lens (below it near the top edge), drawn over the topic labels.
  private drawFieldLensLabel() {
    const { ctx, theme } = this;
    const a = this.lensAmount;
    const k = this.lensBranch;
    if (a < 0.01 || !this.mouse || k < 0) return;
    const { x, y } = this.mouse;
    const R = this.lensRadius();
    const [r, g, b] = this.branchRgb[k];
    ctx.save();
    const field = this.nodes[this.branchTop[k]];
    const text = `${field.title.toUpperCase()} · ${this.branchSize[k].toLocaleString()} TOPICS`;
    ctx.font = `600 10.5px ${this.font}`;
    ctx.letterSpacing = '0.8px';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ty = y - R - 12 < 14 ? y + R + 14 : y - R - 12;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${theme.halo}, ${0.85 * a})`;
    ctx.strokeText(text, x, ty);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
    ctx.fillText(text, x, ty);
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'start';
    ctx.restore();
  }

  // Circles of hyperbolic radius ½ and 1 around node i. Off-centre, a hyperbolic circle is still a
  // Euclidean circle, but smaller and shifted toward the centre: the closer to the rim, the more so.
  private drawHoverRings(i: number) {
    const { ctx, theme } = this;
    const cx = (this.sx[i] - this.ox) / this.radius;
    const cy = (this.sy[i] - this.oy) / this.radius;
    const c2 = cx * cx + cy * cy;
    if (c2 >= 1) return;
    ctx.save();
    ctx.lineWidth = 1.2;
    for (const d of [0.5, 1]) {
      const t = Math.tanh(d / 2);
      const k = 1 - t * t * c2;
      const scale = (1 - t * t) / k;
      const r = (t * (1 - c2)) / k;
      ctx.strokeStyle = `rgba(${theme.accent}, ${d === 1 ? 0.45 : 0.7})`;
      ctx.beginPath();
      ctx.arc(this.ox + cx * scale * this.radius, this.oy + cy * scale * this.radius, r * this.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // A focus ring with corner brackets around the node at the centre.
  private drawReticle() {
    const i = this.focus;
    if (i < 0) return;
    const { ctx, theme } = this;
    const x = this.sx[i];
    const y = this.sy[i];
    const r = this.nodeRadius(i) + 6;
    ctx.strokeStyle = `rgba(${theme.ink}, 0.92)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    const s = r + 9;
    const l = 6;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `rgba(${theme.ink}, 0.6)`;
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
    const { ctx, theme } = this;
    const candidates: number[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      if (this.sf[i] > 0.14 || i === this.focus || this.highlighted.has(i) || i === this.hover) candidates.push(i);
    }
    const priority = (i: number) =>
      (i === this.focus ? 100 : 0) +
      (i === this.hover ? 50 : 0) +
      (this.highlighted.has(i) ? 20 : 0) +
      // The hovered field's topics near the cursor win label space, so they populate around it.
      (this.lensWeight[i] > 0 && this.branch[i] === this.lensBranch ? 6 * this.lensWeight[i] : 0) +
      this.sf[i] * (this.isCategory[i] ? 1.6 : 1);
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
      const weight = focused || category ? 600 : 400;
      // Letter spacing in px: canvas resolves `em` spacing inconsistently between sizes, which made
      // measured widths come up short and long labels run off the edge.
      const spacing = category && !focused ? 0.08 * size : 0;
      const width = (this.textWidth(text, weight) * size) / 100 + spacing * text.length;
      ctx.font = `${weight} ${size.toFixed(1)}px ${this.font}`;
      ctx.letterSpacing = `${spacing.toFixed(2)}px`;
      const r = this.nodeRadius(i);
      const h = size + 4;
      // Labels sit to the right of their node, unless that would run them off the right edge or under
      // a panel kept clear there (the card).
      const right = this.sx[i] + r + 6;
      const edge = this.width - this.inset.right - 16;
      const x = focused ? this.sx[i] - width / 2 : right + width > edge ? this.sx[i] - r - 6 - width : right;
      const y = focused ? this.sy[i] + r + 30 : this.sy[i];
      const box = { i, x: x - 3, y: y - h / 2, w: width + 6, h };
      if (box.x + box.w < 0 || box.x > this.width || box.y + box.h < 0 || box.y > this.height) continue;
      if (this.labels.some((other) => overlaps(box, other))) continue;
      this.labels.push(box);

      const fade = (focused || this.highlighted.has(i) || i === this.hover ? 1 : clamp01((f - 0.14) / 0.3)) * this.fadeFor(i);
      ctx.strokeStyle = `rgba(${theme.halo}, ${0.85 * fade})`;
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = this.highlighted.has(i)
        ? `rgba(${theme.accent}, ${fade})`
        : category || focused
          ? `rgba(${theme.label}, ${0.95 * fade})`
          : `rgba(${theme.labelSoft}, ${theme.labelSoftAlpha * fade})`;
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

  // During a search, everything except the matches, the branches leading to them, and the node in
  // focus (or under the pointer) fades back, so the matches stand out. An edge belongs to its child.
  // Also: inside the field lens, other fields' topics fade so the hovered field stands out.
  private fadeFor(i: number) {
    let fade = 1;
    if (this.dim && !this.highlightPath.has(i) && i !== this.focus && i !== this.hover) fade = 1 - SEARCH_FADE * this.dim;
    const w = this.lensWeight[i];
    if (w > 0 && this.branch[i] !== this.lensBranch) fade *= 1 - LENS_DIM * w;
    if (this.intro !== null) fade *= this.introAlpha[i];
    return fade;
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
      const [r, g, b] = branch >= 0 ? this.branchRgb[branch] : this.theme.root;
      style = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
      this.styleCache.set(key, style);
    }
    return style;
  }

  // Text width scales with font size, so each label is measured once at 100px (without letter
  // spacing, which the caller adds) and scaled, keeping the cache to one entry per title and weight.
  private textWidth(text: string, weight: number) {
    const key = `${weight}|${text}`;
    let width = this.textWidths.get(key);
    if (width === undefined) {
      this.ctx.font = `${weight} 100px ${this.font}`;
      this.ctx.letterSpacing = '0px';
      width = this.ctx.measureText(text).width;
      this.textWidths.set(key, width);
    }
    return width;
  }

  // ── Interaction ──────────────────────────────────────────────────────────────────────

  private nodeAt(x: number, y: number): number {
    // While the universe unfolds, only what has already appeared can be hovered or clicked: labels
    // once they're half faded in, topics once they're half visible.
    const unfolding = this.intro !== null;
    if (!unfolding || this.intro! >= 0.8) {
      for (let k = this.labels.length - 1; k >= 0; k--) {
        const label = this.labels[k];
        if (x >= label.x && x <= label.x + label.w && y >= label.y && y <= label.y + label.h) return label.i;
      }
    }
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      if (unfolding && this.introAlpha[i] < 0.5) continue;
      const reach = this.nodeRadius(i) + 7;
      const d = (this.sx[i] - x) ** 2 + (this.sy[i] - y) ** 2;
      if (d < reach * reach && d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
    return best;
  }

  private local(e: { clientX: number; clientY: number }): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Drag the plane: the point under the cursor follows it, by a hyperbolic translation.
  private pan(x0: number, y0: number, x1: number, y1: number) {
    this.flight = null;
    this.route = [];
    this.routeEnd = null;
    if (this.growth) this.growth.camera = null;
    this.settleSoon(450);
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
    const point = this.local(e);
    this.touches.set(e.pointerId, point);
    this.canvas.setPointerCapture(e.pointerId);
    if (this.touches.size === 2) {
      // A second finger turns a drag into a pinch.
      const [a, b] = [...this.touches.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      this.pointer = null;
      return;
    }
    this.pointer = { id: e.pointerId, x: point.x, y: point.y, startX: point.x, startY: point.y, dragging: false };
  };

  private onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    if (e.pointerType !== 'touch') {
      this.mouse = { x, y };
      this.invalidate();
    }
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x, y });
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDistance > 0) this.zoomAt(distance / this.pinchDistance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinchDistance = distance;
      return;
    }
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
      this.hoverHandler?.(hover >= 0 ? this.nodes[hover] : null);
      this.invalidate();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size === 1 && !this.pointer) {
      const [[id, point]] = [...this.touches];
      this.pointer = { id, x: point.x, y: point.y, startX: point.x, startY: point.y, dragging: true };
      return;
    }
    const p = this.pointer;
    this.pointer = null;
    this.canvas.style.cursor = this.hover >= 0 ? 'pointer' : 'grab';
    if (!p || p.dragging || p.id !== e.pointerId) return;
    const i = this.nodeAt(p.startX, p.startY);
    if (i >= 0) this.selectHandler?.(this.nodes[i]);
    // Empty space on the disk: zoom into it.
    else if (Math.hypot(p.startX - this.ox, p.startY - this.oy) < this.radius) this.zoomInto(p.startX, p.startY);
  };

  private onPointerLeave = () => {
    this.mouse = null;
    this.invalidate();
    if (this.hover >= 0) {
      this.hover = -1;
      this.hoverHandler?.(null);
      this.invalidate();
    }
  };

  // Two-finger scrolling glides across the plane. A trackpad pinch is a separate gesture that the
  // browser reports as ctrl+wheel, so it can zoom around the cursor without taking over scrolling.
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : 1; // some mice scroll in lines rather than pixels
    if (e.ctrlKey) {
      if (this.gesturing) return; // Safari is already zooming from the gesture events
      const { x, y } = this.local(e);
      this.zoomAt(Math.exp(-e.deltaY * lines * 0.012), x, y);
      return;
    }
    this.pan(this.ox, this.oy, this.ox - e.deltaX * lines * 0.5, this.oy - e.deltaY * lines * 0.5);
  };

  private onGestureStart = (e: Event) => {
    e.preventDefault();
    this.gestureScale = 1;
    this.gesturing = true;
  };

  private onGestureEnd = () => {
    this.gesturing = false;
  };

  private onGestureChange = (e: Event) => {
    e.preventDefault();
    const gesture = e as Event & { scale: number; clientX: number; clientY: number };
    const { x, y } = this.local(gesture);
    this.zoomAt(gesture.scale / this.gestureScale, x, y);
    this.gestureScale = gesture.scale;
  };
}

function paletteAt(palette: RGB[], t: number): RGB {
  const scaled = t * (palette.length - 1);
  const k = Math.min(palette.length - 2, Math.floor(scaled));
  const u = scaled - k;
  const [a, b] = [palette[k], palette[k + 1]];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * u)) as RGB;
}

function overlaps(a: Omit<Label, 'i'>, b: Omit<Label, 'i'>) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
