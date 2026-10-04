import type { RowDataPacket } from "mysql2/promise";
import type { NodeDetailResponse } from "@/types/contracts";
import {
  getTidbPool,
  parseJsonField,
  tidbConfigured,
} from "@/lib/data/tidb";

interface NodeRow extends RowDataPacket {
  id: number;
  title: string;
  summary: string;
  parentId: number | null;
  depth: number;
  url: string;
  type: string;
  path: unknown;
}

/**
 * Same shape as Dilpreet’s pipeline/lib/api.mjs#getNode, without importing
 * pipeline/env.mjs (Turbopack resolves its .env.local URL at build time).
 */
export async function getNodeTidb(
  id: string | number,
): Promise<NodeDetailResponse | null> {
  if (!tidbConfigured()) return null;
  if (!/^\d+$/.test(String(id))) return null;

  const [rows] = await getTidbPool().query<NodeRow[]>(
    "SELECT id, title, summary, parent_id AS parentId, depth, url, type, path FROM nodes WHERE id = ?",
    [Number(id)],
  );
  const row = rows[0];
  if (!row) return null;

  const path = parseJsonField<number[]>(row.path, []);

  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    parentId: row.parentId,
    depth: row.depth,
    url: row.url,
    type: row.type,
    path: Array.isArray(path) ? path.map(Number) : [],
  };
}
