import { requireEnv } from './env.mjs';

// Search embeddings come from TiDB's free model (lib/embedding.mjs). Gemini powers Expand,
// so the pipeline only checks that the key works, with a call that spends no quota.
export async function checkGeminiKey() {
  const { GEMINI_API_KEY } = requireEnv('GEMINI_API_KEY');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': GEMINI_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
