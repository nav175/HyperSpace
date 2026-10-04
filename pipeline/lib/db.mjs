import mysql from 'mysql2/promise';
import { requireEnv } from './env.mjs';

export const DB_NAME = process.env.TIDB_DATABASE?.trim() || 'hyperspace';
if (!/^\w+$/.test(DB_NAME)) {
  throw new Error(`TIDB_DATABASE may only contain letters, digits and _ (got "${DB_NAME}")`);
}

// TiDB Cloud Starter only accepts TLS. Its certificate chains to a public root CA,
// so Node's built-in CA store is enough and no CA file is needed.
export async function connect({ useDatabase = true } = {}) {
  const env = requireEnv('TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD');
  return mysql.createConnection({
    host: env.TIDB_HOST,
    port: Number(process.env.TIDB_PORT || 4000),
    user: env.TIDB_USER,
    password: env.TIDB_PASSWORD,
    database: useDatabase ? DB_NAME : undefined,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  });
}

// TiDB reads vectors from strings like '[0.12,-0.5,...]'.
export const toVector = (values) => JSON.stringify(values);
