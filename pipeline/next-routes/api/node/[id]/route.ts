// GET /api/node/:id → Node + path: [ids] (README contract).
// For Karn's Next.js app: copy pipeline/next-routes/api into the app's `app/api` folder.
// - With a `src/app` layout, add one more `../` to the import below.
// - Add mysql2 to the root package.json so Vercel installs it.
// - If the build trips over mysql2, add `serverExternalPackages: ['mysql2']` to next.config.
import { NextResponse } from 'next/server';
import { getNode } from '../../../../pipeline/lib/api.mjs';

export const runtime = 'nodejs'; // mysql2 needs Node.js, not the Edge runtime

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const node = await getNode(id);
  return node ? NextResponse.json(node) : NextResponse.json({ error: 'Node not found' }, { status: 404 });
}
