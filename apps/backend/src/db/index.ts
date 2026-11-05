import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// NUMERIC columns come back as exact decimal strings; never parse to Number.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v); // int8 as string

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Q = pg.Pool | pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function withTx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const done = await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
    if (done.rowCount) continue;
    await withTx(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(727001)");
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}
