// POST /api/connect {from, to, path} → { explanation, model }.
// Gemini explains how two topics relate, for the "How are these connected?" view. The client sends the
// two topics (title and summary) and the titles along the map's path between them, which runs up
// to their nearest shared field and back down.
import { geminiJson } from './gemini.mjs';

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function explainConnection({ from, to, path }) {
  const a = { title: clip(from?.title, 200), summary: clip(from?.summary, 600) };
  const b = { title: clip(to?.title, 200), summary: clip(to?.summary, 600) };
  if (!a.title || !b.title) return null;
  const route = (Array.isArray(path) ? path : []).slice(0, 14).map((title) => clip(title, 200)).filter(Boolean);

  const prompt = `You explain links between ideas in Hyperspace, a map of knowledge about artificial intelligence built from Wikipedia.

Topic A: "${a.title}": ${a.summary}
Topic B: "${b.title}": ${b.summary}
On the map, the path between them runs through the Wikipedia hierarchy: ${route.join(' › ')}

In 2 or 3 plain sentences (under 75 words), explain how A and B are connected in the real world: what they share, how one uses or feeds into the other, or why they sit in the same field. Mention the shared field from the path where it helps. No markdown, no lists, no preamble.

Respond with JSON: {"explanation": "<your 2–3 sentences>"}`;

  const answer = await geminiJson(prompt, { timeoutMs: 12_000 });
  const explanation = clip(answer?.data?.explanation, 700);
  return explanation ? { explanation, model: answer.model } : null;
}
