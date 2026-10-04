"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type {
  HypertreeRendererApi,
  Node,
  RenderMode,
} from "@/types/contracts";
import { type C, abs, c, scale, sub } from "@/lib/geometry/complex";
import {
  applyView,
  geodesicLerp,
  panByDrag,
  ZERO,
} from "@/lib/geometry/mobius";
import {
  edgeList,
  layoutEuclid,
  layoutHyperbolic,
} from "@/lib/geometry/layout";
import {
  ancestorsOf,
  pathHighlight,
  treePath,
} from "@/lib/geometry/path";

const HOP_MS = 320;
const ANIM_MIN_MS = 560;
const ANIM_MAX_MS = 2200;
const GROW_MS = 650;
const GEODESIC_SAMPLES = 16;
const BOUNDARY_CULL = 0.94;
const LABEL_CULL = 0.55;
const EDGE_CULL = 0.91;
const MAX_LABELS = 18;

/** Soft land — Apple-like, no bounce (inspired by hypertree “swell”). */
function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

function easeOutBackSoft(t: number): number {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: LabelBox, b: LabelBox, pad = 5): boolean {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

function diskToScreen(z: C, cx: number, cy: number, R: number) {
  return { x: cx + z.re * R, y: cy + z.im * R };
}

function screenToDisk(
  x: number,
  y: number,
  cx: number,
  cy: number,
  R: number,
): C {
  return c((x - cx) / R, (y - cy) / R);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Sample focus along geodesic polyline of layout waypoints (Gate C). */
function sampleWaypoints(points: C[], t: number): C {
  if (points.length === 0) return ZERO;
  if (points.length === 1 || t <= 0) return points[0]!;
  if (t >= 1) return points[points.length - 1]!;
  const segs = points.length - 1;
  const x = t * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  return geodesicLerp(points[i]!, points[i + 1]!, x - i);
}

function flightDurationMs(hops: number): number {
  return Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, hops * HOP_MS));
}

interface Props {
  className?: string;
  initialNodes?: Node[];
}

