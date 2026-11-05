import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import { Keystore, SignerRegistry, keyFromCredentialsFile } from "../near/keystore.js";
import { existsSync } from "node:fs";

export type Role = "deployer" | "resolver" | "tokenOwner";

export function buildSigners(cfg: Config, db: Db) {
  const ks = new Keystore(cfg.keystoreDir);
  const reg = new SignerRegistry(ks, db);
  const roles: Record<Role, { accountId: string; available: boolean; reason?: string }> = {} as any;
  for (const [role, s] of [["deployer", cfg.deployer], ["resolver", cfg.resolver], ["tokenOwner", cfg.tokenOwner]] as const) {
    if (!s.credentialsFile) { roles[role] = { accountId: s.accountId, available: false, reason: "credentials file not configured" }; continue; }
    if (!existsSync(s.credentialsFile)) { roles[role] = { accountId: s.accountId, available: false, reason: "credentials file not found" }; continue; }
    try { reg.register(keyFromCredentialsFile(s.accountId, s.credentialsFile)); roles[role] = { accountId: s.accountId, available: true }; }
    catch { roles[role] = { accountId: s.accountId, available: false, reason: "credentials file unreadable" }; }
  }
  /** Honest disclosure: roles that resolve to the same account share one key. */
  const sharedKeys = (["deployer", "resolver", "tokenOwner"] as Role[]).filter((r, _i, a) => a.filter((x) => roles[x].accountId === roles[r].accountId).length > 1);
  return { ks, reg, roles, keyIsolation: sharedKeys.length === 0, sharedKeyRoles: sharedKeys };
}
export type Signers = ReturnType<typeof buildSigners>;

/** API-process view: does NOT load keys, only whether a credentials file is configured and present. */
export function roleStatus(cfg: Config) {
  const r = (a: { accountId: string; credentialsFile: string | null }) => ({ accountId: a.accountId, available: !!a.credentialsFile && existsSync(a.credentialsFile) });
  const roles = { deployer: r(cfg.deployer), resolver: r(cfg.resolver), tokenOwner: r(cfg.tokenOwner) };
  const ids = Object.values(roles).map((x) => x.accountId);
  const shared = (Object.keys(roles) as Role[]).filter((k) => ids.filter((i) => i === roles[k].accountId).length > 1);
  return { roles, keyIsolation: shared.length === 0, sharedKeyRoles: shared,
    note: shared.length ? `Roles ${shared.join(", ")} resolve to the same account; key isolation is NOT provided.` : "Each role uses a distinct account." };
}
