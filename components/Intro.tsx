'use client';

import { useEffect, useRef } from 'react';

// The opening titles, played when the address has ?intro: a line on black, the count of topics, the
// wordmark, then the universe unfolds behind it and the wordmark flies up into the header as the rest of
// the page lands around it. They wait at a play button first, so a presenter can start them on cue.
// Every frame is a pure function of the time since the start, so ?intro=capture can step through it
// frame by frame (window.hyperspaceIntro.seek) to render a video.

export type IntroMode = 'live' | 'capture';

const LINE = ['Every', 'idea', 'is', 'connected.'];
export const INTRO_DURATION = 9.4; // seconds
// Keys that start it: Space, Enter, and what presentation clickers send for "next".
const START_KEYS = new Set([' ', 'Enter', 'ArrowRight', 'PageDown']);

const segment = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInOut = (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2);

// Page parts that land after the titles, each driven by a CSS variable on <html> (see globals.css).
const PARTS: [variable: string, from: number, to: number][] = [
  ['--intro-sub', 8.0, 8.5],
  ['--intro-search', 8.1, 8.7],
  ['--intro-tools', 8.15, 9.0],
  ['--intro-controls', 8.35, 9.0],
];

declare global {
  interface Window {
    hyperspaceIntro?: { duration: number; ready: boolean; seek: (t: number) => Promise<void> };
  }
}

