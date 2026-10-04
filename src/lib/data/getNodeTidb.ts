import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { NodeDetailResponse } from "@/types/contracts";

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

let pool: Pool | null = null;

function tidbConfigured(): boolean {
  return Boolean(
    process.env.TIDB_HOST?.trim() &&
      process.env.TIDB_USER?.trim() &&
      process.env.TIDB_PASSWORD?.trim(),
  );
}

function getPool(): Pool {
  if (pool) return pool;
  const database = process.env.TIDB_DATABASE?.trim() || "hyperspace";
  pool = mysql.createPool({
    host: process.env.TIDB_HOST!.trim(),
    port: Number(process.env.TIDB_PORT || 4000),
    user: process.env.TIDB_USER!.trim(),
    password: process.env.TIDB_PASSWORD!.trim(),
    database,
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionLimit: 5,
  });
  return pool;
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

  const [rows] = await getPool().query<NodeRow[]>(
    "SELECT id, title, summary, parent_id AS parentId, depth, url, type, path FROM nodes WHERE id = ?",
    [Number(id)],
  );
  const row = rows[0];
  if (!row) return null;

  const path =
    typeof row.path === "string" ? JSON.parse(row.path) : (row.path ?? []);

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
