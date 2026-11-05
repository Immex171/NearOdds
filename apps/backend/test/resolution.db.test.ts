import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { ProviderRegistry, ResolutionError, proposeResolution, resolutionTick, reviewProposal, type SourceProvider } from "../src/keeper/resolution.js";

const ok = await prereq();
const NOW = Date.UTC(2026, 10, 14); // after observation end of Nov 12 market
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

describe.skipIf(!ok)("resolution workflow (no chain)", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>;
  const mk = async (ref: string, obsEnd: number | null, policy = "reviewed", provider: string | null = null) => {
    await fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, observation_end_ns, token_meta, config, source, verified_at)
      VALUES ($1,'testnet',$2,'mkt-1','t','Q','r','s',$3,'res.testnet',$4,'{"symbol":"t","decimals":6,"name":"t"}','{}','keeper',now())`, [ref, `${ref}.testnet`, ns(Date.UTC(2026, 10, 11, 23)), obsEnd ? ns(obsEnd) : null]);
    await fdb.db.query("INSERT INTO resolution_watch(market_ref, policy, provider) VALUES ($1,$2,$3)", [ref, policy, provider]);
  };
  const tick = (providers: ProviderRegistry, now = NOW) => resolutionTick({ db: fdb.db, providers, now: () => now } as any, now);
  const jobs = async () => (await fdb.db.query("SELECT dedupe_key FROM jobs WHERE kind='resolve_market'")).rows.length;
  beforeAll(async () => { fdb = await freshDb(); });
  afterAll(async () => { await fdb?.drop(); });

  it("tracks cutoff, observation completion and evidence separately; reviewed markets without evidence stay pending (never NO)", async () => {
    await mk("m_lagos", Date.UTC(2026, 10, 12, 23));
    // before the observation ends: cutoff passed but observation not complete
    await tick(new ProviderRegistry(), Date.UTC(2026, 10, 12, 12));
    let w = (await fdb.db.query("SELECT * FROM resolution_watch WHERE market_ref='m_lagos'")).rows[0];
    expect([w.cutoff_passed, w.observation_complete, w.evidence_state]).toEqual([true, false, "missing"]);
    // after: observation complete, still no evidence => nothing is proposed or submitted
    await tick(new ProviderRegistry());
    w = (await fdb.db.query("SELECT * FROM resolution_watch WHERE market_ref='m_lagos'")).rows[0];
    expect([w.cutoff_passed, w.observation_complete, w.evidence_state]).toEqual([true, true, "missing"]);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM resolution_proposals")).rows[0].n).toBe(0);
    expect(await jobs()).toBe(0);
  });

  it("proposal rules: bounded evidence, retrieval after observation, one live proposal, four-eyes with multiple admins", async () => {
    const base = { marketRef: "m_lagos", outcome: "Yes" as const, evidenceRef: "https://nimet.example/r", retrievedAt: new Date(NOW), proposedBy: "a.testnet" };
    const code = async (o: object) => proposeResolution(fdb.db, { ...base, ...o } as any, new Date(NOW)).then(() => "ok", (e) => (e as ResolutionError).code);
    expect(await code({ evidenceRef: "   " })).toBe("bad_evidence");
    expect(await code({ evidenceRef: "x".repeat(513) })).toBe("bad_evidence");
    expect(await code({ outcome: "Maybe" })).toBe("bad_outcome");
    expect(await code({ retrievedAt: new Date(Date.UTC(2026, 10, 12, 10)) })).toBe("evidence_too_early");
    expect(await code({ retrievedAt: new Date(NOW + 3_600_000) })).toBe("bad_retrieved_at");
    const p = await proposeResolution(fdb.db, base, new Date(NOW));
    expect(await code({})).toBe("proposal_exists");
    await expect(reviewProposal(fdb.db, p.id, "a.testnet", "approved", "self", 2)).rejects.toMatchObject({ code: "self_approval" });
    await tick(new ProviderRegistry());
    expect(await jobs()).toBe(0); // pending proposals never submit
    await reviewProposal(fdb.db, p.id, "b.testnet", "approved", "ok", 2);
    expect((await tick(new ProviderRegistry())).enqueued).toEqual(["m_lagos"]);
    expect(await jobs()).toBe(1);
    await tick(new ProviderRegistry()); // idempotent
    expect(await jobs()).toBe(1);
  });

  it("rejected proposals free the slot and revert evidence to missing", async () => {
    await mk("m_rej", Date.UTC(2026, 10, 12, 23));
    const p = await proposeResolution(fdb.db, { marketRef: "m_rej", outcome: "No", evidenceRef: "e", retrievedAt: new Date(NOW), proposedBy: "a.testnet" }, new Date(NOW));
    await reviewProposal(fdb.db, p.id, "a.testnet", "rejected", "wrong source", 1);
    expect((await fdb.db.query("SELECT evidence_state FROM resolution_watch WHERE market_ref='m_rej'")).rows[0].evidence_state).toBe("missing");
    await proposeResolution(fdb.db, { marketRef: "m_rej", outcome: "Yes", evidenceRef: "e2", retrievedAt: new Date(NOW), proposedBy: "a.testnet" }, new Date(NOW));
  });

  it("automatic providers: only an explicit deterministic OK resolves; pending, ambiguous, errors and unregistered providers never become NO", async () => {
    let next: any = { status: "pending", note: "report not published yet" };
    const prov: SourceProvider = { id: "fixture", decisionRule: "rain_mm > 0 => Yes else No, only when the report exists", fetch: async () => { if (next === "throw") throw new Error("upstream 503"); return next; } };
    const reg = new ProviderRegistry().register(prov);
    await mk("m_auto", Date.UTC(2026, 10, 12, 23), "automatic", "fixture");
    const state = async () => (await fdb.db.query("SELECT evidence_state, note FROM resolution_watch WHERE market_ref='m_auto'")).rows[0];
    const live = async () => (await fdb.db.query("SELECT * FROM resolution_proposals WHERE market_ref='m_auto'")).rows.length;
    await tick(reg); expect(await state()).toMatchObject({ evidence_state: "missing", note: "report not published yet" }); expect(await live()).toBe(0);
    next = { status: "ambiguous", note: "two conflicting readings" };
    await tick(reg); expect(await state()).toMatchObject({ evidence_state: "ambiguous" }); expect(await live()).toBe(0);
    next = "throw";
    await tick(reg); expect((await state()).evidence_state).toBe("provider_error"); expect(await live()).toBe(0);
    await tick(new ProviderRegistry()); expect((await state()).note).toMatch(/not registered/);
    next = { status: "ok", outcome: "No", evidenceRef: "https://source.example/report#2026-11-12", observedAt: new Date(NOW) };
    const before = await jobs();
    expect((await tick(reg)).enqueued).toEqual(["m_auto"]);
    expect(await jobs()).toBe(before + 1);
    const p = (await fdb.db.query("SELECT * FROM resolution_proposals WHERE market_ref='m_auto'")).rows[0];
    expect([p.outcome, p.decision, p.proposed_by, p.provider]).toEqual(["No", "approved", "provider:fixture", "fixture"]);
  });
});
