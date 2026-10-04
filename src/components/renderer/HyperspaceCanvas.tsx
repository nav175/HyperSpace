"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type {
  HypertreeRendererApi,
  Node,
  RenderMode,
} from "@/types/contracts";
import {
  expandAroundFocus,
  nodesToNested,
  pruneForRender,
} from "@/lib/hypertree/toHierarchy";
import {
  loadHyt,
  type HypertreeInstance,
  type HypertreeNode,
  type HytApi,
} from "@/lib/hypertree/loadHyt";
import { ensurePathLayout, graftNodes } from "@/lib/hypertree/graft";

type SelectCb = ((node: Node) => void) | null;

const MAX_LABELS = 26;
/** Hyperbolic edge scale. Smaller = more context visible around a deep focus. */
const INITIAL_LAMBDA = 0.5;

/** Dev-only timing trail: window.__perf = [[label, ms], …] */
function perfLog(label: string, ms: number) {
  if (process.env.NODE_ENV === "production") return;
  const w = window as unknown as { __perf?: [string, number][] };
  (w.__perf ??= []).push([label, Math.round(ms)]);
}

/**
 * Our own label picker. d3-hypertree's built-in culling uses
 * rootWeight / magic as a threshold; with filter.type "magic" that
 * auto-tunes to ~rootWeight/2, so only the root ever gets a label.
 *
 * Strategy: always label the center node; then categories by subtree weight,
 * then articles close to the center; reject labels that would overlap.
 */
/**
 * Approximate label bounding box in unit-disk coords. d3-hypertree places
 * labels *outward* from the node (bboxOval), so left-side nodes get their
 * text to the left, right-side nodes to the right.
 */
function labelBox(n: HypertreeNode) {
  const { re, im } = n.cache ?? { re: 0, im: 0 };
  const s = n.dampedDistScale ?? 1;
  const len = Math.max(4, n.data?.title?.length ?? 8) * 0.0135 * s;
  const h = 0.046 * s;
  const outwardRight = re >= 0;
  const x0 = outwardRight ? re : re - len;
  const x1 = outwardRight ? re + len : re;
  const y0 = im - h / 2;
  const y1 = im + h / 2;
  return { x0, x1, y0, y1 };
}

function selectLabels(unculled: HypertreeNode[]): HypertreeNode[] {
  type Cand = { n: HypertreeNode; r: number; score: number; cat: boolean };
  const cands: Cand[] = [];
  for (const n of unculled) {
    if (!n.precalc?.label || !n.cachep) continue;
    const r = n.cachep.r;
    if (r > 0.92) continue;
    const cat = Boolean(n.children?.length) || n.data?.type === "category";
    // Articles only get labels when they're near the focus
    if (!cat && r > 0.55) continue;
    const cw = n.precalc.cullingWeight ?? 1;
    const closeness = 1 - r * r;
    const score =
      (!n.parent ? 1e6 : 0) +
      (r < 0.03 ? 1e5 : 0) +
      (cat ? 40 + cw : 8) * closeness;
    cands.push({ n, r, score, cat });
  }
  cands.sort((a, b) => b.score - a.score);

  const kept: Cand[] = [];
  for (const c of cands) {
    if (kept.length >= MAX_LABELS) break;
    const box = labelBox(c.n);
    let collides = false;
    for (const k of kept) {
      const kb = labelBox(k.n);
      if (
        box.x0 < kb.x1 + 0.01 &&
        kb.x0 < box.x1 + 0.01 &&
        box.y0 < kb.y1 &&
        kb.y0 < box.y1
      ) {
        collides = true;
        break;
      }
    }
    if (!collides) kept.push(c);
  }
  return kept.map((k) => k.n);
}

interface Props {
  className?: string;
  onReady?: () => void;
  onError?: (message: string) => void;
}

function clearSelections(ht: HypertreeInstance) {
  const sel = [...(ht.args.objects.selections ?? [])];
  for (const n of sel) ht.api.toggleSelection(n);
  ht.update.pathes();
}

