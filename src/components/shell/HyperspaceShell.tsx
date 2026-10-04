"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HyperspaceCanvas } from "@/components/renderer/HyperspaceCanvas";
import { DEMO_QUERIES } from "@/lib/data/demoQueries";
import { searchLocal } from "@/lib/data/searchLocal";
import { searchNodes } from "@/lib/data/searchNodes";
import type {
  ExpandResponse,
  HypertreeRendererApi,
  Node,
  NodeDetailResponse,
  RenderMode,
} from "@/types/contracts";

function findByTitle(nodes: Node[], title: string): Node | undefined {
  const q = title.toLowerCase();
  return (
    nodes.find((n) => n.title.toLowerCase() === q) ??
    nodes.find((n) => n.title.toLowerCase().includes(q))
  );
}

export function HyperspaceShell() {
  const apiRef = useRef<HypertreeRendererApi>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selected, setSelected] = useState<Node | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Loading universe…");
  const [error, setError] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [mode, setMode] = useState<RenderMode>("hyperbolic");
  const [searching, setSearching] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [libReady, setLibReady] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const loadedRef = useRef(false);
  const nodesRef = useRef<Node[]>([]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const demoNodes = useMemo(
    () =>
      DEMO_QUERIES.map((title) => findByTitle(nodes, title)).filter(
        (n): n is Node => Boolean(n),
      ),
    [nodes],
  );

  const typeahead = useMemo(() => {
    const q = query.trim();
    if (q.length < 2 || !nodes.length) return [] as Node[];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return searchLocal(nodes, q)
      .matches.filter((m) => m.score >= 0.5)
      .slice(0, 6)
      .map((m) => byId.get(m.id))
      .filter((n): n is Node => Boolean(n));
  }, [nodes, query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nodesRes, healthRes] = await Promise.all([
          fetch("/nodes.json"),
          fetch("/api/health").catch(() => null),
        ]);
        if (!nodesRes.ok)
          throw new Error(`Failed to load nodes.json (${nodesRes.status})`);
        const data = (await nodesRes.json()) as Node[];
        if (cancelled) return;
        setNodes(data);
        if (healthRes?.ok) {
          const health = (await healthRes.json()) as { demoMode?: boolean };
          if (health.demoMode) setDemoMode(true);
        }
        setStatus(`Loaded ${data.length.toLocaleString()} concepts…`);
        const root = data.find((n) => n.parentId === null) ?? data[0] ?? null;
        setSelected(root);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load nodes");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enrichNode = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/node/${id}`);
      if (!res.ok) return;
      const detail = (await res.json()) as NodeDetailResponse;
      setSelected(detail);
    } catch {
      /* local card is enough */
    }
  }, []);

  // Mount tree exactly once when both lib + data are ready
  useEffect(() => {
    if (!libReady || !nodes.length || loadedRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    loadedRef.current = true;
    api.onSelect((node) => {
      const full =
        nodesRef.current.find((n) => n.id === node?.id) ??
        (node?.title ? node : null);
      if (!full) return;
      setSelected(full);
      setStatus(`Centered on ${full.title}`);
      void enrichNode(full.id);
    });
    setStatus("Building disk…");
    api.loadTree(nodes);
    setStatus(
      `${nodes.length.toLocaleString()} concepts · pruned for speed${
        demoMode ? " · demo mode" : ""
      }`,
    );
  }, [libReady, nodes, demoMode, enrichNode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
        setPresent((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const flyToNode = useCallback(
    async (node: Node) => {
      setQuery(node.title);
      setSearchOpen(false);
      setSelected(node);
      setStatus(`Flying to ${node.title}…`);
      apiRef.current?.highlight([node.id]);
      apiRef.current?.flyTo(node.id);
      await enrichNode(node.id);
    },
    [enrichNode],
  );

  const runSearch = useCallback(async () => {
    if (!nodes.length || !query.trim()) return;
    setSearching(true);
    setSearchOpen(false);
    try {
      const result = await searchNodes(query, nodes);
      if (!result.matches.length) {
        setStatus(`No matches for “${query.trim()}”`);
        return;
      }
      apiRef.current?.highlight(result.matches.map((m) => m.id));
      apiRef.current?.flyTo(result.focusNodeId);
      const focus =
        nodes.find((n) => n.id === result.focusNodeId) ??
        nodes.find((n) => n.id === result.matches[0]?.id);
      if (focus) {
        setSelected(focus);
        await enrichNode(focus.id);
      }
      setStatus(
        `${result.matches.length} matches · flying to ${focus?.title ?? "result"}`,
      );
    } finally {
      setSearching(false);
    }
  }, [nodes, query, enrichNode]);

  const runExpand = useCallback(async () => {
    if (!selected || expanding) return;
    setExpanding(true);
    setStatus(`Mapping new territory around ${selected.title}…`);
    try {
      const res = await fetch("/api/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: selected.id }),
      });
      if (!res.ok) {
        setStatus(`Expand failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as ExpandResponse;
      if (!data.children?.length) {
        setStatus(`No new branches for ${selected.title}`);
        return;
      }

      const existing = new Set(nodesRef.current.map((n) => n.id));
      const fresh = data.children.filter((c) => !existing.has(c.id));
      const merged = [...nodesRef.current];
      for (const c of data.children) {
        if (existing.has(c.id)) continue;
        merged.push({ ...c, parentId: data.parentId });
        existing.add(c.id);
      }
      setNodes(merged);
      nodesRef.current = merged;

      apiRef.current?.addChildren(data.parentId, data.children);
      apiRef.current?.highlight(data.children.map((c) => c.id));
      setStatus(
        fresh.length
          ? `Grew ${fresh.length} new branch${fresh.length === 1 ? "" : "es"} from ${selected.title}`
          : `Revealed ${data.children.length} branch${data.children.length === 1 ? "" : "es"} under ${selected.title}`,
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Expand failed");
    } finally {
      // Keep the pulse visible briefly so the grow reads as intentional
      window.setTimeout(() => setExpanding(false), 700);
    }
  }, [selected, expanding]);

  const toggleMode = () => {
    const next: RenderMode = mode === "hyperbolic" ? "euclid" : "hyperbolic";
    setMode(next);
    apiRef.current?.setMode(next);
    setStatus(next === "hyperbolic" ? "Poincaré disk" : "Flat radial tree");
  };

  const summary = selected?.summary ?? "";
  const blurb =
    summary.length > 220 ? `${summary.slice(0, 220)}…` : summary;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#0b0d12] text-[#eceff4]">
      <div className="absolute inset-0">
        <HyperspaceCanvas
          ref={apiRef}
          className="h-full w-full"
          onError={(m) => {
            setError(m);
            loadedRef.current = false;
          }}
          onReady={() => {
            setLibReady(true);
            setError(null);
          }}
        />
      </div>

      {error && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-30 w-[min(360px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2">
          <p className="rounded-2xl border border-red-400/30 bg-[#1a1014]/92 px-4 py-3 text-center text-[13px] text-red-200 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            {error}
          </p>
        </div>
      )}

      {expanding && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="mapping-pulse rounded-full border border-[#4ea1ff]/35 bg-[#0b0d12]/55 px-5 py-3 text-[13px] font-medium tracking-wide text-[#9ec5ff] backdrop-blur-md">
            Mapping new territory…
          </div>
        </div>
      )}

      {!present && (
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 px-5 pt-5 md:px-8 md:pt-6">
          <div className="pointer-events-auto">
            <h1
              className="text-[1.35rem] font-semibold tracking-[-0.03em] text-white md:text-[1.5rem]"
              style={{ fontFamily: "var(--font-display), Syne, sans-serif" }}
            >
              Hyperspace
            </h1>
            {demoMode && (
              <p className="mt-0.5 text-[11px] tracking-wide text-[#4ea1ff]/80 uppercase">
                Demo mode
              </p>
            )}
          </div>
          <div className="pointer-events-none flex-1" />
          <div className="pointer-events-auto text-right text-[12px] text-white/55">
            <p>{nodes.length ? nodes.length.toLocaleString() : "—"} nodes</p>
            <p>Source: Wikipedia</p>
            <button
              type="button"
              onClick={toggleMode}
              className="mt-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[12px] text-white/80 transition hover:bg-white/10"
            >
              {mode === "hyperbolic" ? "Euclid" : "Hyperbolic"}
            </button>
          </div>
        </header>
      )}

      <div
        className={`pointer-events-none absolute left-1/2 z-10 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 ${
          present ? "top-4" : "top-[4.75rem]"
        }`}
      >
        <div className="pointer-events-auto relative">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => {
                // Delay so a click on a suggestion still registers
                window.setTimeout(() => setSearchOpen(false), 150);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder='Search — try “humanoid robot”'
              autoComplete="off"
              className="w-full rounded-full border border-white/12 bg-[#12151c]/88 px-4 py-2.5 text-[14px] text-white shadow-[0_8px_32px_rgba(0,0,0,0.35)] outline-none backdrop-blur-xl placeholder:text-white/35 focus:border-[#4ea1ff]/50"
            />
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="shrink-0 rounded-full bg-[#4ea1ff] px-4 py-2.5 text-[13px] font-semibold text-[#0b0d12] transition enabled:hover:brightness-110 disabled:opacity-40"
            >
              Go
            </button>
          </form>

          {searchOpen && typeahead.length > 0 && (
            <ul className="absolute inset-x-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-2xl border border-white/10 bg-[#12151c]/95 py-1 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
              {typeahead.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => void flyToNode(m)}
                    className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                  >
                    <span className="truncate text-[13px] font-medium text-white">
                      {m.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-white/35">
                      d{m.depth}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!present && demoNodes.length > 0 && (
          <div className="pointer-events-auto mt-2 flex flex-wrap justify-center gap-1.5">
            {demoNodes.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => void flyToNode(n)}
                className="rounded-full border border-white/12 bg-[#12151c]/75 px-2.5 py-1 text-[11px] font-medium text-white/60 backdrop-blur-xl transition-colors hover:border-[#4ea1ff]/40 hover:text-white"
              >
                {n.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <aside className="pointer-events-none absolute bottom-6 left-5 z-10 w-[min(360px,calc(100%-2.5rem))] md:bottom-8 md:left-8">
          <div className="pointer-events-auto rounded-2xl border border-white/10 bg-[#12151c]/90 px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
            <p className="text-[11px] tracking-wide text-white/40 uppercase">
              {selected.type ?? "concept"}
            </p>
            <h2
              className="mt-1 text-[1.1rem] font-semibold tracking-[-0.02em] text-white"
              style={{ fontFamily: "var(--font-display), Syne, sans-serif" }}
            >
              {selected.title}
            </h2>
            <p className="mt-1.5 text-[13px] leading-snug text-white/65">
              {blurb}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-medium text-[#4ea1ff] hover:opacity-80"
                >
                  Read on Wikipedia
                </a>
              )}
              <button
                type="button"
                disabled={expanding || mode === "euclid"}
                onClick={() => void runExpand()}
                className="rounded-full border border-[#4ea1ff]/40 bg-[#4ea1ff]/10 px-3 py-1 text-[12px] font-medium text-[#9ec5ff] transition enabled:hover:bg-[#4ea1ff]/20 disabled:opacity-35"
              >
                {expanding ? "Mapping…" : "Expand"}
              </button>
            </div>
          </div>
        </aside>
      )}

      {!present && (
        <p className="pointer-events-none absolute right-5 bottom-6 z-10 max-w-[40%] text-right text-[12px] text-white/40 md:right-8 md:bottom-8">
          {status}
          <span className="mt-1 block text-white/25">
            Press P for presentation
          </span>
        </p>
      )}
    </div>
  );
}
