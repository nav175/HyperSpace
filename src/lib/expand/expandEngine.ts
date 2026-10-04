import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExpandResponse, Node } from "@/types/contracts";
import {
  getCachedExpansion,
  saveExpansion,
} from "@/lib/data/expandCache";
import { loadNodes } from "@/lib/data/loadNodes";
import { isDemoMode } from "@/lib/data/tidb";
import { organizeWithGemini } from "@/lib/expand/geminiOrganize";
import { fetchWikipediaCandidates } from "@/lib/expand/wikipedia";

type DemoFile = Record<string, ExpandResponse>;

let demoFile: DemoFile | null = null;

async function loadDemoExpansions(): Promise<DemoFile> {
  if (demoFile) return demoFile;
  try {
    const filePath = path.join(
      process.cwd(),
      "public",
      "demo",
      "expansions.json",
    );
    demoFile = JSON.parse(await readFile(filePath, "utf8")) as DemoFile;
  } catch {
    demoFile = {};
  }
  return demoFile;
}

async function getDemoExpansion(
  nodeId: number,
): Promise<ExpandResponse | null> {
  const data = await loadDemoExpansions();
  return data[String(nodeId)] ?? null;
}

/** Local fallback: graft deeper nodes that already exist under this parent in nodes.json. */
async function localChildrenFallback(
  parent: Node,
): Promise<ExpandResponse | null> {
  const nodes = await loadNodes();
  const kids = nodes
    .filter((n) => n.parentId === parent.id)
    .slice(0, 8);
  if (!kids.length) return null;
  return { parentId: parent.id, children: kids };
}

/**
 * Expand a node: TiDB cache → demo JSON → Wikipedia (+ optional Gemini) → local kids.
 */
export async function expandNode(
  nodeId: number,
  parentHint?: Node | null,
): Promise<ExpandResponse | null> {
  const cached = await getCachedExpansion(nodeId);
  if (cached?.children?.length) return cached;

  const demo = await getDemoExpansion(nodeId);
  if (demo?.children?.length) {
    if (!isDemoMode()) {
      try {
        await saveExpansion(nodeId, demo.children, "demo-cache");
      } catch {
        /* ignore */
      }
    }
    return demo;
  }

  const nodes = await loadNodes();
  const parent =
    parentHint ?? nodes.find((n) => n.id === nodeId) ?? null;
  if (!parent) return null;

  if (isDemoMode()) {
    return (await localChildrenFallback(parent)) ?? {
      parentId: parent.id,
      children: [],
    };
  }

  try {
    const candidates = await fetchWikipediaCandidates(parent, 14);
    // Drop nodes already in the universe under this parent
    const existingKids = new Set(
      nodes.filter((n) => n.parentId === parent.id).map((n) => n.id),
    );
    const fresh = candidates.filter((c) => !existingKids.has(c.id));
    if (!fresh.length) {
      return (await localChildrenFallback(parent)) ?? {
        parentId: parent.id,
        children: [],
      };
    }

    const organized =
      (await organizeWithGemini(parent, fresh)) ?? fresh.slice(0, 8);

    const result: ExpandResponse = {
      parentId: parent.id,
      children: organized,
    };

    try {
      await saveExpansion(
        parent.id,
        organized,
        process.env.GEMINI_API_KEY?.trim()
          ? process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash"
          : "wikipedia-raw",
      );
    } catch {
      /* cache optional */
    }

    return result;
  } catch {
    return localChildrenFallback(parent);
  }
}
