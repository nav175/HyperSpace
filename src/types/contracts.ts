/**
 * Shared team contracts — keep in sync with Dilpreet’s pipeline APIs and README.
 *
 * Dilpreet notes (2026-10-04):
 * - Node ids are Wikipedia page ids (numbers), not string slugs.
 * - GET /api/node/:id is implemented in pipeline/lib/api.mjs#getNode
 *   and templated at pipeline/next-routes/api/node/[id]/route.ts
 * - Search embeddings use TiDB free model (1024-d), not Gemini.
 * - Gemini is for Expand only; expansions cache is table `expansions`.
 */

/** category | article from Dilpreet’s ingest; UI may also treat root as category. */
export type NodeType = "category" | "article" | "root" | "concept";

export interface Node {
  id: number;
  title: string;
  summary: string;
  parentId: number | null;
  depth: number;
  url: string;
  type: NodeType | string;
}

export interface SearchMatch {
  id: number;
  title: string;
  score: number;
  path: number[];
}

/** POST /api/search { query } */
export interface SearchResponse {
  matches: SearchMatch[];
  focusNodeId: number;
}

/** POST /api/expand { nodeId } — also Dilpreet’s getCachedExpansion / saveExpansion shape */
export interface ExpandResponse {
  parentId: number;
  children: Node[];
}

/** GET /api/node/:id → Node + path (root → node, inclusive) */
export interface NodeDetailResponse extends Node {
  path: number[];
}

export type RenderMode = "hyperbolic" | "euclid";

/** Imperative API Navjot builds; UI shell calls. */
export interface HypertreeRendererApi {
  loadTree: (nodes: Node[]) => void;
  flyTo: (id: number) => void;
  highlight: (ids: number[]) => void;
  addChildren: (parentId: number, nodes: Node[]) => void;
  setMode: (mode: RenderMode) => void;
  onSelect: (callback: (node: Node) => void) => void;
}
