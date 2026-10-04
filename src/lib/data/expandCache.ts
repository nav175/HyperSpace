import type { RowDataPacket } from "mysql2/promise";
import type { ExpandResponse, Node } from "@/types/contracts";
import {
  getDatasetVersion,
  getTidbPool,
  parseJsonField,
  tidbConfigured,
} from "@/lib/data/tidb";

export async function getCachedExpansion(
  nodeId: number,
): Promise<ExpandResponse | null> {
  if (!tidbConfigured()) return null;
  const version = await getDatasetVersion();
  if (!version) return null;

  const [rows] = await getTidbPool().query<RowDataPacket[]>(
    "SELECT children FROM expansions WHERE node_id = ? AND dataset_version = ?",
    [nodeId, version],
  );
  const row = rows[0];
  if (!row) return null;
  const children = parseJsonField<Node[]>(row.children, []);
  return { parentId: nodeId, children };
}

export async function saveExpansion(
  nodeId: number,
  children: Node[],
  model: string,
): Promise<void> {
  if (!tidbConfigured()) return;
  const version = await getDatasetVersion();
  if (!version) return;

  await getTidbPool().query(
    "REPLACE INTO expansions (node_id, dataset_version, children, model) VALUES (?, ?, ?, ?)",
    [nodeId, version, JSON.stringify(children), model],
  );
}
