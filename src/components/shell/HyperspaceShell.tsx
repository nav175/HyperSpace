"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HypertreeCanvas } from "@/components/renderer/HypertreeCanvas";
import { DEMO_QUERIES } from "@/lib/data/demoQueries";
import type {
  HypertreeRendererApi,
  Node,
  NodeDetailResponse,
  RenderMode,
} from "@/types/contracts";

interface Props {
  nodes: Node[];
  datasetVersion?: string;
}

function findByTitle(nodes: Node[], title: string): Node | undefined {
  const q = title.toLowerCase();
  return (
    nodes.find((n) => n.title.toLowerCase() === q) ??
    nodes.find((n) => n.title.toLowerCase().includes(q))
  );
}

export function HyperspaceShell({ nodes, datasetVersion }: Props) {
  const apiRef = useRef<HypertreeRendererApi>(null);
  const root = useMemo(
    () => nodes.find((n) => n.parentId === null) ?? nodes[0] ?? null,
    [nodes],
  );
  const [selected, setSelected] = useState<Node | null>(root);
  const [mode, setMode] = useState<RenderMode>("hyperbolic");
  const [status, setStatus] = useState("Drag to pan · click to swell to center");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const demoNodes = useMemo(
    () =>
      DEMO_QUERIES.map((title) => findByTitle(nodes, title)).filter(
        (n): n is Node => Boolean(n),
      ),
    [nodes],
  );

  useEffect(() => {
    setSelected(root);
  }, [root]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.loadTree(nodes);
    api.onSelect((node) => {
      setSelected(node);
      setStatus(`Centered on ${node.title}`);
    });
    if (root) api.highlight([root.id]);
  }, [nodes, root]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [] as Node[];
    return nodes
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.summary.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [nodes, query]);

  const toggleMode = () => {
    const next: RenderMode = mode === "hyperbolic" ? "euclid" : "hyperbolic";
    setMode(next);
    apiRef.current?.setMode(next);
    if (selected) {
      requestAnimationFrame(() => apiRef.current?.flyTo(selected.id));
    }
    setStatus(next === "hyperbolic" ? "Poincaré disk" : "Flat tree · scroll to zoom");
  };

  const flyToNode = async (node: Node) => {
    setSelected(node);
    setQuery(node.title);
    setSearchOpen(false);
    setStatus(`Flying to ${node.title}…`);
    apiRef.current?.flyTo(node.id);

    // Enrich card from /api/node when available (don't steal path glow mid-flight).
    try {
      const res = await fetch(`/api/node/${node.id}`);
      if (!res.ok) return;
      const detail = (await res.json()) as NodeDetailResponse;
      setSelected(detail);
      if (detail.path?.length) {
        setStatus(
          `Centered on ${detail.title} · path depth ${detail.path.length}`,
        );
      }
    } catch {
      // offline /api — local flyTo already ran
    }
  };

  const blurb = selected
    ? selected.summary.length > 160
      ? `${selected.summary.slice(0, 160)}…`
      : selected.summary
    : "Explore the knowledge universe.";

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[var(--bg)]">
      <div className="absolute inset-0">
        <HypertreeCanvas
          ref={apiRef}
          className="h-full w-full"
          initialNodes={nodes}
        />
      </div>

      <header className="hs-enter pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 px-5 pt-5 md:px-8 md:pt-6">
        <div className="pointer-events-auto min-w-0">
          <h1
            className="text-[1.35rem] font-semibold tracking-[-0.03em] text-[var(--fg)] md:text-[1.5rem]"
            style={{ fontFamily: "var(--font-display), Syne, sans-serif" }}
          >
            Hyperspace
          </h1>
          <p className="mt-0.5 text-[13px] text-[var(--fg-muted)]">
            {nodes.length.toLocaleString()} concepts
            {datasetVersion ? ` · ${datasetVersion}` : ""}
          </p>
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleMode}
            className="rounded-full border border-[var(--line)] bg-[var(--bg-elevated)]/85 px-3.5 py-1.5 text-[13px] font-medium text-[var(--fg)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-xl transition-[background-color,transform] duration-200 hover:bg-white active:scale-[0.98]"
          >
            {mode === "hyperbolic" ? "Euclid" : "Hyperbolic"}
          </button>
        </div>
      </header>

      {/* Local search — calm ChatGPT-style pill; vector search wires later */}
      <div className="hs-enter-delay pointer-events-none absolute top-[5.25rem] left-5 z-10 w-[min(320px,calc(100%-2.5rem))] md:left-8">
        <div className="pointer-events-auto relative">
          <label className="sr-only" htmlFor="hs-search">
            Search concepts
          </label>
          <input
            id="hs-search"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) void flyToNode(matches[0]);
              if (e.key === "Escape") {
                setSearchOpen(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Find a concept…"
            autoComplete="off"
            className="w-full rounded-full border border-[var(--line)] bg-[var(--bg-elevated)]/88 py-2.5 pr-4 pl-4 text-[14px] text-[var(--fg)] shadow-[0_4px_24px_rgba(0,0,0,0.05)] outline-none backdrop-blur-2xl transition-[box-shadow,border-color] placeholder:text-[var(--fg-subtle)] focus:border-[rgba(0,102,204,0.35)] focus:shadow-[0_4px_28px_rgba(0,102,204,0.08)]"
          />
          {searchOpen && matches.length > 0 && (
            <ul className="absolute inset-x-0 top-[calc(100%+6px)] overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)]/95 py-1 shadow-[0_12px_40px_rgba(0,0,0,0.08)] backdrop-blur-2xl">
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => void flyToNode(m)}
                    className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--accent-soft)]"
                  >
                    <span className="truncate text-[13px] font-medium text-[var(--fg)]">
                      {m.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--fg-subtle)]">
                      d{m.depth}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {demoNodes.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {demoNodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void flyToNode(n)}
                  className="rounded-full border border-[var(--line)] bg-[var(--bg-elevated)]/75 px-2.5 py-1 text-[11px] font-medium text-[var(--fg-muted)] backdrop-blur-xl transition-colors hover:border-[rgba(0,102,204,0.35)] hover:text-[var(--fg)]"
                >
                  {n.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <aside className="hs-enter-delay pointer-events-none absolute bottom-6 left-5 z-10 w-[min(340px,calc(100%-2.5rem))] md:bottom-8 md:left-8">
        <div className="pointer-events-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)]/88 px-5 py-4 shadow-[0_8px_30px_rgba(0,0,0,0.06)] backdrop-blur-2xl transition-[transform,opacity] duration-300">
          <p className="text-[12px] tracking-wide text-[var(--fg-subtle)] uppercase">
            {selected?.type ?? "concept"}
          </p>
          <h2
            className="mt-1 text-[1.1rem] font-semibold tracking-[-0.02em] text-[var(--fg)]"
            style={{ fontFamily: "var(--font-display), Syne, sans-serif" }}
          >
            {selected?.title ?? "Select a concept"}
          </h2>
          <p className="mt-1.5 text-[13px] leading-snug text-[var(--fg-muted)]">
            {blurb}
          </p>
          {selected && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="text-[13px] font-medium text-[var(--accent)] transition-opacity hover:opacity-70"
              >
                Source
              </a>
              <span className="text-[12px] text-[var(--fg-subtle)]">
                depth {selected.depth}
              </span>
            </div>
          )}
        </div>
      </aside>

      <p className="pointer-events-none absolute right-5 bottom-6 z-10 max-w-[42%] text-right text-[12px] leading-snug text-[var(--fg-subtle)] md:right-8 md:bottom-8">
        {status}
      </p>
    </div>
  );
}
