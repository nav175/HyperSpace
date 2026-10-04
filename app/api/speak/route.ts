// GET /api/speak → { enabled }. POST /api/speak {text} → audio/mpeg, read aloud by ElevenLabs.
// Listen buttons only appear when ELEVENLABS_API_KEY is set.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const VOICE = process.env.ELEVENLABS_VOICE_ID?.trim() || 'JBFqnCBsd6RMkjVDRZzb';
const MODEL = process.env.ELEVENLABS_MODEL?.trim() || 'eleven_multilingual_v2';
// Card text only: a short cap keeps a stray request from spending many credits.
const MAX_CHARS = 900;

const apiKey = () => process.env.ELEVENLABS_API_KEY?.trim();

export async function GET() {
  return NextResponse.json({ enabled: Boolean(apiKey()) });
}

export async function POST(request: Request) {
  const key = apiKey();
  if (!key) return NextResponse.json({ error: 'Voice is not set up' }, { status: 501 });
  const body = await request.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS) : '';
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !res.body) {
      console.error('speak failed', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return NextResponse.json({ error: 'Voice is unavailable' }, { status: 502 });
    }
    return new Response(res.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('speak failed', error);
    return NextResponse.json({ error: 'Voice is unavailable' }, { status: 502 });
  }
}
