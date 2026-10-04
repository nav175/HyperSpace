'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Intro, { type IntroMode } from './Intro';
import { pathOf, searchUniverse, type SearchResult } from './search';
import { Universe, type Mode, type ThemeName, type UNode } from './universe/Universe';

type Connection = {
  from: UNode;
  to: UNode;
  hops: number[]; // node ids along the map's path, from → shared field → to
  distance: number | null; // hyperbolic distance between the two
  explanation: string | null;
  status: 'loading' | 'done' | 'error';
};

type Answer = {
  question: string;
  status: 'loading' | 'done' | 'error';
  text: string; // with [id] citations
  sources: { id: number; title: string }[];
};

// Questions go to Gemini; topic names go to search. A "?" or a question word reads as a question.
const QUESTION = /\?\s*$|^(how|what|why|which|who|when|where|can|could|does|do|is|are|should|will|would|explain|tell me)\b/i;

const ZOOM_STEP = 1.5;
const AUTO_GROW_DWELL = 900; // ms resting on an edge topic before it grows by itself
const VISIBLE_MATCHES = 6; // suggestions listed under the search bar, and framed on Enter
const WIDE = '(min-width: 761px)'; // the CSS breakpoint: wider screens show the card and suggestions beside the disk
const CARD_ROOM = 404; // the card's width plus its margins
const PHONE_TITLE_BOTTOM = 136; // where the title ends on phones (search bar, then title)

// The opening titles play on ?intro; the inline script in app/layout.tsx marks <html> before first paint.
function requestedIntro(): IntroMode | null {
  if (typeof document === 'undefined') return null;
  const value = document.documentElement.dataset.intro;
  return value === undefined ? null : value === 'capture' ? 'capture' : 'live';
}

