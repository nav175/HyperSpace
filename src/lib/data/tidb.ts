import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

let pool: Pool | null = null;
let cachedDatasetVersion: string | null | undefined;

export function tidbConfigured(): boolean {
  return Boolean(
    process.env.TIDB_HOST?.trim() &&
      process.env.TIDB_USER?.trim() &&
      process.env.TIDB_PASSWORD?.trim(),
  );
}

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function getTidbPool(): Pool {
  if (pool) return pool;
  if (!tidbConfigured()) {
    throw new Error("TiDB is not configured");
  }
  const database = process.env.TIDB_DATABASE?.trim() || "hyperspace";
  pool = mysql.createPool({
    host: process.env.TIDB_HOST!.trim(),
    port: Number(process.env.TIDB_PORT || 4000),
    user: process.env.TIDB_USER!.trim(),
    password: process.env.TIDB_PASSWORD!.trim(),
    database,
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionLimit: 5,
  });
  return pool;
}

export async function getDatasetVersion(): Promise<string | null> {
  if (cachedDatasetVersion !== undefined) return cachedDatasetVersion;
  if (!tidbConfigured()) {
    cachedDatasetVersion = null;
    return null;
  }
  try {
    const [rows] = await getTidbPool().query<RowDataPacket[]>(
      "SELECT dataset_version FROM nodes LIMIT 1",
    );
    cachedDatasetVersion =
      (rows[0]?.dataset_version as string | undefined) ?? null;
  } catch {
    cachedDatasetVersion = null;
  }
  return cachedDatasetVersion;
}

export function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}
