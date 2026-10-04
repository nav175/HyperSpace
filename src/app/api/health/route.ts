import { NextResponse } from "next/server";
import { loadNodes, loadNodesMeta } from "@/lib/data/loadNodes";
import { isDemoMode, tidbConfigured } from "@/lib/data/tidb";

export const runtime = "nodejs";

export async function GET() {
  const meta = await loadNodesMeta();
  let nodeCount = meta?.nodeCount ?? 0;
  try {
    const nodes = await loadNodes();
    nodeCount = nodes.length;
  } catch {
    /* ignore */
  }

  return NextResponse.json({
    ok: true,
    service: "hyperspace",
    demoMode: isDemoMode(),
    tidbConfigured: tidbConfigured(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    datasetVersion: meta?.datasetVersion ?? null,
    nodeCount,
    time: new Date().toISOString(),
  });
}
