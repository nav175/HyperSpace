// Setup check. Run it after filling in .env.local:
//   cd pipeline && npm install && npm run check
// Tests the TiDB connection, vector and full-text support, TiDB's free embedding model and
// the Gemini key, then runs one real semantic search. Spends no Gemini quota. Safe to re-run:
// it creates the database if it's missing and drops the scratch tables it makes.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DB_NAME, connect } from './lib/db.mjs';
import { EMBED_DIM, EMBED_MODEL, embedQuery } from './lib/embedding.mjs';
import { ENV_FILE, missingEnv } from './lib/env.mjs';
import { checkGeminiKey } from './lib/gemini.mjs';

const REGION_FIX =
  'Full-text search only runs on Starter in AWS Oregon (us-west-2), N. Virginia, Tokyo, Frankfurt or Singapore. ' +
  'Recreate the cluster in us-west-2 now, or plan on vector-only search.';
const SCRATCH_TABLES = ['_check_vec', '_check_fts', '_check_search'];

const problems = [];
const ok = (label, detail) => console.log(`  ✓ ${label}${detail ? `: ${detail}` : ''}`);
const note = (label, detail) => console.log(`  ! ${label}: ${detail}`);
const bad = (label, detail, fix) => {
  problems.push(label);
  console.log(`  ✗ ${label}: ${detail}`);
  if (fix) console.log(`    → ${fix}`);
};

console.log('\n1. Environment');
if (!existsSync(ENV_FILE)) bad('.env.local', 'not found', 'From the repo root: cp .env.example .env.local, then fill it in');
const tidbMissing = missingEnv('TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD');
const geminiMissing = missingEnv('GEMINI_API_KEY');
if (tidbMissing.length) bad('TiDB settings', `missing ${tidbMissing.join(', ')}`, 'TiDB Cloud → your cluster → Connect');
else ok('TiDB settings');
if (geminiMissing.length) bad('Gemini key', 'missing GEMINI_API_KEY', 'https://aistudio.google.com/apikey');
else ok('Gemini key');

console.log('\n2. TiDB');
let db;
if (tidbMissing.length) {
  console.log('  (skipped)');
} else {
  try {
    const server = await connect({ useDatabase: false });
    try {
      const [[{ version }]] = await server.query('SELECT VERSION() AS version');
      await server.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
      ok('Connected', version);
    } finally {
      await server.end();
    }
    db = await connect();
    ok(`Database "${DB_NAME}" ready`);
  } catch (error) {
    bad('Connection', error.message, 'Re-copy host, user and password from TiDB Cloud → Connect (Generate Password makes a new one)');
  }
}

if (db) {
  await dropScratchTables();

  try {
    const warnings = await createTable(
      'CREATE TABLE _check_vec (id INT PRIMARY KEY, v VECTOR(3), VECTOR INDEX idx_v ((VEC_COSINE_DISTANCE(v))))'
    );
    if (warnings) note('Vector index', `created with warnings: ${warnings}`);
    else ok('Vector column + vector index');
  } catch (error) {
    try {
      await createTable('CREATE TABLE _check_vec (id INT PRIMARY KEY, v VECTOR(3))');
      note('Vector index unavailable', `${error.message}. Exact vector search still works and is fast at 3,000 nodes.`);
    } catch (inner) {
      bad('Vector column', inner.message, 'This cluster has no vector search. Use a TiDB Cloud Starter cluster.');
    }
  }

  try {
    const warnings = await createTable(
      'CREATE TABLE _check_fts (id INT PRIMARY KEY, body TEXT, FULLTEXT INDEX (body) WITH PARSER MULTILINGUAL)'
    );
    if (warnings) {
      bad('Full-text index', `TiDB ignored it: ${warnings}`, REGION_FIX);
    } else {
      const queryError = await fullTextQueryError();
      if (queryError) note('Full-text index', `created, but queries aren't answering yet (${queryError}). Re-run in a minute.`);
      else ok('Full-text index + query (needed for hybrid search)');
    }
  } catch (error) {
    bad('Full-text index', error.message, REGION_FIX);
  }

  try {
    const [[{ dims }]] = await db.query('SELECT VEC_DIMS(EMBED_TEXT(?, ?)) AS dims', [EMBED_MODEL, 'hello']);
    if (dims === EMBED_DIM) ok(`Embeddings from ${EMBED_MODEL}`, `${dims} dimensions`);
    else bad('Embeddings', `expected ${EMBED_DIM} dimensions, got ${dims}`);
  } catch (error) {
    bad('Embeddings', error.message, 'TiDB auto embedding needs a TiDB Cloud Starter cluster on AWS');
  }
}

console.log('\n3. Gemini (used by Expand)');
if (geminiMissing.length) {
  console.log('  (skipped)');
} else {
  try {
    await checkGeminiKey();
    ok('Key works');
  } catch (error) {
    bad('Gemini key', error.cause?.message || error.message, 'Check the key at https://aistudio.google.com/apikey');
  }
}

console.log('\n4. Semantic search, end to end');
const docs = [
  ['Computer vision', 'Computer vision is the field of AI that lets computers interpret and understand images and video.'],
  ['Natural language processing', 'Natural language processing studies how computers understand and generate human language.'],
  ['Reinforcement learning', 'Reinforcement learning trains agents to make decisions by rewarding good actions.'],
];
const query = 'AI that understands images';
if (!db || problems.includes('Embeddings')) {
  console.log('  (skipped: needs TiDB and its embedding model working)');
} else {
  try {
    await db.query(`CREATE TABLE _check_search (id INT PRIMARY KEY, title VARCHAR(255), embedding VECTOR(${EMBED_DIM}))`);
    await db.query(
      `INSERT INTO _check_search (id, title, embedding) VALUES ${docs.map(() => '(?, ?, EMBED_TEXT(?, ?))').join(', ')}`,
      docs.flatMap(([title, text], i) => [i + 1, title, EMBED_MODEL, `${title}: ${text}`])
    );
    const vector = await embedQuery(db, query);
    const [rows] = await db.query(
      `SELECT title, 1 - VEC_COSINE_DISTANCE(embedding, ?) AS score
       FROM _check_search ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT 3`,
      [vector, vector]
    );
    console.log(`  "${query}"`);
    for (const row of rows) console.log(`     ${Number(row.score).toFixed(3)}  ${row.title}`);
    if (rows[0]?.title === docs[0][0]) ok('TiDB ranked Computer vision first');
    else bad('Ranking', `expected Computer vision first, got ${rows[0]?.title}`);
  } catch (error) {
    bad('Search', error.message);
  }
}

if (db) {
  await dropScratchTables();
  await db.end();
}

console.log(
  problems.length
    ? `\n${problems.length} problem(s): ${problems.join(', ')}. Fix the → lines above and re-run.\n`
    : '\nAll good. Share .env.local with Karn and Navjot privately (a DM, not the repo).\n'
);

async function createTable(sql) {
  await db.query(sql);
  const [warnings] = await db.query('SHOW WARNINGS');
  return warnings.map((warning) => warning.Message).join('; ');
}

// Give a brand-new table a few seconds in case full-text queries aren't ready right away.
async function fullTextQueryError() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.query("SELECT id FROM _check_fts WHERE fts_match_word('vision', body)");
      return null;
    } catch (error) {
      lastError = error;
      await sleep(2000);
    }
  }
  return lastError.message;
}

async function dropScratchTables() {
  await db.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLES.join(', ')}`);
}