export default function Intro({
  mode,
  count,
  onUnfold,
  onDone,
}: {
  mode: IntroMode;
  count: number;
  onUnfold: (progress: number | null) => void; // drives Universe.setIntro
  onDone: () => void;
}) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLElement>(null);
  const captionRef = useRef<HTMLSpanElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const shineRef = useRef<HTMLSpanElement>(null);
  const taglineRef = useRef<HTMLParagraphElement>(null);
  const gateRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<() => void>(() => {});
  const props = useRef({ count, onUnfold, onDone });
  useEffect(() => {
    props.current = { count, onUnfold, onDone };
  });

  useEffect(() => {
    const root = document.documentElement;
    const title = document.querySelector<HTMLElement>('.brand h1');
    const mark = markRef.current!;
    // The wordmark is set large, at a whole multiple of the header title, and shrinks into its place,
    // which keeps the type crisp all the way down.
    const titleSize = title ? parseFloat(getComputedStyle(title).fontSize) : 22;
    const titleWidth = title?.getBoundingClientRect().width || 120;
    const scale = Math.max(2, Math.min(4.2, (window.innerWidth * 0.62) / titleWidth));
    mark.style.fontSize = `${titleSize * scale}px`;

    function render(t: number) {
      // 0. The play button steps back as the titles begin.
      const gate = gateRef.current;
      if (gate) {
        const gone = easeOut(segment(t, 0, 0.4));
        gate.style.opacity = String(1 - gone);
        gate.style.transform = `scale(${1 - 0.12 * gone})`;
        gate.style.filter = `blur(${gone * 8}px)`;
        gate.style.visibility = gone >= 1 ? 'hidden' : 'visible';
      }

      // 1. "Every idea is connected." Word by word, out of a blur, then pushed toward you as it goes.
      const lineOut = easeInOut(segment(t, 2.55, 3.0));
      const line = lineRef.current!;
      line.style.opacity = String(1 - lineOut);
      line.style.filter = `blur(${lineOut * 10}px)`;
      line.style.transform = `scale(${1 + lineOut * 0.06})`;
      [...line.children].forEach((word, i) => {
        const e = easeOut(segment(t, 0.45 + i * 0.13, 1.25 + i * 0.13));
        const el = word as HTMLElement;
        el.style.opacity = String(e);
        el.style.filter = `blur(${(1 - e) * 12}px)`;
        el.style.transform = `translateY(${(1 - e) * 0.28}em)`;
      });

      // 2. The number of topics counts up, with what they are underneath.
      const countIn = easeOut(segment(t, 3.0, 3.6));
      const countOut = easeInOut(segment(t, 4.75, 5.2));
      const box = countRef.current!;
      box.style.opacity = String(countIn * (1 - countOut));
      box.style.filter = `blur(${(1 - countIn) * 14 + countOut * 10}px)`;
      box.style.transform = `scale(${0.96 + 0.04 * countIn + countOut * 0.06})`;
      numberRef.current!.textContent = Math.round(props.current.count * easeOutExpo(segment(t, 3.0, 4.5))).toLocaleString();
      const captionIn = easeOut(segment(t, 3.5, 4.1));
      captionRef.current!.style.opacity = String(captionIn);
      captionRef.current!.style.transform = `translateY(${(1 - captionIn) * 8}px)`;

      // 3. The wordmark resolves, tracking in, and a light sweeps across it; a tagline sits beneath.
      const markIn = easeOut(segment(t, 5.2, 6.1));
      const fly = easeInOut(segment(t, 6.8, 8.0));
      mark.style.letterSpacing = `${-0.02 + (1 - markIn) * 0.14}em`;
      mark.style.opacity = String(markIn);
      mark.style.filter = `blur(${(1 - markIn) * 16}px)`;
      shineRef.current!.style.backgroundPosition = `${103 - 106 * easeInOut(segment(t, 5.6, 6.9))}% 0, 0 0`;
      shineRef.current!.style.opacity = String(1 - easeOut(segment(t, 7.3, 8.3))); // colour gives way to the header's ink

      // 4. It flies up into the header: from the middle of the screen, at full size, to the title's
      // exact place and size.
      const w = mark.offsetWidth;
      const h = mark.offsetHeight;
      const rest = 1 + (1 - markIn) * 0.06;
      const fromX = (window.innerWidth - w * rest) / 2;
      const fromY = window.innerHeight / 2 - h * rest * 0.62;
      const target = title?.getBoundingClientRect();
      const toX = target?.left ?? 32;
      const toY = target?.top ?? 28;
      const k = rest + (1 / scale - rest) * fly;
      mark.style.transform = `translate(${fromX + (toX - fromX) * fly}px, ${fromY + (toY - fromY) * fly}px) scale(${k})`;

      const tagIn = easeOut(segment(t, 5.85, 6.5));
      const tagOut = easeInOut(segment(t, 6.7, 7.05));
      const tagline = taglineRef.current!;
      tagline.style.top = `${fromY + h * rest + Math.max(14, h * 0.12)}px`;
      tagline.style.opacity = String(tagIn * (1 - tagOut));
      tagline.style.transform = `translateY(${(1 - tagIn) * 10 - tagOut * 6}px)`;
      tagline.style.filter = `blur(${tagOut * 6}px)`;

      // The black lifts as the universe unfolds behind the wordmark, then the page lands around it.
      root.style.setProperty('--intro-cover', String(1 - easeInOut(segment(t, 6.9, 7.9))));
      for (const [variable, from, to] of PARTS) root.style.setProperty(variable, String(easeOut(segment(t, from, to))));
      props.current.onUnfold(t >= 6.8 ? segment(t, 6.8, 9.1) : 0);
    }

    function cleanUp() {
      for (const variable of ['--intro-cover', ...PARTS.map(([v]) => v)]) root.style.removeProperty(variable);
      delete root.dataset.intro;
    }

    if (mode === 'capture') {
      // A renderer steps through the frames: seek(t), wait for the paint, take a screenshot.
      window.hyperspaceIntro = {
        duration: INTRO_DURATION,
        ready: true,
        seek: (t) =>
          new Promise((resolve) => {
            render(t);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      };
      render(0);
      return () => {
        delete window.hyperspaceIntro;
      };
    }

    // Live: in real time, once started at the play button. Escape lands on the page at any point.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cleanUp();
      props.current.onUnfold(null);
      props.current.onDone();
      return;
    }
    let raf = 0;
    let start = -1; // when it was started; -1 while it waits at the play button
    let finished = false;
    const stop = () => {
      finished = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
    };
    const finish = () => {
      if (finished) return;
      stop();
      cleanUp();
      props.current.onUnfold(null);
      props.current.onDone();
    };
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      if (t >= INTRO_DURATION) return finish();
      render(t);
      raf = requestAnimationFrame(tick);
    };
    playRef.current = () => {
      if (start >= 0 || finished) return;
      start = performance.now();
      raf = requestAnimationFrame(tick);
    };
    // While the titles are up, keys belong to them rather than the page underneath, as the pointer
    // does (the overlay covers the page). Browser shortcuts pass through.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') finish();
      else if (START_KEYS.has(e.key)) playRef.current();
    };
    render(0);
    window.addEventListener('keydown', onKey, true);
    // Unmounting only stops the clock; the page is handed back by finish(), not by a remount.
    return stop;
  }, [mode]);

  return (
    <div className="intro">
      {mode === 'live' && (
        <div className="intro-gate" ref={gateRef}>
          <button className="intro-play" onClick={() => playRef.current()} aria-label="Play the intro">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.24-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z" />
            </svg>
          </button>
          <p>
            Press <kbd>space</kbd> to play
          </p>
        </div>
      )}
      <p className="intro-line" ref={lineRef} aria-hidden="true">
        {LINE.map((word, i) => (
          <span key={i} className={i === LINE.length - 1 ? 'intro-accent' : undefined}>
            {word}
          </span>
        ))}
      </p>
      <div className="intro-count" ref={countRef} aria-hidden="true">
        <strong ref={numberRef}>0</strong>
        <span ref={captionRef}>topics in artificial intelligence, mapped from Wikipedia.</span>
      </div>
      <div className="intro-wordmark" ref={markRef} aria-hidden="true">
        <span>Hyperspace</span>
        <span className="intro-shine" ref={shineRef}>
          Hyperspace
        </span>
      </div>
      <p className="intro-tagline" ref={taglineRef} aria-hidden="true">
        Knowledge, in hyperbolic space.
      </p>
    </div>
  );
}
