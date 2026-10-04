import { NextResponse } from "next/server";
import { expandNode } from "@/lib/expand/expandEngine";
import { loadNodes } from "@/lib/data/loadNodes";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { nodeId?: number };
  try {
    body = (await request.json()) as { nodeId?: number };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const nodeId = Number(body.nodeId);
  if (!Number.isFinite(nodeId)) {
    return NextResponse.json(
      { error: "nodeId is required" },
      { status: 400 },
    );
  }

  const nodes = await loadNodes();
  const parent = nodes.find((n) => n.id === nodeId) ?? null;

  const result = await expandNode(nodeId, parent);
  if (!result) {
    return NextResponse.json({ error: "Node not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
