/** Load the prebuilt UMD bundle (embeds ducd — the npm `ducd` package ships without dist/). */

export type HytApi = {
  Hypertree: new (
    view: { parent: HTMLElement },
    args: Record<string, unknown>,
  ) => HypertreeInstance;
  loaders: Record<string, unknown>;
  layouts: Record<string, unknown>;
};

export type HypertreeNode = {
  data: {
    id: number;
    title: string;
    summary: string;
    parentId: number | null;
    depth: number;
    url: string;
    type: string;
  };
  parent: HypertreeNode | null;
  children?: HypertreeNode[];
  depth: number;
  ancestors: () => HypertreeNode[];
  each: (fn: (n: HypertreeNode) => void) => void;
  /** Hyperbolic layout (z = position in the Poincaré model). Null until laid out. */
  layout: {
    z: { re: number; im: number };
    wedge?: unknown;
  } | null;
  layoutReference?: unknown;
  precalc: {
    label?: string;
    clickable?: boolean;
    cullingWeight?: number;
    weight?: number;
  };
  pathes?: Record<string, unknown>;
  globelhtid?: number;
  /** Transformed (on-screen) position in unit-disk coords — set by the unitdisk cache pass. */
  cache?: { re: number; im: number };
  /** Polar form of `cache`. */
  cachep?: { r: number; θ: number };
  dampedDistScale?: number;
  distScale?: number;
  height: number;
  mergeId?: number;
};

export type HypertreeInstance = {
  data: HypertreeNode;
  initPromise: Promise<void>;
  api: {
    gotoNode: (n: HypertreeNode) => Promise<unknown>;
    gotoHome: () => Promise<unknown>;
    toggleSelection: (n: HypertreeNode) => void;
    setPathHead: (path: unknown, n: HypertreeNode | undefined) => void;
    setDataloader: (
      ok: () => void,
      err: (e: unknown) => void,
      dl: (
        ok: (root: unknown, t0?: number, dl?: number) => void,
        err: (e: unknown) => void,
      ) => void,
    ) => void;
    selectQuery: (query: string, prop: string | undefined) => void;
  };
  args: {
    objects: { selections: HypertreeNode[]; pathes: unknown[] };
    interaction: Record<string, unknown>;
    geometry?: {
      transformation?: {
        state?: { P?: { re: number; im: number }; λ?: number };
        cache?: { N?: number };
      };
    };
    layout?: {
      type?: (n: HypertreeNode, λ: number, noRecurse?: boolean) => void;
    };
    dataInitBFS?: (ht: HypertreeInstance, n: HypertreeNode) => void;
    langInitBFS?: (ht: HypertreeInstance, n: HypertreeNode) => void;
  };
  /** Private-ish internals used by in-place grafting (see graftNodes). */
  updateWeights_?: () => void;
  updateLabelLen_?: () => void;
  update: {
    data: () => void;
    pathes: () => void;
    transformation: () => void;
  };
  drawDetailFrame: () => void;
  isAnimationRunning?: () => boolean;
  transition?: unknown;
  unitdisk?: {
    cache?: {
      unculledNodes?: HypertreeNode[];
      labels?: HypertreeNode[];
      centerNode?: HypertreeNode;
    };
  };
};

declare global {
  interface Window {
    hyt?: HytApi;
  }
}

let loading: Promise<HytApi> | null = null;

export function loadHyt(): Promise<HytApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("d3-hypertree requires window"));
  }
  if (window.hyt?.Hypertree) return Promise.resolve(window.hyt);
  if (loading) return loading;

  loading = new Promise<HytApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-hyt="1"]',
    );
    if (existing && window.hyt?.Hypertree) {
      resolve(window.hyt);
      return;
    }

    if (!document.querySelector('link[data-hyt-css="1"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/vendor/d3-hypertree/d3-hypertree-dark.css";
      link.dataset.hytCss = "1";
      document.head.appendChild(link);
    }

    const script = document.createElement("script");
    script.src = "/vendor/d3-hypertree/d3-hypertree.min.js";
    script.async = true;
    script.dataset.hyt = "1";
    script.onload = () => {
      if (!window.hyt?.Hypertree) {
        reject(new Error("d3-hypertree UMD loaded but window.hyt missing"));
        return;
      }
      resolve(window.hyt);
    };
    script.onerror = () =>
      reject(new Error("Failed to load /vendor/d3-hypertree/d3-hypertree.min.js"));
    document.head.appendChild(script);
  }).finally(() => {
    loading = null;
  });

  return loading;
}