export const HypertreeCanvas = forwardRef<HypertreeRendererApi, Props>(
  function HypertreeCanvas({ className, initialNodes = [] }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const nodesRef = useRef<Node[]>(initialNodes);
    const nodeByIdRef = useRef<Map<number, Node>>(new Map());
    const parentOfRef = useRef<Map<number, number | null>>(new Map());
    const edgesRef = useRef<[number, number][]>([]);
    const layoutRef = useRef<Map<number, C>>(new Map());
    const modeRef = useRef<RenderMode>("hyperbolic");
    const focusRef = useRef<C>(ZERO);
    const panRef = useRef<C>(ZERO);
    const highlightRef = useRef<Set<number>>(new Set());
    const focusedIdRef = useRef<number | null>(null);
    const selectCbRef = useRef<((node: Node) => void) | null>(null);
    const animRef = useRef<number | null>(null);
    const loopRef = useRef<number | null>(null);
    const dragRef = useRef<{
      active: boolean;
      moved: boolean;
      origin: C;
      startPan: C;
    } | null>(null);
    const euclidOffsetRef = useRef({ x: 0, y: 0, scale: 1 });
    const sizeRef = useRef({ w: 1, h: 1, dpr: 1 });
    const growRef = useRef<Map<number, number>>(new Map());
    const animProgressRef = useRef(1);
    const cursorRef = useRef<"grab" | "grabbing" | "pointer">("grab");

    const rebuild = useCallback((nodes: Node[]) => {
      nodesRef.current = nodes;
      const map = new Map<number, Node>();
      const parents = new Map<number, number | null>();
      for (const n of nodes) {
        map.set(n.id, n);
        parents.set(n.id, n.parentId);
      }
      nodeByIdRef.current = map;
      parentOfRef.current = parents;
      edgesRef.current = edgeList(nodes);
      layoutRef.current =
        modeRef.current === "hyperbolic"
          ? layoutHyperbolic(nodes)
          : layoutEuclid(nodes);
    }, []);

    const pathToRoot = useCallback((id: number): number[] => {
      return ancestorsOf(id, parentOfRef.current);
    }, []);

    const cancelAnim = useCallback(() => {
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      animProgressRef.current = 1;
    }, []);

    const draw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { w, h, dpr } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.fillStyle = "#f5f5f7";
      ctx.fillRect(0, 0, w, h);

      const nodes = nodesRef.current;
      const layout = layoutRef.current;
      const highlights = highlightRef.current;
      const mode = modeRef.current;
      const focusedId = focusedIdRef.current;
      const now = performance.now();
      const animP = animProgressRef.current;
      // During fly: slight “breath” bloom at center (video swell cue)
      const swell = 1 + (1 - animP) * 0.035;

      if (mode === "hyperbolic") {
        const cx = w / 2;
        const cy = h / 2 + 4;
        const R = Math.min(w, h) * 0.42 * swell;

        const aura = ctx.createRadialGradient(cx, cy, R * 0.12, cx, cy, R * 1.25);
        aura.addColorStop(0, "rgba(0, 102, 204, 0.06)");
        aura.addColorStop(0.55, "rgba(0, 102, 204, 0.02)");
        aura.addColorStop(1, "rgba(0, 102, 204, 0)");
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        const disk = ctx.createRadialGradient(
          cx,
          cy - R * 0.14,
          R * 0.04,
          cx,
          cy,
          R,
        );
        disk.addColorStop(0, "#ffffff");
        disk.addColorStop(0.7, "#f7f8fa");
        disk.addColorStop(1, "#eef0f3");
        ctx.fillStyle = disk;
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Soft rim fringe — density cue without neon
        ctx.beginPath();
        ctx.arc(cx, cy, R - 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 102, 204, 0.06)";
        ctx.lineWidth = 6;
        ctx.stroke();

        const focus = focusRef.current;
        const pan = panRef.current;
        const projected = new Map<number, C>();
        for (const node of nodes) {
          const lz = layout.get(node.id);
          if (!lz) continue;
          projected.set(node.id, applyView(lz, focus, pan));
        }

        for (const [pid, cid] of edgesRef.current) {
          const a = projected.get(pid);
          const b = projected.get(cid);
          if (!a || !b) continue;
          if (abs(a) > EDGE_CULL && abs(b) > EDGE_CULL) continue;

          const onPath = highlights.has(pid) && highlights.has(cid);
          const mid = (abs(a) + abs(b)) / 2;
          const alpha = onPath
            ? 0.5
            : Math.max(0.025, 0.26 * (1 - mid));

          ctx.beginPath();
          for (let i = 0; i <= GEODESIC_SAMPLES; i++) {
            const p = geodesicLerp(a, b, i / GEODESIC_SAMPLES);
            const s = diskToScreen(p, cx, cy, R);
            if (i === 0) ctx.moveTo(s.x, s.y);
            else ctx.lineTo(s.x, s.y);
          }
          ctx.strokeStyle = onPath
            ? `rgba(0, 102, 204, ${alpha})`
            : `rgba(55, 65, 85, ${alpha})`;
          ctx.lineWidth = onPath ? 1.75 : Math.max(0.3, 1.15 * (1 - mid));
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        type Cand = {
          node: Node;
          s: { x: number; y: number };
          proximity: number;
          isHi: boolean;
          isFocus: boolean;
          radius: number;
          priority: number;
          grow: number;
        };
        const labelCands: Cand[] = [];

        const sorted = [...nodes].sort((n1, n2) => {
          return (
            abs(projected.get(n2.id) ?? ZERO) -
            abs(projected.get(n1.id) ?? ZERO)
          );
        });

        for (const node of sorted) {
          const z = projected.get(node.id);
          if (!z) continue;
          const r = abs(z);
          if (r > BOUNDARY_CULL) continue;

          const s = diskToScreen(z, cx, cy, R);
          const proximity = 1 - r;
          const isFocus = node.id === focusedId;
          const isHi = highlights.has(node.id);

          let grow = 1;
          const born = growRef.current.get(node.id);
          if (born != null) {
            const gt = Math.min(1, (now - born) / GROW_MS);
            grow = easeOutBackSoft(gt);
            if (gt >= 1) growRef.current.delete(node.id);
          }

          // Video: clear & loose at center, compressed at rim
          const radius =
            (1.5 + proximity * 5.4 + (isFocus ? 2.4 : isHi ? 1.3 : 0)) * grow;

          if (isFocus || isHi) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, radius + 8 + (1 - animP) * 4, 0, Math.PI * 2);
            ctx.fillStyle = isFocus
              ? `rgba(0, 102, 204, ${0.1 + (1 - animP) * 0.08})`
              : "rgba(0, 102, 204, 0.07)";
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
          if (isFocus) {
            ctx.fillStyle = "#0066cc";
          } else if (isHi) {
            ctx.fillStyle = `rgba(0, 102, 204, ${0.5 + proximity * 0.4})`;
          } else {
            ctx.fillStyle = `rgba(45, 55, 72, ${0.18 + proximity * 0.58})`;
          }
          ctx.fill();

          const allow =
            isFocus ||
            (isHi && r < 0.62) ||
            (r < LABEL_CULL && proximity > 0.38 && node.depth <= 2) ||
            (r < 0.28 && node.depth <= 3);
          if (!allow) continue;

          labelCands.push({
            node,
            s,
            proximity,
            isHi,
            isFocus,
            radius,
            grow,
            priority:
              (isFocus ? 1000 : 0) +
              (isHi ? 240 : 0) +
              proximity * 100 -
              node.depth * 10,
          });
        }

        // Subtle focus crosshair (light, not sci-fi neon)
        ctx.save();
        ctx.strokeStyle = `rgba(0, 102, 204, ${0.18 + (1 - animP) * 0.12})`;
        ctx.lineWidth = 1;
        const tick = 7;
        ctx.beginPath();
        ctx.moveTo(cx - tick, cy);
        ctx.lineTo(cx + tick, cy);
        ctx.moveTo(cx, cy - tick);
        ctx.lineTo(cx, cy + tick);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        labelCands.sort((a, b) => b.priority - a.priority);
        const placed: LabelBox[] = [];
        let nLabels = 0;

        for (const cand of labelCands) {
          if (nLabels >= MAX_LABELS) break;
          const fontSize =
            (cand.isFocus
              ? 14 + cand.proximity * 5
              : 10 + cand.proximity * 4) * Math.min(1, 0.55 + cand.grow * 0.45);
          const maxLen = cand.isFocus ? 36 : 22;
          const title =
            cand.node.title.length > maxLen
              ? `${cand.node.title.slice(0, maxLen - 2)}…`
              : cand.node.title;

          ctx.font = `${cand.isFocus ? 600 : 500} ${fontSize}px "IBM Plex Sans", var(--font-sans), -apple-system, sans-serif`;
          const tw = ctx.measureText(title).width;
          const th = fontSize * 1.15;
          const lx = cand.s.x;
          const ly = cand.s.y - cand.radius - 5;
          const box: LabelBox = {
            x: lx - tw / 2,
            y: ly - th,
            w: tw,
            h: th,
          };
          if (placed.some((p) => overlaps(box, p)) && !cand.isFocus) continue;

          if (cand.isFocus || cand.isHi) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
            const px = 6;
            const py = 2.5;
            ctx.beginPath();
            if (typeof ctx.roundRect === "function") {
              ctx.roundRect(
                box.x - px,
                box.y - py,
                box.w + px * 2,
                box.h + py * 2,
                7,
              );
              ctx.fill();
            } else {
              ctx.fillRect(
                box.x - px,
                box.y - py,
                box.w + px * 2,
                box.h + py * 2,
              );
            }
          }

          ctx.globalAlpha = Math.min(1, 0.4 + cand.proximity * 0.6) * cand.grow;
          ctx.fillStyle = cand.isFocus
            ? "#1d1d1f"
            : cand.isHi
              ? "rgba(0, 70, 160, 0.92)"
              : `rgba(29, 29, 31, ${0.32 + cand.proximity * 0.58})`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(title, lx, ly);
          ctx.globalAlpha = 1;
          placed.push(box);
          nLabels += 1;
        }
      } else {
        const { x: ox, y: oy, scale: sc } = euclidOffsetRef.current;
        const cx = w / 2 + ox;
        const cy = h / 2 + oy;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(sc, sc);

        for (const [pid, cid] of edgesRef.current) {
          const a = layout.get(pid);
          const b = layout.get(cid);
          if (!a || !b) continue;
          const onPath = highlights.has(pid) && highlights.has(cid);
          ctx.beginPath();
          ctx.moveTo(a.re, a.im);
          ctx.lineTo(b.re, b.im);
          ctx.strokeStyle = onPath
            ? "rgba(0, 102, 204, 0.45)"
            : "rgba(60, 70, 90, 0.22)";
          ctx.lineWidth = (onPath ? 1.6 : 1) / sc;
          ctx.stroke();
        }

        for (const node of nodes) {
          const p = layout.get(node.id);
          if (!p) continue;
          const isFocus = node.id === focusedId;
          const isHi = highlights.has(node.id);
          ctx.beginPath();
          ctx.arc(p.re, p.im, isFocus ? 5.5 : isHi ? 3.6 : 2.6, 0, Math.PI * 2);
          ctx.fillStyle =
            isFocus || isHi ? "#0066cc" : "rgba(45, 55, 72, 0.5)";
          ctx.fill();
          if (isFocus || (isHi && sc > 0.7) || (sc > 1 && node.depth <= 1)) {
            ctx.font = `${600} ${12 / sc}px "IBM Plex Sans", sans-serif`;
            ctx.fillStyle = "#1d1d1f";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(node.title, p.re, p.im - 9 / sc);
          }
        }
        ctx.restore();
      }
    }, []);

    useEffect(() => {
      const tick = () => {
        draw();
        loopRef.current = requestAnimationFrame(tick);
      };
      loopRef.current = requestAnimationFrame(tick);
      return () => {
        if (loopRef.current != null) cancelAnimationFrame(loopRef.current);
      };
    }, [draw]);

    const animateAlongPath = useCallback(
      (waypointIds: number[], settleId: number, onDone?: () => void) => {
        cancelAnim();
        const layout = layoutRef.current;
        const points = waypointIds
          .map((id) => layout.get(id))
          .filter((z): z is C => Boolean(z));
        const target = layout.get(settleId) ?? points[points.length - 1];
        if (!target) {
          onDone?.();
          return;
        }
        if (points.length === 0) points.push(target);

        // Always start from current focus so pan/mid-flight feels continuous
        const startFocus = focusRef.current;
        if (
          points.length === 0 ||
          abs(sub(points[0]!, startFocus)) > 1e-4
        ) {
          points.unshift(startFocus);
        }

        highlightRef.current = new Set(pathHighlight(waypointIds));

        if (prefersReducedMotion() || modeRef.current !== "hyperbolic") {
          focusRef.current = target;
          panRef.current = ZERO;
          animProgressRef.current = 1;
          if (modeRef.current === "euclid") {
            const { scale: sc } = euclidOffsetRef.current;
            euclidOffsetRef.current = {
              x: -target.re * sc,
              y: -target.im * sc,
              scale: Math.max(sc, 1.12),
            };
          }
          highlightRef.current = new Set(pathToRoot(settleId));
          onDone?.();
          return;
        }

        const hops = Math.max(1, points.length - 1);
        const duration = flightDurationMs(hops);
        const panFrom = panRef.current;
        const start = performance.now();
        animProgressRef.current = 0;

        const step = (now: number) => {
          const t = Math.min(1, (now - start) / duration);
          const e = easeOutQuint(t);
          focusRef.current = sampleWaypoints(points, e);
          panRef.current = scale(panFrom, 1 - e);
          animProgressRef.current = e;
          if (t < 1) animRef.current = requestAnimationFrame(step);
          else {
            animRef.current = null;
            focusRef.current = target;
            panRef.current = ZERO;
            animProgressRef.current = 1;
            highlightRef.current = new Set(pathToRoot(settleId));
            onDone?.();
          }
        };
        animRef.current = requestAnimationFrame(step);
      },
      [cancelAnim, pathToRoot],
    );

    const flyToId = useCallback(
      (id: number, notify: boolean) => {
        const node = nodeByIdRef.current.get(id);
        if (!layoutRef.current.has(id)) return;

        const fromId = focusedIdRef.current;
        const waypoints = treePath(fromId, id, parentOfRef.current);
        focusedIdRef.current = id;
        if (notify && node) selectCbRef.current?.(node);

        animateAlongPath(waypoints, id, () => {
          // ensure final highlight is ancestry of destination
          highlightRef.current = new Set(pathToRoot(id));
        });
      },
      [animateAlongPath, pathToRoot],
    );

    const selectNode = useCallback(
      (hit: Node) => {
        flyToId(hit.id, true);
      },
      [flyToId],
    );

    const hitTest = useCallback(
      (clientX: number, clientY: number): Node | null => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const { w, h } = sizeRef.current;
        const layout = layoutRef.current;
        const nodes = nodesRef.current;

        if (modeRef.current === "hyperbolic") {
          const cx = w / 2;
          const cy = h / 2 + 4;
          const R = Math.min(w, h) * 0.42;
          let best: Node | null = null;
          let bestD = 20;
          for (const node of nodes) {
            const lz = layout.get(node.id);
            if (!lz) continue;
            const z = applyView(lz, focusRef.current, panRef.current);
            if (abs(z) > BOUNDARY_CULL) continue;
            const s = diskToScreen(z, cx, cy, R);
            const d = Math.hypot(s.x - x, s.y - y);
            const hitR = 8 + (1 - abs(z)) * 14;
            if (d < hitR && d < bestD) {
              bestD = d;
              best = node;
            }
          }
          return best;
        }

        const { x: ox, y: oy, scale: sc } = euclidOffsetRef.current;
        const cx = w / 2 + ox;
        const cy = h / 2 + oy;
        const lx = (x - cx) / sc;
        const ly = (y - cy) / sc;
        let best: Node | null = null;
        let bestD = 12 / sc;
        for (const node of nodes) {
          const p = layout.get(node.id);
          if (!p) continue;
          const d = Math.hypot(p.re - lx, p.im - ly);
          if (d < bestD) {
            bestD = d;
            best = node;
          }
        }
        return best;
      },
      [],
    );

    useImperativeHandle(
      ref,
      (): HypertreeRendererApi => ({
        loadTree(nodes) {
          cancelAnim();
          focusRef.current = ZERO;
          panRef.current = ZERO;
          highlightRef.current = new Set();
          growRef.current = new Map();
          focusedIdRef.current =
            nodes.find((n) => n.parentId === null)?.id ?? null;
          if (focusedIdRef.current != null) {
            highlightRef.current = new Set([focusedIdRef.current]);
          }
          rebuild(nodes);
        },
        flyTo(id) {
          flyToId(id, true);
        },
        highlight(ids) {
          highlightRef.current = new Set(ids);
        },
        addChildren(parentId, children) {
          const existing = new Set(nodesRef.current.map((n) => n.id));
          const parent = nodeByIdRef.current.get(parentId);
          const depth = (parent?.depth ?? 0) + 1;
          const next = [...nodesRef.current];
          const born = performance.now();
          for (const child of children) {
            if (existing.has(child.id)) continue;
            next.push({ ...child, parentId, depth: child.depth || depth });
            growRef.current.set(child.id, born);
          }
          rebuild(next);
          highlightRef.current = new Set([
            ...pathToRoot(parentId),
            ...children.map((c) => c.id),
          ]);
        },
        setMode(mode) {
          modeRef.current = mode;
          focusRef.current = ZERO;
          panRef.current = ZERO;
          euclidOffsetRef.current = { x: 0, y: 0, scale: 1 };
          rebuild(nodesRef.current);
        },
        onSelect(cb) {
          selectCbRef.current = cb;
        },
      }),
      [cancelAnim, flyToId, pathToRoot, rebuild],
    );

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement ?? canvas;
      const resize = () => {
        const rect = parent.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        sizeRef.current = { w: rect.width, h: rect.height, dpr };
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      };
      const ro = new ResizeObserver(resize);
      ro.observe(parent);
      resize();
      return () => ro.disconnect();
    }, []);

    useEffect(() => {
      if (initialNodes.length) {
        rebuild(initialNodes);
        const root =
          initialNodes.find((n) => n.parentId === null)?.id ?? null;
        focusedIdRef.current = root;
        if (root != null) highlightRef.current = new Set([root]);
      }
    }, [initialNodes, rebuild]);

    useEffect(() => () => cancelAnim(), [cancelAnim]);

    const setCursor = (next: "grab" | "grabbing" | "pointer") => {
      cursorRef.current = next;
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = next;
    };

    const onPointerDown = (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      setCursor("grabbing");
      if (modeRef.current === "hyperbolic") {
        const R = Math.min(w, h) * 0.42;
        dragRef.current = {
          active: true,
          moved: false,
          origin: screenToDisk(
            e.clientX - rect.left,
            e.clientY - rect.top,
            w / 2,
            h / 2 + 4,
            R,
          ),
          startPan: panRef.current,
        };
      } else {
        dragRef.current = {
          active: true,
          moved: false,
          origin: c(e.clientX, e.clientY),
          startPan: c(euclidOffsetRef.current.x, euclidOffsetRef.current.y),
        };
      }
    };

    const onPointerMove = (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag?.active) {
        const hover = hitTest(e.clientX, e.clientY);
        setCursor(hover ? "pointer" : "grab");
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      if (modeRef.current === "hyperbolic") {
        const R = Math.min(w, h) * 0.42;
        const disk = screenToDisk(
          e.clientX - rect.left,
          e.clientY - rect.top,
          w / 2,
          h / 2 + 4,
          R,
        );
        if (abs(sub(disk, drag.origin)) > 0.01) drag.moved = true;
        panRef.current = panByDrag(drag.startPan, drag.origin, disk);
      } else {
        const dx = e.clientX - drag.origin.re;
        const dy = e.clientY - drag.origin.im;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        euclidOffsetRef.current = {
          ...euclidOffsetRef.current,
          x: drag.startPan.re + dx,
          y: drag.startPan.im + dy,
        };
      }
    };

    const onPointerUp = (e: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setCursor("grab");
      if (!drag || drag.moved) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (!hit) return;
      selectNode(hit);
    };

    const onWheel = (e: React.WheelEvent) => {
      if (modeRef.current !== "euclid") return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      euclidOffsetRef.current = {
        ...euclidOffsetRef.current,
        scale: Math.min(4, Math.max(0.25, euclidOffsetRef.current.scale * factor)),
      };
    };

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          touchAction: "none",
          cursor: "grab",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          dragRef.current = null;
          setCursor("grab");
        }}
        onWheel={onWheel}
      />
    );
  },
);
