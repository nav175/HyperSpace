import { requireEnv } from './env.mjs';

// Search embeddings come from TiDB's free model (lib/embedding.mjs). Gemini powers Expand and the
// connection explanations; the setup check only confirms the key works, with a call that spends no quota.
export async function checkGeminiKey() {
  const { GEMINI_API_KEY } = requireEnv('GEMINI_API_KEY');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': GEMINI_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Tried in order until one answers: Google retires model ids (gemini-2.0-flash now 404s) and the
// newest flash model often returns 503 under load, so the fast, less contended ones go first.
// GEMINI_MODEL, when set, goes before them all.
export const GEMINI_MODELS = [
  ...new Set([process.env.GEMINI_MODEL?.trim(), 'gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-3.8-flash'].filter(Boolean)),
];

// Asks Gemini for a JSON answer, trying each model in turn. Returns { data, model }, or null when
// there's no key or no model gives usable JSON.
export async function geminiJson(prompt, { timeoutMs = 10_000 } = {}) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            // These are short, focused answers; little reasoning keeps them to a few seconds.
            ...(model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join('');
      if (text) return { data: JSON.parse(text), model };
    } catch {
      // Timed out, or not JSON: try the next model.
    }
  }
  return null;
}
