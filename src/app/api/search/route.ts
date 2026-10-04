import { NextResponse } from "next/server";
import { getDemoSearch } from "@/lib/demo/searchCache";
import { loadNodes } from "@/lib/data/loadNodes";
import { searchLocal } from "@/lib/data/searchLocal";
import { searchTidb } from "@/lib/data/searchTidb";
import { isDemoMode } from "@/lib/data/tidb";
import type { SearchResponse } from "@/types/contracts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { query?: string };
  try {
    body = (await request.json()) as { query?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = body.query?.trim() ?? "";
  if (!query) {
    return NextResponse.json(
      { error: "query is required" },
      { status: 400 },
    );
  }

  // Demo mode: prefer baked pitch responses (works offline).
  if (isDemoMode()) {
    const demo = await getDemoSearch(query);
    if (demo) {
      return NextResponse.json({ ...demo, source: "demo" });
    }
  }

  try {
    const hybrid = await searchTidb(query);
    if (hybrid?.matches?.length) {
      return NextResponse.json({
        ...hybrid,
        source: "tidb",
      } satisfies SearchResponse & { source: string });
    }
  } catch {
    // fall through
  }

  const demo = await getDemoSearch(query);
  if (demo) {
    return NextResponse.json({ ...demo, source: "demo" });
  }

  const nodes = await loadNodes();
  const local = searchLocal(nodes, query);
  return NextResponse.json({ ...local, source: "local" });
}
