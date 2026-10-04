import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Node } from "@/types/contracts";

let cache: Node[] | null = null;

/**
 * Load Dilpreet’s ingested universe from pipeline/data/nodes.json.
 * Server-only — do not import this from client components.
 */
export async function loadNodes(): Promise<Node[]> {
  if (cache) return cache;

  const filePath = path.join(
    process.cwd(),
    "pipeline",
    "data",
    "nodes.json",
  );
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Node[];

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`nodes.json missing or empty at ${filePath}`);
  }

  cache = parsed;
  return cache;
}

export async function loadNodesMeta(): Promise<{
  datasetVersion?: string;
  root?: string;
  nodeCount?: number;
  generatedAt?: string;
} | null> {
  try {
    const filePath = path.join(
      process.cwd(),
      "pipeline",
      "data",
      "nodes.meta.json",
    );
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as {
      datasetVersion?: string;
      root?: string;
      nodeCount?: number;
      generatedAt?: string;
    };
  } catch {
    return null;
  }
}
