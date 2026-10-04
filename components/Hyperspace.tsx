'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { pathOf, searchUniverse, type SearchResult } from './search';
import { Universe, type Mode, type ThemeName, type UNode } from './universe/Universe';

const ZOOM_STEP = 1.5;
const VISIBLE_MATCHES = 6; // suggestions listed under the search bar, and framed on Enter
const WIDE = '(min-width: 761px)'; // the CSS breakpoint: wider screens show the card and suggestions beside the disk
const CARD_ROOM = 404; // the card's width plus its margins

export default function Hyperspace({ fontFamily }: { fontFamily: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const universeRef = useRef<Universe | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<UNode[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<UNode | null>(null);
  const [mode, setModeState] = useState<Mode>('hyperbolic');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<(SearchResult & { query: string }) | null>(null);
  const [searching, setSearching] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // True once you move through the suggestions (arrows or pointer): Enter then means that row,
  // not "show me all the matches".
  const [stepped, setStepped] = useState(false);
  const [searchHovered, setSearchHovered] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [introducing, setIntroducing] = useState(true);
  const [theme, setTheme] = useState<ThemeName>('dark');
  const themeRef = useRef<ThemeName>('dark');
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
    const universe = new Universe(canvasRef.current, { fontFamily, theme: themeRef.current });
    universe.loadTree(nodes);
    universe.onSelect(focusNode);
    universeRef.current = universe;
    return () => {
      universe.destroy();
      universeRef.current = null;
    };
  }, [nodes, fontFamily, focusNode]);

  // The layout's inline script already applied the saved theme to <html> before the first paint.
  useEffect(() => {
    if (document.documentElement.dataset.theme === 'light') setTheme('light');
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    universeRef.current?.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('hyperspace-theme', next);
      } catch {
        // Private browsing can block storage; the theme still applies for this visit.
      }
      return next;
    });
  }, []);

  // Keep the disk clear of the panels, so they never cover the matches they describe. On wide screens
  // the card sits on the right and the suggestions on the left; on phones (the CSS breakpoint) the card
  // slides up over the bottom and the suggestions drop below the search bar, so the disk moves down.
  // Re-check on resize, since rotating or resizing can cross the breakpoint.
  const suggestionsShown = resultsOpen && result !== null;
  // While you look through new suggestions the card for the last topic steps aside, so the disk keeps
  // its size; it returns when the list closes (Enter swaps in the best match).
  const cardShown = selected !== null && !suggestionsShown;
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const update = () => {
      const list = suggestionsShown ? resultsRef.current?.getBoundingClientRect() : undefined;
      universeRef.current?.setInsets({
        left: list && wide.matches ? list.right + 24 : 0,
        right: cardShown && wide.matches ? CARD_ROOM : 0,
        top: list && !wide.matches ? list.bottom + 8 : 0,
      });
    };
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, [cardShown, suggestionsShown, result]);

  const goHome = useCallback(() => {
    if (!root) return;
    universeRef.current?.resetZoom();
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

  // Suggestions follow the text as you type: a short pause, then search. Each keystroke cancels the
  // previous request, so a slow answer for old text can never replace the current suggestions.
  // Matches light up in the universe right away; flying waits for Enter or a click.
  useEffect(() => {
    const text = query.trim();
    if (!nodes) return;
    if (!text) {
      setResult(null);
      setSearching(false);
      universeRef.current?.highlight([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      const found = await searchUniverse(text, nodes, byId, controller.signal);
      if (!found) return;
      setSearching(false);
      setResult({ ...found, query: text });
      setActiveIndex(0);
      setStepped(false);
      if (document.activeElement === inputRef.current) setResultsOpen(true);
      universeRef.current?.highlight(found.matches.map((match) => match.id));
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, nodes, byId]);

  function chooseMatch(id: number) {
    const node = byId.get(id);
    if (!node) return;
    focusNode(node);
    setResultsOpen(false);
    inputRef.current?.blur();
  }

  // Enter shows every suggestion on the map at once: the view moves to where they all fit, the best
  // match gets the focus ring, and the rest stay lit and labelled in case you meant one of them.
  // On wide screens the best match's card opens beside the disk; on phones it would slide up over
  // half the matches, so it waits for a tap.
  function showMatches(found: SearchResult) {
    const ids = found.matches.slice(0, VISIBLE_MATCHES).map((match) => match.id);
    const best = found.focusNodeId ?? ids[0];
    if (best === undefined) return;
    universeRef.current?.flyToAll(ids, best);
    setSelected(window.matchMedia(WIDE).matches ? (byId.get(best) ?? null) : null);
    setExplored(true);
    setResultsOpen(false);
    inputRef.current?.blur();
  }

  // Enter shows all the matches, or flies to the suggestion you stepped to. If the suggestions are
  // still catching up with the text, search right away instead of waiting for the pause.
  async function submitSearch(e: FormEvent) {
    e.preventDefault();
    const text = query.trim();
    if (!text || !nodes) return;
    if (result?.query === text) {
      const match = result.matches[activeIndex];
      if (stepped && match) chooseMatch(match.id);
      else showMatches(result);
      return;
    }
    setSearching(true);
    const found = await searchUniverse(text, nodes, byId);
    setSearching(false);
    if (!found) return;
    setResult({ ...found, query: text });
    setActiveIndex(0);
    setStepped(false);
    universeRef.current?.highlight(found.matches.map((match) => match.id));
    showMatches(found);
  }

  const visibleMatches = result?.matches.slice(0, VISIBLE_MATCHES) ?? [];

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!resultsOpen || !visibleMatches.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (stepped ? (index + step + visibleMatches.length) % visibleMatches.length : step > 0 ? 0 : visibleMatches.length - 1));
      setStepped(true);
    }
  }

  // The search bar rests as a small pill and opens up when you reach for it. It starts open for a
  // moment after the universe loads, so people see where it is, then tucks itself away.
  useEffect(() => {
    if (!nodes) return;
    const timer = setTimeout(() => setIntroducing(false), 2600);
    return () => clearTimeout(timer);
  }, [nodes]);
  const searchExpanded = searchHovered || searchFocused || resultsOpen || introducing;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement === inputRef.current;
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        // One layer per press: the suggestions, then the search field, then the card.
        if (resultsOpen) setResultsOpen(false);
        else if (typing) inputRef.current?.blur();
        else setSelected(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'h') goHome();
      if (key === 'p') setPresenting((value) => !value);
      if (key === 'f') setMode(mode === 'hyperbolic' ? 'euclid' : 'hyperbolic');
      if (key === 't') toggleTheme();
      if (key === '+' || key === '=') universeRef.current?.zoomBy(ZOOM_STEP);
      if (key === '-' || key === '_') universeRef.current?.zoomBy(1 / ZOOM_STEP);
      if (key === '0') universeRef.current?.resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goHome, mode, resultsOpen, setMode, toggleTheme]);

  const path = selected ? pathOf(selected.id, byId).map((id) => byId.get(id)!) : [];
  const breadcrumb = (id: number) =>
    pathOf(id, byId)
      .slice(1, -1)
      .map((step) => byId.get(step)!.title)
      .join(' › ');

  return (
    <main className={['stage', presenting && 'presenting', suggestionsShown && 'suggesting'].filter(Boolean).join(' ')}>
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

      <div
        className={searchExpanded ? 'search expanded' : 'search'}
        onMouseEnter={() => setSearchHovered(true)}
        onMouseLeave={() => setSearchHovered(false)}
      >
        <form onSubmit={submitSearch} className={searching ? 'search-field busy' : 'search-field'}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => {
              setSearchFocused(true);
              if (result) setResultsOpen(true);
            }}
            onBlur={() => setSearchFocused(false)}
            placeholder={searchExpanded ? 'Try “AI that understands images”' : 'Search'}
            aria-label="Search the universe"
            aria-expanded={resultsOpen}
            aria-controls="search-results"
            spellCheck={false}
            autoComplete="off"
          />
          {query ? (
            <button type="button" className="clear" onClick={clearSearch} aria-label="Clear search">
              ×
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </form>
      </div>

      {suggestionsShown && (
        <div className="results" role="listbox" id="search-results" ref={resultsRef} aria-label={`Matches for ${result.query}`}>
          {visibleMatches.length > 0 && <p className="results-head">Matches for “{result.query}”</p>}
          {visibleMatches.length ? (
            visibleMatches.map((match, index) => (
              <button
                key={match.id}
                role="option"
                aria-selected={stepped && index === activeIndex}
                className={stepped && index === activeIndex ? 'result active' : 'result'}
                onMouseEnter={() => {
                  setActiveIndex(index);
                  setStepped(true);
                }}
                // Keep focus in the field until the click lands, so the bar doesn't collapse under the cursor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => chooseMatch(match.id)}
              >
                <span className="result-title">{match.title}</span>
                <span className="result-path">{breadcrumb(match.id) || 'Artificial intelligence'}</span>
              </button>
            ))
          ) : (
            <p className="results-empty">Nothing matches that yet.</p>
          )}
          {result.offline && <p className="results-note">Offline · keyword matches</p>}
        </div>
      )}

      <div className="toolbar">
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme (T)' : 'Dark theme (T)'}
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" />
            </svg>
          )}
        </button>
        <div className="modes" role="group" aria-label="Geometry">
          <button className={mode === 'hyperbolic' ? 'active' : ''} onClick={() => setMode('hyperbolic')}>
            Hyperbolic
          </button>
          <button className={mode === 'euclid' ? 'active' : ''} onClick={() => setMode('euclid')}>
            Flat
          </button>
        </div>
      </div>

      {cardShown && (
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
        <p className={explored ? 'hint hidden' : 'hint'}>Click a topic to bring it to the centre · Scroll or drag to explore · Pinch to zoom</p>
      </footer>

      <div className="controls" role="group" aria-label="View">
        <button onClick={() => universeRef.current?.zoomBy(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in (+)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6v12M6 12h12" />
          </svg>
        </button>
        <button onClick={() => universeRef.current?.zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out (−)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 12h12" />
          </svg>
        </button>
        <button onClick={goHome} aria-label="Back to the centre" title="Back to the centre (H)">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="7.5" />
            <circle cx="12" cy="12" r="2" />
          </svg>
        </button>
      </div>
    </main>
  );
}