export default function Hyperspace({ fontFamily }: { fontFamily: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const universeRef = useRef<Universe | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLElement>(null);
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
  // The opening titles (?intro), until they land on the page. They render only once the universe has
  // loaded, which never happens on the server, so reading the address here can't upset hydration.
  const [intro, setIntro] = useState<IntroMode | null>(requestedIntro);
  const introRef = useRef(intro);
  const [introducing, setIntroducing] = useState(true);
  const [theme, setTheme] = useState<ThemeName>('dark');
  const themeRef = useRef<ThemeName>('dark');
  const [presenting, setPresenting] = useState(false);
  const [explored, setExplored] = useState(false);
  // Expand: topics Gemini grew this visit, which one is growing now, and what happened last time.
  const [grown, setGrown] = useState<UNode[]>([]);
  const [growing, setGrowing] = useState<number | null>(null);
  const [growNote, setGrowNote] = useState<{ id: number; text: string } | null>(null);
  // Auto-grow (A): grow topics at the edges of the map as you reach them.
  const [autoGrow, setAutoGrow] = useState(true);
  const [autoGrowing, setAutoGrowing] = useState(false);
  const attempted = useRef(new Set<number>()); // topics already grown (or tried) this visit
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const growingRef = useRef<number | null>(null);
  const settleRef = useRef<(node: UNode | null) => void>(() => {});
  useEffect(() => {
    growingRef.current = growing;
  }, [growing]);
  // The geometry lens (G): distance rings on the disk, and a card explaining them.
  const [lens, setLens] = useState(false);
  const [hovered, setHovered] = useState<UNode | null>(null);
  // The search matches currently lit, so a new branch's highlight can hand back to them afterwards.
  const searchLit = useRef<number[]>([]);
  const growTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const allNodes = useMemo(() => (nodes ? [...nodes, ...grown] : null), [nodes, grown]);
  const byId = useMemo(() => new Map((allNodes ?? []).map((node) => [node.id, node])), [allNodes]);
  const childCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const node of allNodes ?? []) if (node.parentId !== null) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    return counts;
  }, [allNodes]);

  // The offline keyword search reads the latest universe, including grown topics, without making
  // the suggestions effect re-run (and re-light matches) every time a branch grows.
  const latest = useRef({ allNodes, byId });
  useEffect(() => {
    latest.current = { allNodes, byId };
  }, [allNodes, byId]);

  const lightMatches = useCallback((ids: number[]) => {
    searchLit.current = ids;
    universeRef.current?.highlight(ids);
  }, []);

  const closeConnection = useCallback(() => {
    setConnection(null);
    universeRef.current?.highlight(searchLit.current);
  }, []);

  const closeAnswer = useCallback(() => {
    setAnswer(null);
    universeRef.current?.highlight(searchLit.current);
  }, []);
  const root = useMemo(() => nodes?.find((node) => node.parentId === null) ?? null, [nodes]);

  // "How are these connected?": the topic waiting for a partner, and the connection being shown.
  const [connectFrom, setConnectFrom] = useState<UNode | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  // "Ask Hyperspace": a question answered by Gemini from the topics TiDB finds for it.
  const [answer, setAnswer] = useState<Answer | null>(null);
  // Picking any topic (map, search, breadcrumbs) completes a pending connection. focusNode has to stay
  // stable (the universe holds on to it), so it reads the pending topic and the handler from refs.
  const connectFromRef = useRef<UNode | null>(null);
  const connectRef = useRef<(from: UNode, to: UNode) => void>(() => {});
  useEffect(() => {
    connectFromRef.current = connectFrom;
  }, [connectFrom]);

  const focusNode = useCallback((node: UNode) => {
    const from = connectFromRef.current;
    if (from && from.id !== node.id) {
      connectRef.current(from, node);
      return;
    }
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
    // Each time the page loads, the universe unfolds from its centre. The opening titles (?intro) hide
    // it instead, and unfold it themselves when their moment comes.
    if (introRef.current) universe.setIntro(0);
    else universe.unfold();
    universe.onSelect(focusNode);
    universe.onHover(setHovered);
    universe.onSettle((node) => settleRef.current(node));
    universeRef.current = universe;
    // A shared link (?topic=<id>) opens on that topic.
    const shared = Number(new URLSearchParams(window.location.search).get('topic'));
    const start = nodes.find((node) => node.id === shared);
    if (start) focusNode(start);
    return () => {
      universe.destroy();
      universeRef.current = null;
    };
  }, [nodes, fontFamily, focusNode]);

  // Keep the address bar on the topic you're looking at, so it can be shared or bookmarked. It waits
  // for the universe, which reads a shared ?topic= first.
  useEffect(() => {
    if (!nodes) return;
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set('topic', String(selected.id));
    else url.searchParams.delete('topic');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [selected, nodes]);

  // Listen (ElevenLabs): only offered when the server has a key. Audio for each text is fetched once.
  const [voice, setVoice] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCache = useRef(new Map<string, string>());
  useEffect(() => {
    fetch('/api/speak')
      .then((res) => (res.ok ? (res.json() as Promise<{ enabled: boolean }>) : { enabled: false }))
      .then(({ enabled }) => setVoice(enabled))
      .catch(() => setVoice(false));
  }, []);

  const stopSpeaking = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setSpeaking(null);
  }, []);

  // Plays `text` (or stops it if it's already playing). `id` names what's being read, for the button.
  const listen = useCallback(
    async (id: string, text: string) => {
      if (speaking === id) return stopSpeaking();
      stopSpeaking();
      setVoiceError(null);
      setSpeaking(id);
      try {
        let url = audioCache.current.get(text);
        if (!url) {
          const res = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(25_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          url = URL.createObjectURL(await res.blob());
          audioCache.current.set(text, url);
        }
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => setSpeaking((current) => (current === id ? null : current));
        await audio.play();
      } catch {
        setSpeaking((current) => (current === id ? null : current));
        setVoiceError(id);
      }
    },
    [speaking, stopSpeaking]
  );

  // Moving to another topic stops the reading.
  useEffect(() => {
    stopSpeaking();
  }, [selected?.id, answer?.question, connection?.to.id, stopSpeaking]);

  const [copied, setCopied] = useState<number | null>(null);
  const copyLink = useCallback(async (node: UNode) => {
    const url = new URL(window.location.href);
    url.searchParams.set('topic', String(node.id));
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(node.id);
      setTimeout(() => setCopied((id) => (id === node.id ? null : id)), 1800);
    } catch {
      // Clipboard blocked (e.g. not a secure context): the address bar has the link anyway.
    }
  }, []);

  // The layout's inline script already applied the saved theme to <html> before the first paint.
  useEffect(() => {
    if (document.documentElement.dataset.theme === 'light') setTheme('light');
  }, []);

  useEffect(() => {
    universeRef.current?.setLens(lens);
  }, [lens, nodes]);

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
  // One panel on the right at a time: an answer, else a connection, else the topic card.
  const answerShown = answer !== null && !suggestionsShown;
  const connectionShown = connection !== null && !suggestionsShown && !answer;
  const cardShown = selected !== null && !suggestionsShown && !connection && !answer;
  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    const update = () => {
      const list = suggestionsShown ? resultsRef.current?.getBoundingClientRect() : undefined;
      // The lens card sits in the same left column, below where the suggestions would be.
      const lensCard = lens && !suggestionsShown ? lensRef.current?.getBoundingClientRect() : undefined;
      const leftPanel = Math.max(list?.right ?? 0, lensCard?.right ?? 0);
      // Phones: the lens card sits at the bottom, so the disk fits between the title and the card.
      const phoneLens = lensCard && !wide.matches;
      universeRef.current?.setInsets({
        left: leftPanel && wide.matches ? leftPanel + 24 : 0,
        right: (cardShown || connectionShown || answerShown) && wide.matches ? CARD_ROOM : 0,
        top: list && !wide.matches ? list.bottom + 8 : phoneLens ? PHONE_TITLE_BOTTOM : 0,
        bottom: phoneLens ? window.innerHeight - lensCard.top + 8 : 0,
      });
    };
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, [cardShown, connectionShown, answerShown, suggestionsShown, result, lens]);

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
    lightMatches([]);
  }, [lightMatches]);

  // Suggestions follow the text as you type: a short pause, then search. Each keystroke cancels the
  // previous request, so a slow answer for old text can never replace the current suggestions.
  // Matches light up in the universe right away; flying waits for Enter or a click.
  useEffect(() => {
    const text = query.trim();
    if (!nodes) return;
    if (!text) {
      setResult(null);
      setSearching(false);
      lightMatches([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      const found = await searchUniverse(text, latest.current.allNodes ?? nodes, latest.current.byId, controller.signal);
      if (!found) return;
      setSearching(false);
      setResult({ ...found, query: text });
      setActiveIndex(0);
      setStepped(false);
      if (document.activeElement === inputRef.current) setResultsOpen(true);
      lightMatches(found.matches.map((match) => match.id));
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, nodes, lightMatches]);

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
    // Picking a partner for "How are these connected?": Enter connects to the best match.
    const from = connectFromRef.current;
    const bestNode = byId.get(best);
    if (from && bestNode && bestNode.id !== from.id) {
      connect(from, bestNode);
      inputRef.current?.blur();
      return;
    }
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
    // A question, unless you've stepped to a suggestion: ask Gemini instead of searching.
    if (text.endsWith('?') && !stepped) {
      ask(text);
      return;
    }
    if (result?.query === text) {
      const match = result.matches[activeIndex];
      if (stepped && match) chooseMatch(match.id);
      else showMatches(result);
      return;
    }
    setSearching(true);
    const found = await searchUniverse(text, allNodes ?? nodes, byId);
    setSearching(false);
    if (!found) return;
    setResult({ ...found, query: text });
    setActiveIndex(0);
    setStepped(false);
    lightMatches(found.matches.map((match) => match.id));
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
  // After the opening titles it's tucked away from the start, as the page they land on shows it.
  useEffect(() => {
    if (!nodes) return;
    const timer = setTimeout(() => setIntroducing(false), introRef.current ? 0 : 2600);
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
        // One layer per press: the suggestions, the search field, picking a topic to connect, the
        // connection, then the card.
        if (resultsOpen) setResultsOpen(false);
        else if (typing) inputRef.current?.blur();
        else if (connectFrom) setConnectFrom(null);
        else if (answer) closeAnswer();
        else if (connection) closeConnection();
        else setSelected(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'h') goHome();
      if (key === 'p') setPresenting((value) => !value);
      if (key === 'f') setMode(mode === 'hyperbolic' ? 'euclid' : 'hyperbolic');
      if (key === 't') toggleTheme();
      if (key === 'g') setLens((on) => !on);
      if (key === 'a') setAutoGrow((on) => !on);
      if (key === '+' || key === '=') universeRef.current?.zoomBy(ZOOM_STEP);
      if (key === '-' || key === '_') universeRef.current?.zoomBy(1 / ZOOM_STEP);
      if (key === '0') universeRef.current?.resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goHome, mode, resultsOpen, setMode, toggleTheme, connectFrom, connection, closeConnection, answer, closeAnswer]);

  // Expand: Gemini picks related Wikipedia topics to grow under this one (POST /api/expand). The new
  // branches grow out of the node and light up for a moment, then any search highlight comes back.
  // `auto`: grown because you reached an edge of the map, so the camera stays where you put it.
  async function grow(node: UNode, { auto = false }: { auto?: boolean } = {}) {
    if (growing !== null) return;
    attempted.current.add(node.id);
    setGrowing(node.id);
    setAutoGrowing(auto);
    setGrowNote(null);
    // Bring the topic to the centre first, so its new branches grow where you're looking.
    if (!auto) universeRef.current?.flyTo(node.id);
    try {
      const res = await fetch('/api/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: node.id, depth: node.depth }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { parentId: number; children: UNode[]; model?: string };
      const fresh = data.children.filter((child) => !byId.has(child.id));
      if (fresh.length) {
        setGrown((current) => [...current, ...fresh]);
        universeRef.current?.addChildren(node.id, fresh);
        universeRef.current?.highlight(fresh.map((child) => child.id));
        // Follow the growth: frame the topic with its new branches, so they get room and labels.
        if (!auto) universeRef.current?.flyToAll([node.id, ...fresh.map((child) => child.id)], node.id);
        clearTimeout(growTimer.current);
        growTimer.current = setTimeout(() => universeRef.current?.highlight(searchLit.current), 4500);
      }
      const by = data.model?.startsWith('gemini') ? 'Gemini' : 'Wikipedia';
      setGrowNote({
        id: node.id,
        text: fresh.length
          ? `${by} grew ${fresh.length} new ${fresh.length === 1 ? 'topic' : 'topics'} here`
          : 'Nothing new to grow here yet',
      });
    } catch {
      // An automatic grow fails quietly; you can still press the button.
      if (!auto) setGrowNote({ id: node.id, text: "Couldn't grow this branch just now. Try again." });
    } finally {
      setGrowing(null);
      setAutoGrowing(false);
    }
  }

  // Auto-grow: when the camera comes to rest on a topic with no branches yet (an edge of the map) and
  // stays there for a moment, grow it, once per topic.
  function onSettle(node: UNode | null) {
    clearTimeout(settleTimer.current);
    if (!autoGrow || !node || childCount.has(node.id) || attempted.current.has(node.id) || growing !== null) return;
    settleTimer.current = setTimeout(() => {
      if (growingRef.current === null) grow(node, { auto: true });
    }, AUTO_GROW_DWELL);
  }

  useEffect(() => {
    settleRef.current = onSettle;
  });
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // Ask Hyperspace: TiDB finds the topics for the question, Gemini answers from them and cites them.
  // The cited topics light up and the camera frames them.
  function ask(question: string) {
    setResultsOpen(false);
    inputRef.current?.blur();
    setConnectFrom(null);
    setConnection(null);
    setExplored(true);
    setAnswer({ question, status: 'loading', text: '', sources: [] });
    const same = (a: Answer | null) => a !== null && a.question === question;
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(25_000),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ answer: string; sources: Answer['sources'] }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(({ answer: text, sources }) => {
        setAnswer((a) => (same(a) ? { question, status: 'done', text, sources } : a));
        const ids = sources.map((source) => source.id).filter((id) => byId.has(id));
        if (ids.length) {
          universeRef.current?.highlight(ids);
          universeRef.current?.flyToAll(ids, ids[0]);
        }
      })
      .catch(() => setAnswer((a) => (same(a) ? { ...a!, status: 'error' } : a)));
  }

  // The answer with its [id] citations turned into buttons that fly to the topic.
  function renderAnswer(a: Answer) {
    const titles = new Map(a.sources.map((source) => [source.id, source.title]));
    return a.text.split(/(\[\d+\])/g).map((part, k) => {
      const id = Number(part.match(/^\[(\d+)\]$/)?.[1]);
      if (!id) return part;
      const title = titles.get(id) ?? byId.get(id)?.title;
      return title ? (
        <button key={k} className="cite" onClick={() => byId.get(id) && focusNode(byId.get(id)!)} title={`Go to ${title}`}>
          {title}
        </button>
      ) : null;
    });
  }

  // Show how two topics connect: the camera travels the tree path between them (up to the field they
  // share, then down), the path lights up, and Gemini explains the link.
  function connect(from: UNode, to: UNode) {
    setConnectFrom(null);
    const up = pathOf(from.id, byId);
    const down = pathOf(to.id, byId);
    let shared = 0;
    while (shared < up.length && shared < down.length && up[shared] === down[shared]) shared++;
    const hops = [...up.slice(Math.max(0, shared - 1)).reverse(), ...down.slice(shared)];
    universeRef.current?.highlight(hops, { ancestors: false });
    universeRef.current?.flyAlong(hops);
    setSelected(to);
    setExplored(true);
    setResultsOpen(false);
    const distance = universeRef.current?.distanceBetween(from.id, to.id) ?? null;
    setConnection({ from, to, hops, distance, explanation: null, status: 'loading' });
    const same = (c: Connection | null) => c !== null && c.from.id === from.id && c.to.id === to.id;
    fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { title: from.title, summary: from.summary },
        to: { title: to.title, summary: to.summary },
        path: hops.map((id) => byId.get(id)?.title ?? ''),
      }),
      signal: AbortSignal.timeout(20_000),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ explanation: string }>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(({ explanation }) => setConnection((c) => (same(c) ? { ...c!, explanation, status: 'done' } : c)))
      .catch(() => setConnection((c) => (same(c) ? { ...c!, status: 'error' } : c)));
  }
  useEffect(() => {
    connectRef.current = connect;
  });

  function listenButton(id: string, text: string) {
    if (!voice) return null;
    const on = speaking === id;
    return (
      <button className={on ? 'connect-button listen on' : 'connect-button listen'} onClick={() => listen(id, text)} title="Read aloud with ElevenLabs">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {on ? <path d="M7 6h3v12H7zM14 6h3v12h-3z" /> : <path d="M4 10v4h3l5 4V6L7 10H4zM15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />}
        </svg>
        {on ? 'Stop' : 'Listen'}
      </button>
    );
  }

  // Answers are read without the [id] citation markers.
  const spokenAnswer = (a: Answer) =>
    a.text.replace(/\s*\[(\d+)\]/g, (_, id) => {
      const title = a.sources.find((source) => source.id === Number(id))?.title;
      return title ? ` (${title})` : '';
    });

  // "Hover" readout for the lens: hyperbolic distance from the centre, and how far out it's drawn.
  function lensReadout() {
    const target = hovered ?? selected;
    const distance = target ? universeRef.current?.distanceFromCenter(target.id) : null;
    if (!target || !distance) return 'Hover over a topic to measure how far it is from the centre.';
    const units = distance.hyperbolic < 0.05 ? 'at the centre' : `${distance.hyperbolic.toFixed(1)} units from the centre`;
    return `${target.title}: ${units}, drawn ${Math.round(distance.drawn * 100)}% of the way to the edge.`;
  }

  const path = selected ? pathOf(selected.id, byId).map((id) => byId.get(id)!) : [];
  const breadcrumb = (id: number) =>
    pathOf(id, byId)
      .slice(1, -1)
      .map((step) => byId.get(step)!.title)
      .join(' › ');

  return (
    <main className={['stage', presenting && 'presenting', suggestionsShown && 'suggesting', cardShown && 'reading'].filter(Boolean).join(' ')}>
      <canvas
        ref={canvasRef}
        className="universe"
        aria-label="Interactive map of AI knowledge on a Poincaré disk"
        onPointerDown={() => setResultsOpen(false)}
      />

      {intro && nodes && (
        <Intro
          mode={intro}
          count={nodes.length}
          onUnfold={(progress) => universeRef.current?.setIntro(progress)}
          onDone={() => {
            introRef.current = null;
            setIntro(null);
          }}
        />
      )}

      {!nodes && (
        <div className="loading" role="status">
          {loadError ? 'The universe could not be loaded.' : 'Mapping the universe…'}
        </div>
      )}

      <header className="brand">
        <h1>Hyperspace</h1>
        <p>
          {allNodes
            ? `${allNodes.length.toLocaleString()} AI topics from Wikipedia${grown.length ? ` · ${grown.length} grown by Gemini` : ''}`
            : 'A living map of knowledge'}
        </p>
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
          {QUESTION.test(result.query) && (
            <button className="result ask-row" onMouseDown={(e) => e.preventDefault()} onClick={() => ask(result.query)}>
              <span className="result-title">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
                </svg>
                Ask Gemini
              </span>
              <span className="result-path">Answer “{result.query}” from the map, with sources</span>
            </button>
          )}
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
          className={autoGrow ? 'theme-toggle lens-toggle on' : 'theme-toggle lens-toggle'}
          onClick={() => setAutoGrow((on) => !on)}
          aria-pressed={autoGrow}
          aria-label="Auto-grow at the edges"
          title={autoGrow ? 'Auto-grow is on (A): the map grows as you reach its edges' : 'Auto-grow is off (A)'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21v-8M12 13c0-4 2.5-6.5 7-7 0 4.5-2.5 7-7 7ZM12 15c0-3-2-5-6-5.5 0 3.5 2 5.5 6 5.5Z" />
          </svg>
        </button>
        <button
          className={lens ? 'theme-toggle lens-toggle on' : 'theme-toggle lens-toggle'}
          onClick={() => setLens((on) => !on)}
          aria-pressed={lens}
          aria-label="Geometry lens"
          title="Geometry lens (G): see how hyperbolic distance works"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="6.2" strokeDasharray="2 2.4" />
            <circle cx="12" cy="12" r="3" strokeDasharray="1.6 2" />
          </svg>
        </button>
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

      {lens && !suggestionsShown && (
        <aside className="lens-card" aria-label="Geometry lens" ref={lensRef}>
          <h3>Geometry lens</h3>
          {mode === 'hyperbolic' ? (
            <>
              <p>
                This is a <strong>Poincaré disk</strong>: the whole, infinite hyperbolic plane drawn inside one circle.
              </p>
              <p>
                Each dashed ring is one more unit of hyperbolic distance from the centre. They crowd toward the edge because
                hyperbolic space grows exponentially, which is the room thousands of topics need without clutter.
              </p>
              <p>
                Clicking a topic applies a Möbius transformation, <code>z ↦ (z − a) / (1 − āz)</code>, which slides it to the centre
                without distorting angles. Edges are geodesics: arcs that meet the rim at right angles.
              </p>
              <p className="lens-readout">{lensReadout()}</p>
            </>
          ) : (
            <p>
              In the flat view distances are ordinary, so the deepest topics pile up at the edge with no room to spare.
              Switch to <strong>Hyperbolic</strong> to see the distance rings.
            </p>
          )}
        </aside>
      )}

      {autoGrowing && growing !== null && (
        <div className="grow-pill" role="status">
          <span className="grow-pill-dot" aria-hidden="true" />
          Gemini is growing new territory around <strong>{byId.get(growing)?.title}</strong>
        </div>
      )}

      {connectFrom && (
        <div className="connect-hint" role="status">
          <span>
            Pick another topic to connect with <strong>{connectFrom.title}</strong>: click the map or search
          </span>
          <button onClick={() => setConnectFrom(null)}>Cancel</button>
        </div>
      )}

      {answerShown && (
        <aside className="card answer-card" key={answer.question}>
          <button className="card-close" onClick={closeAnswer} aria-label="Close">
            ×
          </button>
          <p className="card-meta">Asked Gemini</p>
          <h2>{answer.question}</h2>
          <p className={answer.status === 'loading' ? 'card-summary thinking' : 'card-summary'}>
            {answer.status === 'loading'
              ? 'Finding the topics with TiDB, then asking Gemini…'
              : answer.status === 'error'
                ? "Couldn't reach Gemini just now. Try again in a moment."
                : renderAnswer(answer)}
          </p>
          {answer.status === 'done' && voice && <div className="card-actions">{listenButton(`answer-${answer.question}`, spokenAnswer(answer))}</div>}
          {answer.status === 'done' && answer.sources.length > 0 && (
            <div className="sources">
              <p className="grow-note">Sources on the map</p>
              <div className="source-chips">
                {answer.sources.map((source) => (
                  <button key={source.id} onClick={() => byId.get(source.id) && focusNode(byId.get(source.id)!)}>
                    {source.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      )}

      {connectionShown && (
        <aside className="card connection-card" key={`${connection.from.id}-${connection.to.id}`}>
          <button className="card-close" onClick={closeConnection} aria-label="Close">
            ×
          </button>
          <p className="card-meta">How they connect</p>
          <h2>
            {connection.from.title} <span className="connect-arrow">↔</span> {connection.to.title}
          </h2>
          <ol className="route" aria-label="Path on the map">
            {connection.hops.map((id) => (
              <li key={id}>
                <button onClick={() => universeRef.current?.flyTo(id)}>{byId.get(id)?.title}</button>
              </li>
            ))}
          </ol>
          <p className="route-meta">
            {connection.hops.length - 1} {connection.hops.length === 2 ? 'step' : 'steps'} apart on the map
            {connection.distance !== null && ` · ${connection.distance.toFixed(1)} units of hyperbolic distance`}
          </p>
          <p className={connection.status === 'loading' ? 'card-summary thinking' : 'card-summary'}>
            {connection.status === 'loading'
              ? 'Gemini is tracing the link…'
              : connection.status === 'error'
                ? "Couldn't reach Gemini just now. The path above still shows how they're related."
                : connection.explanation}
          </p>
          {connection.status === 'done' && voice && connection.explanation && (
            <div className="card-actions">
              {listenButton(`connection-${connection.from.id}-${connection.to.id}`, connection.explanation)}
            </div>
          )}
          {connection.status === 'done' && <p className="grow-note">Explained by Gemini</p>}
        </aside>
      )}

      {cardShown && (
        <aside className="card" key={selected.id}>
          <button className="card-close" onClick={() => setSelected(null)} aria-label="Close">
            ×
          </button>
          <button
            className={copied === selected.id ? 'card-share copied' : 'card-share'}
            onClick={() => copyLink(selected)}
            aria-label="Copy a link to this topic"
            title={copied === selected.id ? 'Link copied' : 'Copy a link to this topic'}
          >
            {copied === selected.id ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m5 12.5 4.5 4.5L19 7.5" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
              </svg>
            )}
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
          {selected.reason && (
            <p className="card-reason">
              <span>Why Gemini added it</span>
              {selected.reason}
            </p>
          )}
          <div className="card-actions">
            <button
              className={growing === selected.id ? 'grow busy' : 'grow'}
              onClick={() => grow(selected)}
              disabled={growing !== null}
              title="Gemini finds related Wikipedia topics and grows them as new branches"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
              </svg>
              {growing === selected.id ? 'Growing…' : 'Grow with Gemini'}
            </button>
            <button
              className={connectFrom?.id === selected.id ? 'connect-button on' : 'connect-button'}
              onClick={() => setConnectFrom(connectFrom?.id === selected.id ? null : selected)}
              title="Pick another topic to see how the two are connected"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="6" cy="18" r="2.5" />
                <circle cx="18" cy="6" r="2.5" />
                <path d="M8 16.5c3-1 4.5-3.5 5.5-6.5.5-1.5 1.5-2.6 2.6-3.2" />
              </svg>
              Connect
            </button>
            {listenButton(`topic-${selected.id}`, `${selected.title}. ${selected.summary}${selected.reason ? ` Gemini added it here because: ${selected.reason}` : ''}`)}
            <a className="card-link" href={selected.url} target="_blank" rel="noreferrer">
              Read on Wikipedia
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            </a>
          </div>
          {growNote?.id === selected.id && <p className="grow-note">{growNote.text}</p>}
          {voiceError === `topic-${selected.id}` && <p className="grow-note">Couldn't read this aloud just now.</p>}
        </aside>
      )}

      <footer className="dock">
        <p className={explored ? 'hint hidden' : 'hint'}>
          Click a topic to bring it to the centre · Click empty space to zoom in · Drag to explore · The map grows as you reach its edges
        </p>
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
