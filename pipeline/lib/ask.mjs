// POST /api/ask {question} → { answer, sources: [{ id, title }], model }.
// Retrieval-augmented answers: TiDB's hybrid search finds the topics most relevant to the question,
// and Gemini answers from their Wikipedia summaries only, citing each topic it uses as [id], so every
// claim links back to a place on the map.
import { searchNodes } from './api.mjs';
import { pool } from './db.mjs';
import { geminiJson } from './gemini.mjs';

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function askUniverse(question) {
  const q = clip(question, 300);
  if (!q) return null;
  const { matches } = await searchNodes(q, { limit: 8 });
  if (!matches.length) return { answer: "Nothing in the map matches that question yet.", sources: [], model: null };

  const [rows] = await pool().query('SELECT id, title, summary FROM nodes WHERE id IN (?)', [matches.map((m) => m.id)]);
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const topics = matches.map((m) => byId.get(Number(m.id))).filter(Boolean); // keep the search order

  const prompt = `You answer questions in Hyperspace, a map of knowledge about artificial intelligence built from Wikipedia.

Answer the question as well as the topics below allow, using only what their summaries say. Only if they leave part of the question unanswered, end with a short clause saying what; otherwise don't mention gaps. Cite each topic you use by its id in square brackets, one id per bracket, like [123], right after the claim it supports. Write 2 to 4 plain sentences, under 90 words. No markdown, no lists, no preamble.

Topics:
${topics.map((t) => `[${t.id}] ${t.title}: ${clip(t.summary, 420)}`).join('\n')}

Question: ${q}

Respond with JSON: {"answer": "<your answer with [id] citations>"}`;

  const reply = await geminiJson(prompt, { timeoutMs: 15_000 });
  if (!reply) return null;
  const allowed = new Set(topics.map((t) => Number(t.id)));
  // Keep only citations to topics we supplied, so every chip leads somewhere real.
  const answer = clip(reply.data?.answer, 900)
    // "[12, 34]" → "[12] [34]", then drop any id we didn't supply.
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, ids) => ids.split(/\s*,\s*/).map((id) => `[${id}]`).join(' '))
    .replace(/\s*\[(\d+)\]/g, (citation, id) => (allowed.has(Number(id)) ? citation : ''))
    .trim();
  if (!answer) return null;
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const used = topics.filter((t) => cited.has(Number(t.id)));
  const sources = (used.length ? used : topics.slice(0, 4)).map((t) => ({ id: Number(t.id), title: t.title }));
  return { answer, sources, model: reply.model };
}
