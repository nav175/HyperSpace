import type { RowDataPacket } from "mysql2/promise";
import type { SearchMatch, SearchResponse } from "@/types/contracts";
import {
  getTidbPool,
  parseJsonField,
  tidbConfigured,
} from "@/lib/data/tidb";

const EMBED_MODEL = "tidbcloud_free/amazon/titan-embed-text-v2";

interface HitRow extends RowDataPacket {
  id: number;
  title: string;
  path: unknown;
  score?: number;
  dist?: number;
}

/**
 * Hybrid TiDB search: full-text + vector (TiDB free embed model).
 * Returns null when TiDB is unconfigured or both legs fail.
 */
export async function searchTidb(query: string): Promise<SearchResponse | null> {
  if (!tidbConfigured()) return null;
  const q = query.trim();
  if (!q) return null;

  const db = getTidbPool();
  const byId = new Map<number, SearchMatch>();

  try {
    const [fts] = await db.query<HitRow[]>(
      `SELECT id, title, path, fts_match_word(?, search_text) AS score
       FROM nodes
       WHERE fts_match_word(?, search_text)
       ORDER BY score DESC
       LIMIT 12`,
      [q, q],
    );
    fts.forEach((row, i) => {
      const path = parseJsonField<number[]>(row.path, []).map(Number);
      const score = Number(row.score) || 1 / (i + 1);
      byId.set(row.id, {
        id: row.id,
        title: row.title,
        score: Math.min(1, 0.55 + score * 0.45),
        path,
      });
    });
  } catch {
    // FTS unavailable — continue with vector
  }

  try {
    const [[{ vector }]] = await db.query<RowDataPacket[]>(
      "SELECT CAST(EMBED_TEXT(?, ?) AS CHAR) AS vector",
      [EMBED_MODEL, q],
    );
    if (typeof vector === "string" && vector.length > 2) {
      const [hits] = await db.query<HitRow[]>(
        `SELECT id, title, path, VEC_COSINE_DISTANCE(embedding, ?) AS dist
         FROM nodes
         WHERE embedding IS NOT NULL
         ORDER BY dist
         LIMIT 12`,
        [vector],
      );
      hits.forEach((row, i) => {
        const path = parseJsonField<number[]>(row.path, []).map(Number);
        const dist = Number(row.dist);
        const vecScore =
          Number.isFinite(dist) ? Math.max(0, 1 - dist) : 1 / (i + 1);
        const prev = byId.get(row.id);
        if (prev) {
          prev.score = Math.min(1, prev.score * 0.45 + vecScore * 0.55 + 0.15);
        } else {
          byId.set(row.id, {
            id: row.id,
            title: row.title,
            score: vecScore * 0.9,
            path,
          });
        }
      });
    }
  } catch {
    // Vector / embed unavailable
  }

  if (!byId.size) return null;

  const qLower = q.toLowerCase();
  for (const m of byId.values()) {
    const title = m.title.toLowerCase();
    if (title === qLower) m.score = 1;
    else if (title.startsWith(qLower)) m.score = Math.max(m.score, 0.96);
    else if (title.includes(qLower)) m.score = Math.max(m.score, 0.88);
  }

  const matches = [...byId.values()]
    .sort(
      (a, b) =>
        b.score - a.score || a.title.length - b.title.length,
    )
    .slice(0, 12);

  // Prefer an exact title match as the fly target when present
  const exact = matches.find((m) => m.title.toLowerCase() === qLower);

  return {
    matches,
    focusNodeId: exact?.id ?? matches[0]!.id,
  };
}
