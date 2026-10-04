'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { pathOf, searchUniverse, type SearchResult } from './search';
import { Universe, type Mode, type UNode } from './universe/Universe';

export default function Hyperspace({ fontFamily }: { fontFamily: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const universeRef = useRef<Universe | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [nodes, setNodes] = useState<UNode[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<UNode | null>(null);
  const [mode, setModeState] = useState<Mode>('hyperbolic');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [explored, setExplored] = useState(false);

  const byId = useMemo(() => new Map((nodes ?? []).map((node) => [node.id, node])), [nodes]);
  const childCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const node of nodes ?? []) if (node.parentId !== null) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    return counts;
  }, [nodes]);
  const root = useMemo(() => nodes?.find((node) => node.parentId === null) ?? null, [nodes]);

  const focusNode = useCallback((node: UNode) => {
    universeRef.current?.flyTo(node.id);
    setSelected(node);
    setExplored(true);
  }, []);

  // The universe is a static file, so it loads instantly and works offline.
  useEffect(() => {
    let cancelled = false;
    fetch('/nodes.json')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<UNode[]>;
      })
      .then((data) => !cancelled && setNodes(data))
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!nodes || !canvasRef.current) return;
    const universe = new Universe(canvasRef.current, { fontFamily });
    universe.loadTree(nodes);
    universe.onSelect(focusNode);
    universeRef.current = universe;
    return () => {
      universe.destroy();
      universeRef.current = null;
    };
  }, [nodes, fontFamily, focusNode]);

  // Make room for the card on wide screens; on phones it slides up from the bottom instead.
  useEffect(() => {
    universeRef.current?.setRightInset(selected && window.innerWidth > 760 ? 404 : 0);
  }, [selected]);

  const goHome = useCallback(() => {
    if (!root) return;
    universeRef.current?.flyTo(root.id);
    setSelected(null);
  }, [root]);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    universeRef.current?.setMode(next);
  }, []);

  const clearSearch = useCallback(() => {
    setQuery('');
    setResult(null);
    setResultsOpen(false);
    universeRef.current?.highlight([]);
  }, []);

  async function runSearch(e?: FormEvent) {
    e?.preventDefault();
    const text = query.trim();
    if (!text || !nodes) return;
    setSearching(true);
    const found = await searchUniverse(text, nodes, byId);
    setSearching(false);
    setResult(found);
    setResultsOpen(true);
    universeRef.current?.highlight(found.matches.map((match) => match.id));
    const focus = found.focusNodeId === null ? undefined : byId.get(found.focusNodeId);
    if (focus) focusNode(focus);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === inputRef.current;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (typing) inputRef.current?.blur();
        if (resultsOpen) setResultsOpen(false);
        else setSelected(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'h') goHome();
      if (key === 'p') setPresenting((value) => !value);
      if (key === 'f') setMode(mode === 'hyperbolic' ? 'euclid' : 'hyperbolic');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goHome, mode, resultsOpen, setMode]);

  const path = selected ? pathOf(selected.id, byId).map((id) => byId.get(id)!) : [];
  const breadcrumb = (id: number) =>
    pathOf(id, byId)
      .slice(1, -1)
      .map((step) => byId.get(step)!.title)
      .join(' › ');

  return (
    <main className={presenting ? 'stage presenting' : 'stage'}>
      <canvas
        ref={canvasRef}
        className="universe"
        aria-label="Interactive map of AI knowledge on a Poincaré disk"
        onPointerDown={() => setResultsOpen(false)}
      />

      {!nodes && (
        <div className="loading" role="status">
          {loadError ? 'The universe could not be loaded.' : 'Mapping the universe…'}
        </div>
      )}

      <header className="brand">
        <h1>Hyperspace</h1>
        <p>{nodes ? `${nodes.length.toLocaleString()} AI topics from Wikipedia` : 'A living map of knowledge'}</p>
      </header>

      <div className="search">
        <form onSubmit={runSearch} className={searching ? 'search-field busy' : 'search-field'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => result && setResultsOpen(true)}
            placeholder="Search by meaning: “AI that understands images”"
            aria-label="Search the universe"
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="clear" onClick={clearSearch} aria-label="Clear search">
              ×
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </form>

        {resultsOpen && result && (
          <div className="results" role="listbox">
            {result.matches.length ? (
              result.matches.slice(0, 6).map((match) => {
                const node = byId.get(match.id);
                if (!node) return null;
                return (
                  <button
                    key={match.id}
                    className="result"
                    onClick={() => {
                      focusNode(node);
                      setResultsOpen(false);
                    }}
                  >
                    <span className="result-title">{match.title}</span>
                    <span className="result-path">{breadcrumb(match.id) || 'Artificial intelligence'}</span>
                  </button>
                );
              })
            ) : (
              <p className="results-empty">Nothing matches that yet.</p>
            )}
            {result.offline && <p className="results-note">Offline · keyword matches</p>}
          </div>
        )}
      </div>

      <div className="modes" role="group" aria-label="Geometry">
        <button className={mode === 'hyperbolic' ? 'active' : ''} onClick={() => setMode('hyperbolic')}>
          Hyperbolic
        </button>
        <button className={mode === 'euclid' ? 'active' : ''} onClick={() => setMode('euclid')}>
          Flat
        </button>
      </div>

      {selected && (
        <aside className="card" key={selected.id}>
          <button className="card-close" onClick={() => setSelected(null)} aria-label="Close">
            ×
          </button>
          {path.length > 1 && (
            <nav className="crumbs" aria-label="Path">
              {path.slice(0, -1).map((step) => (
                <button key={step.id} onClick={() => focusNode(step)}>
                  {step.title}
                </button>
              ))}
            </nav>
          )}
          <h2>{selected.title}</h2>
          <p className="card-meta">
            {selected.type === 'category' ? `Field · ${childCount.get(selected.id) ?? 0} topics` : 'Topic'}
          </p>
          <p className="card-summary">{selected.summary}</p>
          <a className="card-link" href={selected.url} target="_blank" rel="noreferrer">
            Read on Wikipedia
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        </aside>
      )}

      <footer className="dock">
        <p className={explored ? 'hint hidden' : 'hint'}>Click any topic to bring it to the centre · Drag to explore</p>
        <button className="home" onClick={goHome} aria-label="Back to the centre" title="Back to the centre (H)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        </button>
      </footer>
    </main>
  );
}
