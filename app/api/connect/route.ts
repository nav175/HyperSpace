// POST /api/connect {from: {title, summary}, to: {title, summary}, path: [titles]} → { explanation, model }.
import { NextResponse } from 'next/server';
import { explainConnection } from '../../../pipeline/lib/connect.mjs';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body?.from?.title || !body?.to?.title) {
    return NextResponse.json({ error: 'from and to are required' }, { status: 400 });
  }
  try {
    const result = await explainConnection(body);
    return result ? NextResponse.json(result) : NextResponse.json({ error: 'Gemini is unavailable' }, { status: 503 });
  } catch (error) {
    console.error('connect failed', error);
    return NextResponse.json({ error: 'Gemini is unavailable' }, { status: 503 });
  }
}
