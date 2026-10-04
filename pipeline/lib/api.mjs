// What the API serves, as plain async functions any server can call: Karn's Next.js route
// handlers (see next-routes/), or `npm run api` for local testing. Shapes follow the README contract.
import { pool } from './db.mjs';

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

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
async function datasetVersion() {
  loadedVersion ??= (await pool().query('SELECT dataset_version FROM nodes LIMIT 1'))[0][0]?.dataset_version;
  return loadedVersion;
}
