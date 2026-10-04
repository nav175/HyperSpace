// POST /api/search {query} → { matches: [{ id, title, score, path }], focusNodeId } (README contract).
import { NextResponse } from 'next/server';
import { searchNodes } from '../../../pipeline/lib/api.mjs';

export const runtime = 'nodejs'; // mysql2 needs Node.js, not the Edge runtime

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const query = typeof body?.query === 'string' ? body.query : '';
  if (!query.trim()) return NextResponse.json({ error: 'query is required' }, { status: 400 });
  try {
    return NextResponse.json(await searchNodes(query));
  } catch (error) {
    console.error('search failed', error);
    return NextResponse.json({ error: 'Search is unavailable' }, { status: 503 });
  }
}
