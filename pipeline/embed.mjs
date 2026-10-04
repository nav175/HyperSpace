// Step 4: embed every node with Gemini and store the vectors in TiDB (nodes.embedding).
//   npm run embed               # embeds the rows whose embedding is still empty
//   npm run embed -- --all      # re-embeds every row, e.g. after changing the text template
//   npm run embed -- --limit 20 # a quick trial on a few rows
// Vectors are cached on disk by model, size and text, so re-embedding after `npm run load`
// (which clears the column) costs no Gemini calls. Progress is saved after every batch.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, toVector } from './lib/db.mjs';
import { EMBED_DIM, EMBED_MODEL, asDocument, asQuery, embedBatch } from './lib/gemini.mjs';

const { values: opts } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    limit: { type: 'string' },
    batch: { type: 'string', default: '100' },
  },
});
const BATCH = Number(opts.batch);
const CACHE_FILE = fileURLToPath(new URL('.cache/embeddings.jsonl', import.meta.url));

const db = await connect();
try {
  const [rows] = await db.query(
    `SELECT id, title, summary, path FROM nodes ${opts.all ? '' : 'WHERE embedding IS NULL'} ORDER BY depth, id ${opts.limit ? 'LIMIT ?' : ''}`,
    opts.limit ? [Number(opts.limit)] : []
  );
  const [titles] = await db.query('SELECT id, title FROM nodes');
  const titleOf = new Map(titles.map((row) => [Number(row.id), row.title]));
  const cache = readCache();

  const items = rows.map((row) => {
    const text = documentText(row, titleOf);
    return { id: row.id, text, key: createHash('sha1').update(`${EMBED_MODEL}|${EMBED_DIM}|${text}`).digest('hex') };
  });
  const toFetch = items.filter((item) => !cache.has(item.key)).length;
  console.log(`Embedding ${items.length} nodes with ${EMBED_MODEL} (${EMBED_DIM} dims): ${items.length - toFetch} cached, ${toFetch} to fetch`);

  let done = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const missing = batch.filter((item) => !cache.has(item.key));
    if (missing.length) {
      const vectors = await embedWithRetry(missing.map((item) => item.text));
      missing.forEach((item, j) => {
        cache.set(item.key, vectors[j]);
        appendFileSync(CACHE_FILE, `${JSON.stringify({ key: item.key, values: vectors[j] })}\n`);
      });
    }
    await store(batch.map((item) => ({ id: item.id, vector: cache.get(item.key) })));
    done += batch.length;
    console.log(`  ${done} / ${items.length}`);
  }

  const [[{ embedded, total }]] = await db.query('SELECT COUNT(embedding) AS embedded, COUNT(*) AS total FROM nodes');
  console.log(`\n✓ ${embedded} of ${total} nodes have embeddings`);

  // Real searches through TiDB, the same way /api/search will run them.
  for (const query of ['AI that understands images', 'How do transformers relate to humanoid robots?']) {
    const [vector] = await embedBatch([asQuery(query)]);
    const [hits] = await db.query(
      `SELECT title, 1 - VEC_COSINE_DISTANCE(embedding, ?) AS score FROM nodes
       WHERE embedding IS NOT NULL ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT 6`,
      [toVector(vector), toVector(vector)]
    );
    console.log(`\n"${query}"`);
    for (const hit of hits) console.log(`  ${Number(hit.score).toFixed(3)}  ${hit.title}`);
  }
} finally {
  await db.end();
}

// The breadcrumb gives short or ambiguous titles ("Agent", "Attention") their context.
function documentText(row, titleOf) {
  const path = typeof row.path === 'string' ? JSON.parse(row.path) : row.path;
  const breadcrumb = path
    .slice(1, -1)
    .map((id) => titleOf.get(id))
    .join(' > ');
  return asDocument(row.title, breadcrumb ? `${breadcrumb}. ${row.summary}` : row.summary);
}

// One UPDATE per batch instead of one round trip per row.
async function store(batch) {
  const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
  const params = batch.flatMap(({ id, vector }) => [id, toVector(vector)]);
  await db.query(`UPDATE nodes SET embedding = CASE id ${cases} END WHERE id IN (?)`, [
    ...params,
    batch.map(({ id }) => id),
  ]);
}

async function embedWithRetry(texts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await embedBatch(texts, { timeoutMs: 60_000 });
    } catch (error) {
      const retryable = error.status === 429 || error.status >= 500 || error.name === 'TimeoutError';
      if (!retryable || attempt === 8) throw error;
      const violations = (error.details ?? []).flatMap((detail) => detail.violations ?? []);
      if (violations.some((violation) => /PerDay/i.test(violation.quotaId ?? ''))) {
        throw new Error(
          "Gemini's free daily embedding quota is used up (it resets at midnight Pacific). Progress so far is " +
            'saved: re-run after the reset, or enable billing on the project for higher limits.'
        );
      }
      const retryDelay = (error.details ?? []).find((detail) => detail.retryDelay)?.retryDelay; // e.g. "29s"
      const waitMs = retryDelay ? parseFloat(retryDelay) * 1000 + 1000 : Math.min(60_000, 2000 * 2 ** attempt);
      const limit = violations[0] ? ` on ${violations[0].quotaId}${violations[0].quotaValue ? ` (limit ${violations[0].quotaValue})` : ''}` : '';
      console.log(`  Gemini ${error.status ?? 'timeout'}${limit}, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

function readCache() {
  const cache = new Map();
  if (!existsSync(CACHE_FILE)) return cache;
  for (const line of readFileSync(CACHE_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    const { key, values } = JSON.parse(line);
    cache.set(key, values);
  }
  return cache;
}
