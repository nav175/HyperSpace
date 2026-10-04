// Step 4: embed every node inside TiDB with its free hosted model: no API key, no daily cap.
//   npm run embed               # fills every empty embedding; safe to stop and re-run
//   npm run embed -- --all      # recomputes all of them
// load.mjs stores the text to embed in embed_text; TiDB turns it into vectors with EMBED_TEXT.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { connect } from './lib/db.mjs';
import { EMBED_MODEL, embedQuery } from './lib/embedding.mjs';

const { values: opts } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    workers: { type: 'string', default: '4' },
  },
});
const WORKERS = Number(opts.workers);
const BATCH = 25;

let db = await connect();
try {
  if (opts.all) await db.query('UPDATE nodes SET embedding = NULL');
  const [[{ pending, total }]] = await db.query('SELECT COUNT(*) - COUNT(embedding) AS pending, COUNT(*) AS total FROM nodes');
  console.log(`Embedding ${pending} of ${total} nodes with ${EMBED_MODEL}, ${WORKERS} batches at a time`);

  let done = 0;
  const started = Date.now();
  // Each worker owns the ids with one remainder, so concurrent UPDATEs never touch the same rows.
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, worker) => {
      const conn = await connect();
      try {
        for (;;) {
          const [result] = await withRetry(() =>
            conn.query(
              `UPDATE nodes SET embedding = EMBED_TEXT(?, embed_text)
               WHERE embedding IS NULL AND MOD(id, ?) = ? ORDER BY depth, id LIMIT ?`,
              [EMBED_MODEL, WORKERS, worker, BATCH]
            )
          );
          if (!result.affectedRows) break;
          const before = done;
          done += result.affectedRows;
          if (Math.floor(done / 250) > Math.floor(before / 250) || done === Number(pending)) {
            console.log(`  ${done} / ${pending}  (${Math.round((Date.now() - started) / 1000)}s)`);
          }
        }
      } finally {
        await conn.end();
      }
    })
  );

  // TiDB drops connections left idle for about five minutes, and this one sat out the whole run.
  await db.end().catch(() => {});
  db = await connect();
  const [[{ embedded }]] = await db.query('SELECT COUNT(embedding) AS embedded FROM nodes');
  console.log(`\n✓ ${embedded} of ${total} nodes have embeddings`);

  // Real searches, the way /api/search will run them: TiDB embeds the query with the same model.
  const [titles] = await db.query('SELECT id, title FROM nodes');
  const titleOf = new Map(titles.map((row) => [Number(row.id), row.title]));
  for (const query of ['AI that understands images', 'How do transformers relate to humanoid robots?']) {
    const vector = await embedQuery(db, query);
    const [hits] = await db.query(
      `SELECT title, path, 1 - VEC_COSINE_DISTANCE(embedding, ?) AS score FROM nodes
       WHERE embedding IS NOT NULL ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT 6`,
      [vector, vector]
    );
    console.log(`\n"${query}"`);
    for (const hit of hits) {
      const path = typeof hit.path === 'string' ? JSON.parse(hit.path) : hit.path;
      console.log(`  ${Number(hit.score).toFixed(3)}  ${hit.title.padEnd(36)} ${path.slice(1, -1).map((id) => titleOf.get(id)).join(' › ')}`);
    }
  }
} finally {
  await db.end();
}

async function withRetry(run) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt === 5) throw error;
      console.log(`  retrying in ${2 ** attempt * 2}s: ${error.message.slice(0, 150)}`);
      await sleep(2 ** attempt * 2000);
    }
  }
}
