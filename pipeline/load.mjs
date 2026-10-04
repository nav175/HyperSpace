// Step 3: load data/nodes.json into TiDB, the store behind /api/node and /api/search.
//   npm run load              # create the table if needed, then replace every row
//   npm run load -- --reset   # drop and recreate the table first, after a schema change
// Replacing rows clears their embeddings; the embedding step refills them.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { DB_NAME, connect } from './lib/db.mjs';

const { values: opts } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
const readData = (name) => JSON.parse(readFileSync(new URL(`data/${name}`, import.meta.url), 'utf8'));
const nodes = readData('nodes.json');
const { datasetVersion } = readData('nodes.meta.json');

// Paths run from the root down to the node, inclusive. nodes.json lists parents before children.
const paths = new Map();
for (const node of nodes) {
  const parentPath = node.parentId === null ? [] : paths.get(node.parentId);
  if (!parentPath) throw new Error(`${node.title} comes before its parent in nodes.json`);
  paths.set(node.id, [...parentPath, node.id]);
}

console.log(`Loading ${nodes.length} nodes (${datasetVersion}) into ${DB_NAME}.nodes`);
const db = await connect();
try {
  if (opts.reset) await db.query('DROP TABLE IF EXISTS nodes');
  const schema = readFileSync(new URL('schema.sql', import.meta.url), 'utf8').replace(/^\s*--.*$/gm, '');
  for (const statement of schema.split(/;\s*$/m).map((sql) => sql.trim()).filter(Boolean)) {
    await db.query(statement);
  }
  console.log('  ✓ schema ready');

  // One transaction, so the API never sees a half-loaded table.
  await db.beginTransaction();
  await db.query('DELETE FROM nodes');
  for (let i = 0; i < nodes.length; i += 250) {
    const rows = nodes.slice(i, i + 250).map((node) => [
      node.id,
      node.title,
      node.summary,
      node.parentId,
      node.depth,
      node.url,
      node.type,
      JSON.stringify(paths.get(node.id)),
      `${node.title}. ${node.summary}`,
      datasetVersion,
    ]);
    await db.query(
      'INSERT INTO nodes (id, title, summary, parent_id, depth, url, type, path, search_text, dataset_version) VALUES ?',
      [rows]
    );
  }
  await db.commit();
  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM nodes');
  console.log(`  ✓ ${count} rows loaded`);

  // The data /api/node/:id will serve: a node plus its path, resolved here to titles.
  const sample = nodes.find((node) => node.title === 'Vision transformer') ?? nodes.at(-1);
  const [[row]] = await db.query('SELECT id, title, path FROM nodes WHERE id = ?', [sample.id]);
  const path = typeof row.path === 'string' ? JSON.parse(row.path) : row.path;
  const [pathRows] = await db.query('SELECT id, title FROM nodes WHERE id IN (?)', [path]);
  const titleOf = new Map(pathRows.map((pathRow) => [Number(pathRow.id), pathRow.title]));
  console.log(`  ✓ lookup ${row.id}: ${path.map((id) => titleOf.get(id)).join(' › ')}`);

  // Full-text search reads a columnar replica that catches up a few seconds after a write.
  const query = 'vision transformer';
  for (let attempt = 1; attempt <= 10; attempt++) {
    const [hits] = await db.query(
      'SELECT title FROM nodes WHERE fts_match_word(?, search_text) ORDER BY fts_match_word(?, search_text) DESC LIMIT 5',
      [query, query]
    );
    if (hits.length) {
      console.log(`  ✓ full-text "${query}": ${hits.map((hit) => hit.title).join(', ')}`);
      break;
    }
    if (attempt === 10) console.log('  ! full-text search has no results yet; the index may still be catching up. Re-run to check.');
    else await sleep(3000);
  }
} catch (error) {
  await db.rollback().catch(() => {});
  throw error;
} finally {
  await db.end();
}
