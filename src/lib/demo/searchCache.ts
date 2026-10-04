import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SearchResponse } from "@/types/contracts";

type CacheFile = Record<string, SearchResponse>;

let cache: CacheFile | null = null;

function normalizeKey(query: string): string {
  return query.trim().toLowerCase();
}

async function loadCache(): Promise<CacheFile> {
  if (cache) return cache;
  try {
    const filePath = path.join(
      process.cwd(),
      "public",
      "demo",
      "search-cache.json",
    );
    const raw = await readFile(filePath, "utf8");
    cache = JSON.parse(raw) as CacheFile;
  } catch {
    cache = {};
  }
  return cache;
}

/** Offline pitch responses — used when DEMO_MODE or TiDB/search unavailable. */
export async function getDemoSearch(
  query: string,
): Promise<SearchResponse | null> {
  const data = await loadCache();
  return data[normalizeKey(query)] ?? null;
}
