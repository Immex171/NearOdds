import pg from "pg";
import { createPool, migrate, type Db } from "../../src/db/index.js";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://nearodds:nearodds@localhost:5440/postgres";

export async function dbAvailable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 2000 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}
/** Fresh, isolated database per test file. */
export async function freshDb(): Promise<{ db: Db; drop: () => Promise<void>; url: string }> {
  const name = `nearodds_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const admin = new pg.Client({ connectionString: ADMIN }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = ADMIN.replace(/\/[^/]*$/, `/${name}`);
  const db = createPool(url); await migrate(db);
  return { db, url, drop: async () => { await db.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); } };
}
