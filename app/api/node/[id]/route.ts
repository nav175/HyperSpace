// GET /api/node/:id → Node + path: [ids] (README contract).
import { NextResponse } from 'next/server';
import { getNode } from '../../../../pipeline/lib/api.mjs';

export const runtime = 'nodejs'; // mysql2 needs Node.js, not the Edge runtime

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const node = await getNode(id);
  return node ? NextResponse.json(node) : NextResponse.json({ error: 'Node not found' }, { status: 404 });
}
