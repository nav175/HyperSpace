// GET /api/node/:id → Node + path: [ids] (README contract).
// Mirrors Dilpreet’s pipeline/next-routes template + offline nodes.json fallback.
import { NextResponse } from "next/server";
import { getNodeLocal } from "@/lib/data/getNodeLocal";
import { getNodeTidb } from "@/lib/data/getNodeTidb";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const fromDb = await getNodeTidb(id);
    if (fromDb) return NextResponse.json(fromDb);
  } catch {
    // TiDB unreachable — fall through to local nodes.json
  }

  const local = await getNodeLocal(id);
  if (local) return NextResponse.json(local);

  return NextResponse.json({ error: "Node not found" }, { status: 404 });
}
