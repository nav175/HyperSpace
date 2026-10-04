// POST /api/ask {question} → { answer, sources: [{ id, title }], model }.
import { NextResponse } from 'next/server';
import { askUniverse } from '../../../pipeline/lib/ask.mjs';

export const runtime = 'nodejs'; // mysql2 needs Node.js, not the Edge runtime
export const maxDuration = 30;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const question = typeof body?.question === 'string' ? body.question : '';
  if (!question.trim()) return NextResponse.json({ error: 'question is required' }, { status: 400 });
  try {
    const result = await askUniverse(question);
    return result ? NextResponse.json(result) : NextResponse.json({ error: 'Gemini is unavailable' }, { status: 503 });
  } catch (error) {
    console.error('ask failed', error);
    return NextResponse.json({ error: 'Ask is unavailable' }, { status: 503 });
  }
}
