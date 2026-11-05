import { dbAvailable } from "./db.js";
import { findSandboxBin, MARKET_WASM, TOKEN_WASM } from "./sandbox.js";
import { existsSync } from "node:fs";

/**
 * Integration prerequisites. Locally a missing prerequisite skips the suite (with a console note).
 * In CI (CI=true) or with REQUIRE_INTEGRATION=1 a missing prerequisite FAILS the run with an explicit message,
 * so required tests can never be silently skipped.
 */
export async function prereq(o: { sandbox?: boolean } = {}): Promise<boolean> {
  const missing: string[] = [];
  if (!(await dbAvailable())) missing.push(`PostgreSQL not reachable (TEST_DATABASE_ADMIN_URL=${process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://nearodds:nearodds@localhost:5440/postgres"}); run 'pnpm db:up'`);
  if (o.sandbox) {
    if (!findSandboxBin()) missing.push("near-sandbox binary not found (build it with 'cargo build -p near-sandbox' or set SANDBOX_BIN)");
    for (const f of [MARKET_WASM, TOKEN_WASM]) if (!existsSync(f)) missing.push(`missing Wasm artifact ${f} (run scripts/build-wasm.sh)`);
  }
  if (!missing.length) return true;
  if (process.env.CI || process.env.REQUIRE_INTEGRATION === "1") throw new Error("Required integration prerequisites are missing:\n - " + missing.join("\n - "));
  console.warn("[skip] integration prerequisites missing:\n - " + missing.join("\n - "));
  return false;
}
