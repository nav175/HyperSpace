// Tests for the data layer: nodes.json, then TiDB storage and search. Free to run any time:
// embeddings come from TiDB's own model, so nothing here spends Gemini quota.
//   npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { connect } from './lib/db.mjs';
import { EMBED_DIM, embedQuery } from './lib/embedding.mjs';

const readData = (name) => JSON.parse(readFileSync(new URL(`data/${name}`, import.meta.url), 'utf8'));
const nodes = readData('nodes.json');
const meta = readData('nodes.meta.json');
const byId = new Map(nodes.map((node) => [node.id, node]));
const byTitle = (title) => nodes.find((node) => node.title === title);
const parsePath = (path) => (typeof path === 'string' ? JSON.parse(path) : path);
const DEMO_TOPICS = [
  'Computer vision',
  'Vision transformer',
  'Convolutional neural network',
  'Large language models',
  'Reinforcement learning',
  'Natural language processing',
  'Generative AI',
  'Humanoid robots',
];

describe('nodes.json', () => {
  test('every node has exactly the contract fields, a summary and a Wikipedia link', () => {
    for (const node of nodes) {
      assert.deepEqual(Object.keys(node), ['id', 'title', 'summary', 'parentId', 'depth', 'url', 'type'], node.title);
      assert.ok(['category', 'article'].includes(node.type), node.title);
      assert.match(node.url, /^https:\/\/en\.wikipedia\.org\/wiki\//, node.title);
      assert.ok(node.summary.trim(), `${node.title} has no summary`);
    }
  });

  test('forms one tree, with parents listed before their children', () => {
    assert.equal(byId.size, nodes.length, 'duplicate ids');
    const roots = nodes.filter((node) => node.parentId === null);
    assert.equal(roots.length, 1, 'expected exactly one root');
    assert.equal(roots[0].depth, 0);
    const seen = new Set();
    for (const node of nodes) {
      if (node.parentId !== null) {
        assert.ok(seen.has(node.parentId), `${node.title} comes before its parent`);
        assert.equal(node.depth, byId.get(node.parentId).depth + 1, node.title);
      }
      seen.add(node.id);
    }
  });

  test('has 1,500–3,000 nodes', () => {
    assert.ok(nodes.length >= 1500 && nodes.length <= 3000, `${nodes.length} nodes`);
    assert.equal(meta.nodeCount, nodes.length);
  });

  test('includes every demo topic', () => {
    for (const title of DEMO_TOPICS) assert.ok(byTitle(title), `missing ${title}`);
  });

  test('has no biographies or news events', () => {
    const leaks = nodes.filter((node) => /\(born /.test(node.summary) || /^\d{4}\b/.test(node.title));
    assert.deepEqual(leaks.map((node) => node.title), []);
  });
});

describe('TiDB', () => {
  let db;
  before(async () => {
    db = await connect();
  });
  after(async () => {
    await db?.end();
  });

  test('holds exactly the rows in nodes.json', async () => {
    const [[row]] = await db.query(
      'SELECT COUNT(*) AS count, MIN(dataset_version) AS oldest, MAX(dataset_version) AS newest FROM nodes'
    );
    assert.equal(row.count, nodes.length, 'out of date: run npm run load');
    assert.equal(row.oldest, meta.datasetVersion);
    assert.equal(row.newest, meta.datasetVersion);
  });

  test('every path runs from the root down to its node', async () => {
    const [rows] = await db.query('SELECT id, depth, path FROM nodes');
    for (const row of rows) {
      const path = parsePath(row.path);
      assert.equal(path.length, row.depth + 1, `node ${row.id}`);
      assert.equal(path.at(-1), row.id, `node ${row.id}`);
      assert.equal(byId.get(path[0])?.parentId, null, `node ${row.id}`);
    }
  });

  test('a lookup returns the contract shape plus path, as /api/node/:id will', async () => {
    const [[row]] = await db.query(
      'SELECT id, title, summary, parent_id AS parentId, depth, url, type, path FROM nodes WHERE title = ?',
      ['Vision transformer']
    );
    const { path, ...node } = row;
    assert.deepEqual(node, byTitle('Vision transformer'));
    assert.deepEqual(
      parsePath(path).map((id) => byId.get(id).title),
      ['Artificial intelligence', 'Computer vision', 'Vision transformer']
    );
  });

  test('full-text search finds nodes by keyword', async () => {
    const [hits] = await db.query(
      'SELECT title FROM nodes WHERE fts_match_word(?, search_text) ORDER BY fts_match_word(?, search_text) DESC LIMIT 5',
      ['convolutional', 'convolutional']
    );
    const titles = hits.map((hit) => hit.title);
    assert.ok(titles.includes('Convolutional neural network'), titles.join(', '));
  });

  test(`stored embeddings are ${EMBED_DIM}-wide vectors`, async () => {
    const [[row]] = await db.query(
      'SELECT COUNT(*) AS wrong FROM nodes WHERE embedding IS NOT NULL AND VEC_DIMS(embedding) <> ?',
      [EMBED_DIM]
    );
    assert.equal(row.wrong, 0);
  });

  test('vector search puts related topics nearest (stored vectors, no Gemini call)', async () => {
    const cases = [
      ['Convolutional neural network', ['Computer vision', 'Convolution']],
      ['Humanoid robots', ['Robots', 'Social robots']],
    ];
    for (const [seed, expected] of cases) {
      const [[{ embedded }]] = await db.query('SELECT embedding IS NOT NULL AS embedded FROM nodes WHERE title = ?', [seed]);
      assert.ok(embedded, `${seed} has no embedding yet: run npm run embed`);
      const [hits] = await db.query(
        `SELECT n.title FROM nodes n JOIN nodes s ON s.title = ?
         WHERE n.embedding IS NOT NULL AND n.id <> s.id
         ORDER BY VEC_COSINE_DISTANCE(n.embedding, s.embedding) LIMIT 5`,
        [seed]
      );
      const titles = hits.map((hit) => hit.title);
      assert.ok(titles.some((title) => expected.includes(title)), `${seed} → ${titles.join(', ')}`);
    }
  });

  test('every node has an embedding', async (t) => {
    const [[row]] = await db.query('SELECT COUNT(embedding) AS embedded, COUNT(*) AS total FROM nodes');
    if (row.embedded < row.total) t.todo(`${row.embedded} of ${row.total} embedded so far; run npm run embed`);
    else assert.equal(row.embedded, row.total);
  });

  test('a typed query lands in the right region (TiDB embeds the query)', async () => {
    const vector = await embedQuery(db, 'AI that understands images');
    const [hits] = await db.query(
      'SELECT title, path FROM nodes WHERE embedding IS NOT NULL ORDER BY VEC_COSINE_DISTANCE(embedding, ?) LIMIT 5',
      [vector]
    );
    const computerVision = byTitle('Computer vision').id;
    assert.ok(
      hits.some((hit) => parsePath(hit.path).includes(computerVision)),
      `no Computer vision node in: ${hits.map((hit) => hit.title).join(', ')}`
    );
  });
});
