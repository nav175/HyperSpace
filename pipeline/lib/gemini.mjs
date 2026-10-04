import { requireEnv } from './env.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta';

export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL?.trim() || 'gemini-embedding-2';
export const EMBED_DIM = Number(process.env.EMBED_DIM || 768);

// gemini-embedding-2 has no taskType parameter; the task goes inside the text.
// Documents and queries use different templates, so always embed through these two.
export const asDocument = (title, text) => `title: ${title || 'none'} | text: ${text}`;
export const asQuery = (query) => `task: search result | query: ${query}`;

export async function embedBatch(texts, { timeoutMs = 30_000 } = {}) {
  const { GEMINI_API_KEY } = requireEnv('GEMINI_API_KEY');
  const res = await fetch(`${API}/models/${EMBED_MODEL}:batchEmbedContents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIM,
      })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
    error.status = res.status;
    // Quota errors carry RetryInfo / QuotaFailure details saying how long to wait and which limit hit.
    try {
      error.details = JSON.parse(body).error?.details ?? [];
    } catch {
      error.details = [];
    }
    throw error;
  }
  const { embeddings } = await res.json();
  return embeddings.map((embedding) => embedding.values);
}

export async function listEmbeddingModels() {
  const { GEMINI_API_KEY } = requireEnv('GEMINI_API_KEY');
  const res = await fetch(`${API}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': GEMINI_API_KEY },
  });
  if (!res.ok) return [];
  const { models = [] } = await res.json();
  return models
    .filter((model) => model.supportedGenerationMethods?.includes('embedContent'))
    .map((model) => model.name.replace('models/', ''));
}
