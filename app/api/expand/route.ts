// POST /api/expand {nodeId, depth?} → { parentId, children: [Node], model } (README contract, plus model).
import { NextResponse } from 'next/server';
import { expandNode } from '../../../pipeline/lib/expand.mjs';

export const runtime = 'nodejs'; // mysql2 needs Node.js, not the Edge runtime
export const maxDuration = 60; // Wikipedia + Gemini take a few seconds on a cold Expand

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const nodeId = Number(body?.nodeId);
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
    return NextResponse.json({ error: 'nodeId is required' }, { status: 400 });
  }
  // Only needed for nodes that Expand grew, which aren't in TiDB.
  const depth = Math.min(20, Math.max(0, Math.trunc(Number(body?.depth) || 1)));
  try {
    const result = await expandNode(nodeId, { depth });
    return result ? NextResponse.json(result) : NextResponse.json({ error: 'Node not found' }, { status: 404 });
  } catch (error) {
    console.error('expand failed', error);
    return NextResponse.json({ error: 'Expand is unavailable' }, { status: 503 });
  }
}
