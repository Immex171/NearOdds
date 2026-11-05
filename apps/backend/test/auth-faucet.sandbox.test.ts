import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions, KeyPair, KeyPairSigner } from "near-api-js";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { sandboxAvailable, startSandbox, type Sandbox } from "./helpers/sandbox.js";
import { TestChain } from "./helpers/chain.js";
import { keeperEnv } from "./helpers/keeper-env.js";
import { login, signChallenge } from "./helpers/auth.js";
import { setupMarket } from "./helpers/market.js";
import { buildApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/index.js";
import { keeperPass, handlersFor } from "../src/keeper/loop.js";
import { runOne } from "../src/keeper/jobs.js";

const ok = await prereq({ sandbox: true });
describe.skipIf(!ok)("wallet auth, watchlist, admin gating, faucet", () => {
  let sbx: Sandbox, fdb: Awaited<ReturnType<typeof freshDb>>, chain: TestChain, env: Awaited<ReturnType<typeof keeperEnv>>, app: ReturnType<typeof buildApp>;
  let admin: any, alice: any, token: string, ref: string;
  beforeAll(async () => {
    sbx = await startSandbox(); fdb = await freshDb(); chain = new TestChain(sbx, fdb.db);
    admin = await chain.createAccount("deployer", 300n); alice = await chain.createAccount("alice", 20n);
    token = await chain.deployToken(admin);
    env = await keeperEnv(sbx, fdb.db, chain, admin, (admin.signer as any).key.toString(), token);
    env.cfg.faucet.tokenId = token; env.cfg.faucet.amount = 100_000_000n; env.cfg.faucet.perAccountLimit = 250_000_000n; env.cfg.faucet.cooldownSeconds = 0;
    ref = (await setupMarket(chain, fdb.db, admin, token, "authm", 3_600_000)).ref;
    app = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: env.cfg });
  });
  afterAll(async () => { await app?.close(); await sbx?.stop(); await fdb?.drop(); });

  it("NEP-413 login: valid signature works; replay, wrong recipient, expiry, function-call key and foreign key are rejected", async () => {
    const ch = async () => (await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { accountId: alice.accountId } })).json();
    const c1 = await ch();
    const body = await signChallenge(alice, c1);
    const good = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: body });
    expect(good.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: body });
    expect(replay.statusCode).toBe(401); expect(replay.json().error.code).toBe("nonce_invalid");
    const c2 = await ch();
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: await signChallenge(alice, c2, "evil.app") })).json().error.code).toBe("bad_signature");
    const c3 = await ch();
    await fdb.db.query("UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce=$1", [Buffer.from(c3.nonce, "base64").toString("hex")]);
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: await signChallenge(alice, c3) })).json().error.code).toBe("nonce_invalid");
    // key that is not on the account
    const stranger = { accountId: alice.accountId, publicKey: "", signer: new KeyPairSigner(KeyPair.fromRandom("ed25519")) } as any;
    stranger.publicKey = (await stranger.signer.getPublicKey()).toString();
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: await signChallenge(stranger, await ch()) })).json().error.code).toBe("key_not_on_account");
    // function-call (non full-access) key
    const fk = KeyPair.fromRandom("ed25519");
    await chain.tx.execute("fk", null, alice, alice.accountId, [actions.addFunctionCallAccessKey(fk.getPublicKey(), token, ["storage_deposit"])], "add fc key");
    const fcKey = { accountId: alice.accountId, publicKey: fk.getPublicKey().toString(), signer: new KeyPairSigner(fk) } as any;
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: await signChallenge(fcKey, await ch()) })).json().error.code).toBe("key_not_full_access");
    // signing for a different account than the challenge
    const bobChallenge = await ch();
    const forged = await signChallenge(alice, bobChallenge); forged.accountId = admin.accountId;
    expect((await app.inject({ method: "POST", url: "/v1/auth/verify", payload: forged })).statusCode).toBe(401);
  });

  it("watchlist needs a session; admin routes need the allowlist; logout ends the session", async () => {
    expect((await app.inject({ method: "PUT", url: `/v1/watchlist/${ref}` })).statusCode).toBe(401);
    const t = await login(app, alice);
    const H = { authorization: `Bearer ${t}` };
    expect((await app.inject({ method: "PUT", url: `/v1/watchlist/${ref}`, headers: H })).json().watching).toBe(true);
    expect((await app.inject({ method: "PUT", url: `/v1/watchlist/${ref}`, headers: H })).statusCode).toBe(200); // idempotent
    expect((await app.inject({ url: "/v1/watchlist", headers: H })).json().items.map((x: any) => x.marketRef)).toEqual([ref]);
    expect((await app.inject({ method: "DELETE", url: `/v1/watchlist/${ref}`, headers: H })).json().watching).toBe(false);
    expect((await app.inject({ url: "/v1/admin/templates", headers: H })).statusCode).toBe(403);
    const ta = await login(app, admin);
    expect((await app.inject({ url: "/v1/admin/templates", headers: { authorization: `Bearer ${ta}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: H })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/auth/session", headers: H })).statusCode).toBe(401);
  });

  it("automatic resolution needs a registered provider; unknown artifacts are refused (admin API)", async () => {
    const ta = { authorization: `Bearer ${await login(app, admin)}` };
    const tpl = (over: object) => ({ slug: "t-x", category: "Weather", questionTemplate: "Q {{date}}?", rulesTemplate: "r", resolutionSource: "s", schedule: { frequency: "daily", timezone: "UTC", leadDays: 1 }, cutoff: { offsetMinutesFromObservationStart: 0 }, observation: null, evidence: { required: true, description: "d" }, resolverAccount: admin.accountId, collateralToken: token, artifact: { id: "market-wasm", version: "1.0.0" }, limits: { fundingYocto: "1", creationBudgetYocto: "1", minDeployerBalanceYocto: "0", maxPerDay: 1 }, resolution: { policy: "reviewed" }, ...over });
    const auto = await app.inject({ method: "POST", url: "/v1/admin/templates", headers: ta, payload: tpl({ resolution: { policy: "automatic", provider: "nimet", decisionRule: "x" } }) });
    expect(auto.statusCode).toBe(400); expect(auto.json().error.code).toBe("provider_not_available");
    const art = await app.inject({ method: "POST", url: "/v1/admin/templates", headers: ta, payload: tpl({ artifact: { id: "market-wasm", version: "9.9.9" } }) });
    expect(art.json().error.code).toBe("artifact_not_approved");
    const badPh = await app.inject({ method: "POST", url: "/v1/admin/templates", headers: ta, payload: tpl({ slug: "t-y", questionTemplate: "Q {{nope}}" }) });
    expect(badPh.statusCode).toBe(201); // placeholder problems surface per-occurrence at validation (job fails, never deploys)
  });

  it("faucet: quotas, idempotent claims, registration, no duplicate mint on retry/restart", async () => {
    const t = await login(app, alice); const H = (k?: string) => ({ authorization: `Bearer ${t}`, ...(k ? { "idempotency-key": k } : {}) });
    const st = (await app.inject("/v1/faucet")).json();
    expect(st.enabled).toBe(true); expect(st.tokenId).toBe(token);
    expect((await app.inject({ method: "POST", url: "/v1/faucet/claim" })).statusCode).toBe(401);
    const [c1, c1b] = await Promise.all([app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H("claim-key-1") }), app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H("claim-key-1") })]);
    expect([c1.statusCode, c1b.statusCode].sort()).toEqual([200, 202]);
    expect(c1.json().claimId).toBe(c1b.json().claimId);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM faucet_claims")).rows[0].n).toBe(1);
    expect(await sbx.rpc.callView(token, "storage_balance_of", { account_id: alice.accountId })).toBeNull(); // not registered yet
    await keeperPass(env.deps, "w1");
    const bal = async () => BigInt(await sbx.rpc.callView<string>(token, "ft_balance_of", { account_id: alice.accountId }));
    expect(await bal()).toBe(100_000_000n);
    expect(await sbx.rpc.callView(token, "storage_balance_of", { account_id: alice.accountId })).not.toBeNull(); // registered by faucet
    // replay with same key: no second claim, no second mint, even after "restart" (job re-run)
    expect((await app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H("claim-key-1") })).json().replayed).toBe(true);
    await fdb.db.query("UPDATE jobs SET state='queued', run_after=now(), lease_until=NULL WHERE kind='mint_tnoc'");
    await runOne(fdb.db, "w2", handlersFor(env.deps));
    expect(await bal()).toBe(100_000_000n);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM tx_journal WHERE op_key LIKE 'faucet-mint:%'")).rows[0].n).toBe(1);
    // quota: 250 per account, 100 each => third claim refused
    expect((await app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H("claim-key-2") })).statusCode).toBe(202);
    const third = await app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H("claim-key-3") });
    expect(third.statusCode).toBe(429); expect(third.json().error.code).toBe("account_quota");
    await keeperPass(env.deps, "w1");
    expect(await bal()).toBe(200_000_000n);
    // native spend recorded against the budget
    expect(BigInt((await fdb.db.query("SELECT COALESCE(SUM(yocto),0) s FROM native_spend")).rows[0].s)).toBeGreaterThan(1_250_000_000_000_000_000_000n);
  });

  it("faucet cooldown: key required; same-key replay returns the claim; fresh key is refused during cooldown and accepted after", async () => {
    const carol = await chain.createAccount("carol", 5n);
    const t = await login(app, carol); const H = (k?: string) => ({ authorization: `Bearer ${t}`, ...(k ? { "idempotency-key": k } : {}) });
    const claim = (k?: string) => app.inject({ method: "POST", url: "/v1/faucet/claim", headers: H(k) });
    env.cfg.faucet.cooldownSeconds = 3600; env.cfg.faucet.perAccountLimit = 1_000_000_000n;
    try {
      const noKey = await claim(); expect(noKey.statusCode).toBe(400); expect(noKey.json().error.code).toBe("idempotency_key_required");
      expect((await claim("short")).json().error.code).toBe("idempotency_key_required");
      const first = await claim("cooldown-key-1"); expect(first.statusCode).toBe(202);
      const replay = await claim("cooldown-key-1"); expect(replay.statusCode).toBe(200); expect(replay.json().claimId).toBe(first.json().claimId); expect(replay.json().replayed).toBe(true);
      const fresh = await claim("cooldown-key-2"); expect(fresh.statusCode).toBe(429); expect(fresh.json().error.code).toBe("cooldown");
      expect((await claim("cooldown-key-1")).statusCode).toBe(200); // replay is still allowed during cooldown
      await fdb.db.query("UPDATE faucet_claims SET created_at = now() - interval '2 hours' WHERE account_id=$1", [carol.accountId]); // cooldown elapsed
      const after = await claim("cooldown-key-2"); expect(after.statusCode).toBe(202); expect(after.json().claimId).not.toBe(first.json().claimId);
      expect((await fdb.db.query("SELECT COUNT(*)::int n FROM faucet_claims WHERE account_id=$1", [carol.accountId])).rows[0].n).toBe(2);
    } finally { env.cfg.faucet.cooldownSeconds = 0; env.cfg.faucet.perAccountLimit = 250_000_000n; }
  });

  it("a crash after a successful registration/mint but before native_spend was written is recovered from the journal", async () => {
    const dave = await chain.createAccount("dave", 5n);
    const t = await login(app, dave);
    const r = await app.inject({ method: "POST", url: "/v1/faucet/claim", headers: { authorization: `Bearer ${t}`, "idempotency-key": "recover-key-1" } });
    expect(r.statusCode).toBe(202);
    await fdb.db.query("UPDATE jobs SET state='cancelled' WHERE kind='mint_tnoc' AND state='queued' AND (payload->>'claimId') <> $1", [String(r.json().claimId)]); // other tests' pending claims
    const { TxExecutor } = await import("../src/near/tx.js");
    class CrashAfterReg extends TxExecutor {
      crashed = false;
      override async execute(op: string, job: string | null, k: any, rcv: string, a: any, d: string) {
        const out = await super.execute(op, job, k, rcv, a, d);
        if (op.startsWith("faucet-reg:") && !this.crashed) { this.crashed = true; throw new Error("simulated crash after registration succeeded"); }
        return out;
      }
    }
    const spendFor = async () => BigInt((await fdb.db.query("SELECT COALESCE(SUM(yocto),0) s FROM native_spend WHERE ref=(SELECT id::text FROM faucet_claims WHERE account_id=$1)", [dave.accountId])).rows[0].s);
    await runOne(fdb.db, "w1", handlersFor({ ...env.deps, tx: new CrashAfterReg(fdb.db, env.rpc, 60_000, 300) }));
    expect(await sbx.rpc.callView(token, "storage_balance_of", { account_id: dave.accountId })).not.toBeNull(); // registration really happened onchain
    expect(await spendFor()).toBe(0n);                                                                          // ...but was never recorded
    const st = await (await app.inject("/v1/faucet")).json();                                                    // any faucet read recovers it
    expect(BigInt(st.nativeSpentYocto)).toBeGreaterThanOrEqual(1_250_000_000_000_000_000_000n);
    expect(await spendFor()).toBeGreaterThanOrEqual(1_250_000_000_000_000_000_000n);
    await fdb.db.query("UPDATE jobs SET run_after=now(), lease_until=NULL WHERE kind='mint_tnoc' AND state<>'succeeded'");
    await runOne(fdb.db, "w2", handlersFor(env.deps));
    expect(BigInt(await sbx.rpc.callView<string>(token, "ft_balance_of", { account_id: dave.accountId }))).toBe(100_000_000n);
    const rows = (await fdb.db.query("SELECT purpose, COUNT(*)::int n FROM native_spend WHERE ref=(SELECT id::text FROM faucet_claims WHERE account_id=$1) GROUP BY purpose ORDER BY purpose", [dave.accountId])).rows;
    expect(rows).toEqual([{ purpose: "faucet_mint_fee", n: 1 }, { purpose: "faucet_registration", n: 1 }]); // no double counting
  });

  it("faucet reports a clear disabled state when the owner signer is unavailable, on non-test networks, and when the NEAR budget is spent", async () => {
    const noSigner = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: loadConfig({ ...process.env, DEPLOYER_ACCOUNT: admin.accountId, TOKEN_OWNER_ACCOUNT: admin.accountId, TOKEN_OWNER_CREDENTIALS_FILE: "", NEAR_NETWORK: "sandbox", FAUCET_TOKEN_ID: token } as any) });
    const s = (await noSigner.inject("/v1/faucet")).json();
    expect(s.enabled).toBe(false); expect(s.disabledReason).toMatch(/token-owner signer/);
    const t = await login(noSigner, alice);
    expect((await noSigner.inject({ method: "POST", url: "/v1/faucet/claim", headers: { authorization: `Bearer ${t}`, "idempotency-key": "disabled-key-1" } })).json().error.code).toBe("faucet_disabled");
    await noSigner.close();
    const main = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: { ...env.cfg, network: "mainnet" } });
    expect((await main.inject("/v1/faucet")).json().disabledReason).toMatch(/test networks/);
    await main.close();
    const bob = await chain.createAccount("bob", 5n);
    const broke = buildApp({ db: fdb.db, rpc: sbx.rpc, cfg: { ...env.cfg, faucet: { ...env.cfg.faucet, nearBudgetYocto: 1n } } });
    const tb = await login(broke, bob);
    expect((await broke.inject({ method: "POST", url: "/v1/faucet/claim", headers: { authorization: `Bearer ${tb}`, "idempotency-key": "budget-key-1" } })).json().error.code).toBe("native_budget");
    await broke.close();
  });
});