function findById(ht: HypertreeInstance, id: number): HypertreeNode | null {
  if (!ht.data) return null;
  let found: HypertreeNode | null = null;
  ht.data.each((n) => {
    if (n.data?.id === id) found = n;
  });
  return found;
}

export const HyperspaceCanvas = forwardRef<HypertreeRendererApi, Props>(
  function HyperspaceCanvas({ className, onReady, onError }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const euclidRef = useRef<HTMLDivElement>(null);
    const htRef = useRef<HypertreeInstance | null>(null);
    const hytRef = useRef<HytApi | null>(null);
    const fullNodesRef = useRef<Node[]>([]);
    const renderNodesRef = useRef<Node[]>([]);
    const selectCbRef = useRef<SelectCb>(null);
    const modeRef = useRef<RenderMode>("hyperbolic");
    const highlightRef = useRef<number[]>([]);
    const buildingRef = useRef(false);
    const pendingBuildRef = useRef<{
      nodes: Node[];
      focusId?: number;
    } | null>(null);
    const libReadyRef = useRef(false);
    const mountedOnceRef = useRef(false);
    /** Last node we centered on — restored after a mode switch rebuild. */
    const lastFocusRef = useRef<number | null>(null);

    const destroyHt = () => {
      if (hostRef.current) hostRef.current.innerHTML = "";
      htRef.current = null;
    };

    const waitUntilIdle = async () => {
      while (buildingRef.current) {
        await new Promise((r) => setTimeout(r, 40));
      }
    };

    const refreshDetail = (tree: HypertreeInstance) => {
      try {
        tree.drawDetailFrame();
        tree.update.transformation();
        tree.drawDetailFrame();
      } catch {
        /* ignore mid-teardown */
      }
    };

    /** Jump camera instantly — used after rebuild so we never flash the root. */
    const snapToNode = (tree: HypertreeInstance, n: HypertreeNode) => {
      tree.transition = undefined;
      // Layout along the path at the *current* λ (may be stale after init)
      ensurePathLayout(tree, n);
      const z = n.layout?.z;
      const P = tree.args?.geometry?.transformation?.state?.P;
      if (z && P) {
        P.re = -z.re;
        P.im = -z.im;
      }
      refreshDetail(tree);
    };

    /**
     * Graft any nodes in `next` that the live tree doesn't have yet.
     * Cheap (no rebuild) — see lib/hypertree/graft.ts.
     */
    const graftMissing = (tree: HypertreeInstance, next: Node[]): number => {
      const have = new Set(renderNodesRef.current.map((n) => n.id));
      const delta = next.filter((n) => !have.has(n.id));
      if (!delta.length) return 0;
      const t0 = performance.now();
      const added = graftNodes(tree, delta);
      perfLog(`graft(${added})`, performance.now() - t0);
      renderNodesRef.current = next;
      return added;
    };

    /**
     * Focus a node: graft its path + local children into the live tree,
     * then fly there with gotoNode (Möbius animation along the geodesic).
     */
    const focusOnId = async (id: number) => {
      await waitUntilIdle();
      const tree = htRef.current;
      if (!tree?.data) return;

      const next = expandAroundFocus(
        fullNodesRef.current,
        renderNodesRef.current,
        id,
      );
      const added = graftMissing(tree, next);
      // Matches highlighted before they existed in the tree need re-selecting
      if (added && highlightRef.current.length) applyHighlight(highlightRef.current);

      const n = findById(tree, id);
      if (!n) return;
      if (!n.layout?.z) ensurePathLayout(tree, n);
      if (!n.layout?.z) return;
      lastFocusRef.current = id;

      tree.transition = undefined;
      const tFly = performance.now();
      await Promise.race([
        tree.api.gotoNode(n).catch(() => undefined),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
      perfLog("gotoNode", performance.now() - tFly);
      tree.transition = undefined;
      refreshDetail(tree);
      requestAnimationFrame(() => refreshDetail(tree));
      window.setTimeout(() => refreshDetail(tree), 60);
      window.setTimeout(() => refreshDetail(tree), 320);
    };

    const buildHypertree = async (
      renderNodes: Node[],
      opts?: { focusId?: number },
    ) => {
      const parent = hostRef.current;
      if (!parent || !renderNodes.length) return;
      if (buildingRef.current) {
        pendingBuildRef.current = {
          nodes: renderNodes,
          focusId: opts?.focusId,
        };
        return;
      }
      buildingRef.current = true;
      const tBuild = performance.now();

      try {
        const hyt = hytRef.current ?? (await loadHyt());
        hytRef.current = hyt;
        libReadyRef.current = true;

        renderNodesRef.current = renderNodes;
        destroyHt();

        const nested = nodesToNested(renderNodes);

        // Note: the constructor runs layer callbacks synchronously, so they must
        // not close over the instance binding (TDZ) — they read `htRef.current`.
        const instance = new hyt.Hypertree(
          { parent },
          {
            dataloader: (
              ok: (root: unknown) => void,
              err: (e: unknown) => void,
            ) => {
              try {
                ok(nested);
              } catch (e) {
                err(e);
              }
            },
            langInitBFS: (_inst: unknown, n: HypertreeNode) => {
              n.precalc.label = n.data?.title || "·";
              n.precalc.clickable = true;
            },
            filter: {
              type: "magic",
              cullingRadius: 0.97,
              weightFilter: {
                magic: 100,
                alpha: 1.05,
                weight: (n: HypertreeNode) =>
                  n.children?.length ? Math.max(1, n.height) : 1,
                rangeCullingWeight: { min: 2, max: 250 },
                rangeNodes: { min: 120, max: 320 },
              },
              focusExtension: 2.2,
              maxFocusRadius: 0.92,
              wikiRadius: 0.9,
              maxlabels: MAX_LABELS,
            },
            geometry: {
              layerOptions: {
                cells: { invisible: true, hideOnDrag: true },
                images: { invisible: true, hideOnDrag: true },
                emojis: { invisible: true, hideOnDrag: true },
                symbols: { invisible: true, hideOnDrag: true },
                "stem-arc": { invisible: true, hideOnDrag: true },
                "λ": { invisible: true, hideOnDrag: true },
                "labels-force": { invisible: true, hideOnDrag: true },
                labels2: { invisible: true, hideOnDrag: true },
                labels: {
                  hideOnDrag: false,
                  // Replace d3-hypertree's label culling with ours (see selectLabels)
                  data: () => {
                    const unculled =
                      htRef.current?.unitdisk?.cache?.unculledNodes;
                    return unculled ? selectLabels(unculled) : [];
                  },
                  // No box — text halo via CSS (.hyt-host .caption) reads cleaner
                  background: () => "transparent",
                  color: () => "rgba(236, 240, 248, 0.94)",
                },
                nodes: {
                  nodeColor: (n: HypertreeNode) => {
                    const id = n.data?.id;
                    if (id != null && highlightRef.current.includes(id))
                      return "#4ea1ff";
                    if (n.data?.type === "category") return "#8aa4c8";
                    return "#5a6a82";
                  },
                },
                "link-arcs": {
                  linkColor: () => "rgba(170, 186, 212, 0.55)",
                  // Keep geodesic edges visible while flying — the geometry *is* the demo
                  hideOnDrag: false,
                },
              },
              captionFont: '600 7px "IBM Plex Sans", system-ui, sans-serif',
            },
            interaction: {
              mouseRadius: 0.9,
              λbounds: [0.25, 0.75],
              onNodeClick: (n: HypertreeNode) => {
                const id = n.data?.id;
                if (id == null) return;
                const full =
                  fullNodesRef.current.find((x) => x.id === id) ??
                  (n.data as Node | undefined);
                if (full) selectCbRef.current?.(full);
                void focusOnId(id);
              },
              onCenterNodeChange: () => {
                const tree = htRef.current;
                if (tree && !tree.isAnimationRunning?.()) {
                  refreshDetail(tree);
                }
              },
            },
          },
        ) as unknown as HypertreeInstance;

        htRef.current = instance;
        if (process.env.NODE_ENV !== "production") {
          (window as unknown as { __ht?: HypertreeInstance }).__ht = instance;
        }
        await instance.initPromise;
        perfLog(`build(${renderNodes.length})`, performance.now() - tBuild);

        // findInitλ picks ~0.65 for our pruned set, which pushes all context past
        // the culling radius once you focus a deep node. A tighter λ keeps the
        // surrounding structure visible (layout is recomputed on the next pass).
        const state = instance.args.geometry?.transformation?.state;
        if (state) state.λ = INITIAL_LAMBDA;

        // Snap before first visible paint when focusing a specific node
        if (opts?.focusId != null) {
          const n = findById(instance, opts.focusId);
          if (n) snapToNode(instance, n);
          else refreshDetail(instance);
        } else {
          refreshDetail(instance);
        }

        mountedOnceRef.current = true;
        onReady?.();

        if (highlightRef.current.length) {
          applyHighlight(highlightRef.current);
          if (opts?.focusId != null) {
            const n = findById(instance, opts.focusId);
            if (n) snapToNode(instance, n);
          }
        }
      } finally {
        buildingRef.current = false;
        const pending = pendingBuildRef.current;
        pendingBuildRef.current = null;
        if (pending) {
          void buildHypertree(pending.nodes, { focusId: pending.focusId });
        }
      }
    };

    const applyHighlight = (ids: number[]) => {
      const ht = htRef.current;
      if (!ht?.data) return;
      clearSelections(ht);
      // Cap selection paths — each path is expensive
      for (const id of ids.slice(0, 8)) {
        const n = findById(ht, id);
        if (n) ht.api.toggleSelection(n);
      }
      ht.update.pathes();
    };

    /**
     * Flat radial tree — the "Euclid" foil. Same data, no hyperbolic
     * compression, so depth 3 piles onto the rim. That's the point.
     */
    const drawEuclid = () => {
      const el = euclidRef.current;
      if (!el) return;
      el.innerHTML = "";
      const MAX_DEPTH = 3;
      const subset = fullNodesRef.current.filter((n) => n.depth <= MAX_DEPTH);
      const w = el.clientWidth || 800;
      const h = el.clientHeight || 600;
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

      type P = {
        id: number;
        x: number;
        y: number;
        a: number;
        span: number;
        node: Node;
      };
      const placed: P[] = [];
      const byParent = new Map<number | null, Node[]>();
      for (const n of subset) {
        const list = byParent.get(n.parentId) ?? [];
        list.push(n);
        byParent.set(n.parentId, list);
      }
      // Leaf-count weighting so big branches get proportionate arc
      const leafCount = new Map<number, number>();
      const countLeaves = (n: Node): number => {
        const kids = byParent.get(n.id) ?? [];
        const c = kids.length
          ? kids.reduce((s, k) => s + countLeaves(k), 0)
          : 1;
        leafCount.set(n.id, c);
        return c;
      };
      const root = subset.find((n) => n.parentId === null) ?? subset[0];
      if (!root) return;
      countLeaves(root);

      const cx = w / 2;
      const cy = h / 2 + 24; // clear the search bar
      const R = Math.min(w, h) * 0.4;
      const ring = [0, 0.36, 0.7, 1];
      const place = (n: Node, depth: number, a0: number, a1: number) => {
        const a = (a0 + a1) / 2;
        const r = R * (ring[depth] ?? 1);
        placed.push({
          id: n.id,
          x: cx + Math.cos(a) * r,
          y: cy + Math.sin(a) * r,
          a,
          span: a1 - a0,
          node: n,
        });
        const kids = byParent.get(n.id) ?? [];
        const total = kids.reduce((s, k) => s + (leafCount.get(k.id) ?? 1), 0);
        let cursor = a0;
        for (const k of kids) {
          const span = ((a1 - a0) * (leafCount.get(k.id) ?? 1)) / total;
          place(k, depth + 1, cursor, cursor + span);
          cursor += span;
        }
      };
      place(root, 0, -Math.PI / 2, Math.PI * 1.5);

      const pos = new Map(placed.map((p) => [p.id, p]));
      const focusId = lastFocusRef.current;

      const edges = document.createElementNS(svgNS, "g");
      for (const p of placed) {
        if (p.node.parentId == null) continue;
        const parent = pos.get(p.node.parentId);
        if (!parent) continue;
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(parent.x));
        line.setAttribute("y1", String(parent.y));
        line.setAttribute("x2", String(p.x));
        line.setAttribute("y2", String(p.y));
        line.setAttribute(
          "stroke",
          p.node.depth >= 3
            ? "rgba(140,160,190,0.14)"
            : "rgba(170,186,212,0.45)",
        );
        edges.appendChild(line);
      }
      svg.appendChild(edges);

      const dots = document.createElementNS(svgNS, "g");
      const radii = [6, 4.5, 3, 1.6];
      for (const p of placed) {
        const c = document.createElementNS(svgNS, "circle");
        c.setAttribute("cx", String(p.x));
        c.setAttribute("cy", String(p.y));
        c.setAttribute("r", String(radii[p.node.depth] ?? 1.5));
        const isFocus = p.id === focusId;
        c.setAttribute(
          "fill",
          isFocus
            ? "#4ea1ff"
            : p.node.type === "category"
              ? "#8aa4c8"
              : "#5a6a82",
        );
        if (isFocus) {
          c.setAttribute("stroke", "rgba(158,197,255,0.9)");
          c.setAttribute("stroke-width", "2");
          c.setAttribute("r", String((radii[p.node.depth] ?? 1.5) + 2));
        }
        c.style.cursor = "pointer";
        c.addEventListener("click", () => {
          lastFocusRef.current = p.id;
          selectCbRef.current?.(
            fullNodesRef.current.find((x) => x.id === p.id) ?? p.node,
          );
          drawEuclid();
        });
        dots.appendChild(c);
      }
      svg.appendChild(dots);

      // Labels: root, depth-1 categories with room to breathe, and the focus
      const labels = document.createElementNS(svgNS, "g");
      const minArcPx = 18;
      for (const p of placed) {
        const isFocus = p.id === focusId;
        const roomy = p.span * R * ring[1] >= minArcPx;
        if (!(p.node.depth === 0 || isFocus || (p.node.depth === 1 && roomy)))
          continue;
        const t = document.createElementNS(svgNS, "text");
        const right = Math.cos(p.a) >= 0 || p.node.depth === 0;
        const dx = p.node.depth === 0 ? 0 : right ? 9 : -9;
        t.setAttribute("x", String(p.x + dx));
        t.setAttribute("y", String(p.y + (p.node.depth === 0 ? -12 : 4)));
        t.setAttribute(
          "text-anchor",
          p.node.depth === 0 ? "middle" : right ? "start" : "end",
        );
        t.setAttribute("fill", "rgba(236,240,248,0.9)");
        t.setAttribute("font-size", p.node.depth === 0 ? "13" : "11.5");
        t.setAttribute("font-weight", "500");
        t.setAttribute("paint-order", "stroke fill");
        t.setAttribute("stroke", "rgba(11,13,18,0.95)");
        t.setAttribute("stroke-width", "3");
        t.setAttribute("stroke-linejoin", "round");
        t.style.fontFamily =
          'var(--font-sans), "IBM Plex Sans", system-ui, sans-serif';
        t.style.pointerEvents = "none";
        t.textContent = p.node.title;
        labels.appendChild(t);
      }
      svg.appendChild(labels);

      // Caption so the comparison reads without narration
      const cap = document.createElementNS(svgNS, "text");
      cap.setAttribute("x", String(cx));
      cap.setAttribute("y", String(Math.min(h - 14, cy + R + 28)));
      cap.setAttribute("text-anchor", "middle");
      cap.setAttribute("fill", "rgba(236,240,248,0.45)");
      cap.setAttribute("font-size", "12");
      cap.textContent = `Flat space: ${subset.length.toLocaleString()} concepts to depth ${MAX_DEPTH} — the rim runs out of room`;
      svg.appendChild(cap);

      el.appendChild(svg);
    };

    useImperativeHandle(
      ref,
      (): HypertreeRendererApi => ({
        loadTree(nodes) {
          fullNodesRef.current = nodes;
          const pruned = pruneForRender(nodes);
          if (modeRef.current === "euclid") {
            renderNodesRef.current = pruned;
            drawEuclid();
            return;
          }
          void buildHypertree(pruned).catch((e) =>
            onError?.(e instanceof Error ? e.message : String(e)),
          );
        },
        flyTo(id) {
          if (modeRef.current === "euclid") {
            lastFocusRef.current = id;
            drawEuclid();
            return;
          }
          void focusOnId(id);
        },
        highlight(ids) {
          highlightRef.current = ids;
          // Don't rebuild here — flyTo/focusOnId owns expand+rebuild (avoids race)
          if (htRef.current && modeRef.current === "hyperbolic") {
            applyHighlight(ids);
            refreshDetail(htRef.current);
          }
        },
        addChildren(parentId, children) {
          const existing = new Set(fullNodesRef.current.map((n) => n.id));
          const parent = fullNodesRef.current.find((n) => n.id === parentId);
          const depth = (parent?.depth ?? 0) + 1;
          const grafted = children.map((c) => ({
            ...c,
            parentId,
            depth: c.depth || depth,
          }));
          const nextFull = [...fullNodesRef.current];
          for (const c of grafted) {
            if (existing.has(c.id)) continue;
            nextFull.push(c);
            existing.add(c.id);
          }
          fullNodesRef.current = nextFull;
          const render = expandAroundFocus(
            nextFull,
            [...renderNodesRef.current, ...grafted],
            parentId,
            36,
          );
          const tree = htRef.current;
          if (modeRef.current === "euclid" || !tree?.data) {
            renderNodesRef.current = render;
            if (modeRef.current === "euclid") drawEuclid();
            return;
          }
          // In-place graft — new branches grow around the (already centered) parent
          graftMissing(tree, render);
          const p = findById(tree, parentId);
          if (p?.layout?.z) {
            tree.transition = undefined;
            void tree.api.gotoNode(p).catch(() => undefined);
            window.setTimeout(() => refreshDetail(tree), 350);
          } else {
            refreshDetail(tree);
          }
        },
        setMode(mode) {
          modeRef.current = mode;
          if (mode === "euclid") {
            destroyHt();
            if (hostRef.current) hostRef.current.style.display = "none";
            if (euclidRef.current) {
              euclidRef.current.style.display = "block";
              drawEuclid();
            }
          } else {
            if (euclidRef.current) {
              euclidRef.current.innerHTML = "";
              euclidRef.current.style.display = "none";
            }
            if (hostRef.current) hostRef.current.style.display = "block";
            void buildHypertree(
              renderNodesRef.current.length
                ? renderNodesRef.current
                : pruneForRender(fullNodesRef.current),
              { focusId: lastFocusRef.current ?? undefined },
            );
          }
        },
        onSelect(cb) {
          selectCbRef.current = cb;
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    useEffect(() => {
      let cancelled = false;
      loadHyt()
        .then((hyt) => {
          if (cancelled) return;
          hytRef.current = hyt;
          libReadyRef.current = true;
          onReady?.();
        })
        .catch((e) => {
          if (!cancelled)
            onError?.(e instanceof Error ? e.message : String(e));
        });
      // Euclid view is a static SVG sized to the host — redraw on resize
      let raf = 0;
      const onResize = () => {
        if (modeRef.current !== "euclid") return;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => drawEuclid());
      };
      window.addEventListener("resize", onResize);
      return () => {
        cancelled = true;
        window.removeEventListener("resize", onResize);
        cancelAnimationFrame(raf);
        destroyHt();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div
        className={className}
        style={{ position: "relative", width: "100%", height: "100%" }}
      >
        <div
          ref={hostRef}
          className="hyt-host"
          style={{
            width: "100%",
            height: "100%",
            opacity: 1,
            transition: "opacity 120ms ease",
          }}
        />
        <div
          ref={euclidRef}
          style={{
            display: "none",
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        />
      </div>
    );
  },
);
