// What the API serves, as plain async functions any server can call: the Next.js route handlers in
// app/api, or `npm run api` for local testing. Shapes follow the README contract.
import { pool } from './db.mjs';
import { embedQuery } from './embedding.mjs';

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const CANDIDATES = 20; // per method, before fusion

// POST /api/search {query} → { matches: [{ id, title, score, path }], focusNodeId }.
// Hybrid search: TiDB embeds the query and finds the nearest meanings, full-text search finds the
// words, and reciprocal rank fusion merges the two lists. Scores are relative to the best match (1).
export async function searchNodes(query, { limit = 8 } = {}) {
  const text = String(query ?? '').trim().slice(0, 300);
  if (!text) return { matches: [], focusNodeId: null };
  const db = pool();

  // The two halves are independent, so they run side by side.
  const semanticSearch = embedQuery(db, text).then((vector) =>
    db.query(
      `SELECT id, title, path FROM nodes WHERE embedding IS NOT NULL
       ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT ${CANDIDATES}`,
      [vector]
    )
  );
  const keywordSearch = db
    .query(
      `SELECT id, title, path FROM nodes WHERE fts_match_word(?, search_text)
       ORDER BY fts_match_word(?, search_text) DESC LIMIT ${CANDIDATES}`,
      [text, text]
    )
    // Full-text search is the extra half of hybrid; meaning-based results stand on their own.
    .catch(() => [[]]);
  const [[semantic], [keyword]] = await Promise.all([semanticSearch, keywordSearch]);

  const fused = new Map();
  for (const rows of [semantic, keyword]) {
    rows.forEach((row, rank) => {
      const match = fused.get(row.id) ?? { id: row.id, title: row.title, score: 0, path: parseJson(row.path) };
      match.score += 1 / (60 + rank + 1);
      fused.set(row.id, match);
    });
  }
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const best = ranked[0]?.score || 1;
  const matches = ranked.map((match) => ({ ...match, score: Number((match.score / best).toFixed(3)) }));
  return { matches, focusNodeId: matches[0]?.id ?? null };
}

// GET /api/node/:id → Node + path: [ids], or null when there is no such node.
export async function getNode(id) {
  if (!/^\d+$/.test(String(id))) return null; // ids are Wikipedia page ids
  const [[row]] = await pool().query(
    'SELECT id, title, summary, parent_id AS parentId, depth, url, type, path FROM nodes WHERE id = ?',
    [Number(id)]
  );
  return row ? { ...row, path: parseJson(row.path) } : null;
}

// Expand cache, for POST /api/expand {nodeId} → { parentId, children: [Node] }. A repeat Expand,
// or demo mode, answers from here without calling Gemini. Entries belong to one dataset version,
// so re-ingesting Wikipedia never serves children for a tree that has changed.
export async function getCachedExpansion(nodeId) {
  const [[row]] = await pool().query('SELECT children FROM expansions WHERE node_id = ? AND dataset_version = ?', [
    Number(nodeId),
    await datasetVersion(),
  ]);
  return row ? { parentId: Number(nodeId), children: parseJson(row.children) } : null;
}

export async function saveExpansion(nodeId, children, model) {
  await pool().query('REPLACE INTO expansions (node_id, dataset_version, children, model) VALUES (?, ?, ?, ?)', [
    Number(nodeId),
    await datasetVersion(),
    JSON.stringify(children),
    model,
  ]);
}

let loadedVersion;
export async function datasetVersion() {
  loadedVersion ??= (await pool().query('SELECT dataset_version FROM nodes LIMIT 1'))[0][0]?.dataset_version;
  return loadedVersion;
}
