import type { Node, NodeDetailResponse } from "@/types/contracts";
import { loadNodes } from "@/lib/data/loadNodes";

/** Build root→node id path from Dilpreet’s parentId tree (offline / no TiDB). */
export async function getNodeLocal(
  id: string | number,
): Promise<NodeDetailResponse | null> {
  if (!/^\d+$/.test(String(id))) return null;
  const numericId = Number(id);
  const nodes = await loadNodes();
  const byId = new Map<number, Node>();
  for (const n of nodes) byId.set(n.id, n);

  const node = byId.get(numericId);
  if (!node) return null;

  const path: number[] = [];
  let cur: Node | undefined = node;
  let guard = 0;
  while (cur && guard++ < 64) {
    path.push(cur.id);
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  path.reverse();

  return { ...node, path };
}
