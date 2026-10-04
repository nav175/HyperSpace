// What the API serves, as plain async functions any server can call: the Next.js route handlers in
// app/api, or `npm run api` for local testing. Shapes follow the README contract.
import { pool } from './db.mjs';
import { embedQuery } from './embedding.mjs';

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const CANDIDATES = 20; // per method, before fusion

// POST /api/search {query} → { matches: [{ id, title, score, path }], focusNodeId }.
// Hybrid search: TiDB embeds the query and finds the nearest meanings, and full-text search finds the
// words. Every candidate from either half is then scored by meaning (cosine similarity), plus a small
// full-text bonus and a bonus when the title itself matches. Meaning leads because full-text alone
// rewards filler: in "robots that look like people", "look" and "people" match plenty of pages.
// An even blend (reciprocal rank fusion) let those win, and ranked "Computer vision software" above
// "Computer vision". Scores are relative to the best match (1).
const KEYWORD_WEIGHT = 0.12; // × the BM25 score relative to the best keyword hit
const TITLE_BONUS = { exact: 0.35, prefix: 0.12, allWords: 0.08 };
const QUESTION_WORDS = new Set(
  'a an and are as at be by can do does for from how i in into is it its of on or that the their them they this to use uses using what when where which who why with ai'.split(' ')
);

export async function searchNodes(query, { limit = 8 } = {}) {
  const text = String(query ?? '').trim().slice(0, 300);
  if (!text) return { matches: [], focusNodeId: null };
  const db = pool();

  // The two halves are independent, so they run side by side.
  const [vector, [keyword]] = await Promise.all([
    embedQuery(db, text),
    db
      .query(
        `SELECT id, title, path, fts_match_word(?, search_text) AS bm25 FROM nodes
         WHERE fts_match_word(?, search_text) ORDER BY bm25 DESC LIMIT ${CANDIDATES}`,
        [text, text]
      )
      // Full-text search is the extra half of hybrid; meaning-based results stand on their own.
      .catch(() => [[]]),
  ]);
  const [[semantic], [keywordMeaning]] = await Promise.all([
    db.query(
      `SELECT id, title, path, VEC_COSINE_DISTANCE(embedding, ?) AS distance FROM nodes WHERE embedding IS NOT NULL
       ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT ${CANDIDATES}`,
      [vector, vector]
    ),
    // How close in meaning the keyword hits are, so both halves are scored the same way.
    keyword.length
      ? db.query('SELECT id, title, path, VEC_COSINE_DISTANCE(embedding, ?) AS distance FROM nodes WHERE id IN (?)', [
          vector,
          keyword.map((row) => row.id),
        ])
      : [[]],
  ]);

  const candidates = new Map();
  for (const row of [...semantic, ...keywordMeaning]) {
    if (!candidates.has(row.id)) {
      candidates.set(row.id, { id: row.id, title: row.title, path: parseJson(row.path), similarity: 1 - Number(row.distance), bm25: 0 });
    }
  }
  const bestBm25 = Math.max(0, ...keyword.map((row) => Number(row.bm25) || 0));
  for (const row of keyword) {
    const candidate = candidates.get(row.id);
    if (candidate) candidate.bm25 = bestBm25 ? (Number(row.bm25) || 0) / bestBm25 : 0;
  }

  const q = normalizeTitle(text);
  const words = q.split(' ').filter((word) => word && !QUESTION_WORDS.has(word));
  const titleBonus = (title) => {
    const t = normalizeTitle(title);
    if (t === q || t === `${q}s` || `${t}s` === q) return TITLE_BONUS.exact;
    if (t.startsWith(q)) return TITLE_BONUS.prefix;
    return words.length && words.every((word) => t.includes(word)) ? TITLE_BONUS.allWords : 0;
  };

  const ranked = [...candidates.values()]
    .map((c) => ({ id: c.id, title: c.title, path: c.path, score: c.similarity + KEYWORD_WEIGHT * c.bm25 + titleBonus(c.title) }))
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
    .slice(0, limit);
  const best = ranked[0]?.score || 1;
  const matches = ranked.map((match) => ({ ...match, score: Number(Math.max(0, match.score / best).toFixed(3)) }));
  return { matches, focusNodeId: matches[0]?.id ?? null };
}

// "Self-driving cars" and "self driving cars" are the same title.
function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[-_–]+/g, ' ').replace(/\s+/g, ' ').trim();
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
