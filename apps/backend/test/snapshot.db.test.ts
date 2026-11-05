import { prereq } from "./helpers/prereq.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, freshDb } from "./helpers/db.js";
import { Rpc } from "../src/near/rpc.js";
import { Indexer, resolveRange } from "../src/indexer/runner.js";
import { reconcileMarket } from "../src/indexer/reconcile.js";
import { block as blockH, ev, fakeNeardata, link } from "./helpers/fake-chain.js";
import { NdBlock } from "../src/indexer/neardata.js";

const ok = await prereq();
const M = "mkt-s.testnet";
const block = (h: number, logs: string[], id = `r${h}`) => blockH(h, [{ id, logs }], M);
const U = (n: number) => String(Math.round(n * 1_000_000));

/** A minimal contract-view server: answers get_market/list_offers/get_account/get_withdrawal from a state object. */
function fakeViewsRpc(state: { offers: any[]; accounts: Record<string, any> }) {
  const f = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    if (body.method === "query" && body.params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
      let out: any = null;
      switch (body.params.method_name) {
        case "get_market": out = { status: "Open", resolution: null, outstanding_yes: U(50), outstanding_no: U(50), market_backing: U(50) }; break;
        case "list_offers": out = state.offers.filter((o) => o.outcome === args.outcome && o.side === args.side).slice(Number(args.from_index), Number(args.from_index) + args.limit); break;
        case "get_account": out = state.accounts[args.account_id] ?? null; break;
        case "get_withdrawal": out = null; break;
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from(JSON.stringify(out))], logs: [] } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "X", message: "unsupported" } }));
  }) as unknown as typeof fetch;
  return new Rpc({ url: "http://views.test", retries: 0, fetchImpl: f });
}
const acct = (id: string, o: Record<string, string>) => ({ account_id: id, available_collateral: "0", reserved_collateral: "0", yes: "0", no: "0", reserved_yes: "0", reserved_no: "0", pending_withdrawal: null, ...o });
const offerView = (o: Record<string, string>) => ({ market_id: "mkt-1", expires_at_ns: null, created_at_ns: "1", filled_quantity: "0", reserved_collateral: "0", reserved_shares: "0", status: "Open", fillable: true, ...o });

describe.skipIf(!ok)("snapshot boundaries: history never rewrites a newer snapshot", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    fdb = await freshDb();
    await fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at)
      VALUES ('m_snap','testnet',$1,'mkt-1','tok','Q','r','s','1900000000000000000','res','{"symbol":"t","decimals":6,"name":"t"}','{}','keeper', now())`, [M]);
  });
  afterAll(async () => { await fdb?.drop(); });

  it("import -> reconcile at H -> unseen receipts before H (history only) -> receipt after H (changes snapshot)", async () => {
    // Chain truth AT H=100 (already includes the effects of the two pre-H receipts below):
    //  offer 1: alice sells 10 YES @0.60, 4 filled by bob  => remaining 6, reserved_shares 6, alice +2.4 collateral
    //  offer 2: bob bids 5 YES @0.50 (reserved collateral 2.5)
    const state = {
      offers: [
        offerView({ offer_id: "1", owner_id: "alice.testnet", outcome: "Yes", side: "Sell", price: "600000", quantity: U(10), filled_quantity: U(4), remaining_quantity: U(6), reserved_shares: U(6), status: "PartiallyFilled" }),
        offerView({ offer_id: "2", owner_id: "bob.testnet", outcome: "Yes", side: "Buy", price: "500000", quantity: U(5), remaining_quantity: U(5), reserved_collateral: U(2.5) }),
      ],
      accounts: {
        "alice.testnet": acct("alice.testnet", { available_collateral: U(52.4), yes: U(40), reserved_yes: U(6) }),
        "bob.testnet": acct("bob.testnet", { available_collateral: U(47.6 - 2.5 + 0), reserved_collateral: U(2.5), yes: U(4) }),
      },
    };
    const rpc = fakeViewsRpc(state);
    const rep = await reconcileMarket(fdb.db, rpc, "m_snap", 100);
    expect(rep.skipped).toBeUndefined();
    const snapshot = async () => ({
      accounts: (await fdb.db.query("SELECT account_id, available_collateral a, reserved_collateral rc, yes, reserved_yes ry FROM account_state ORDER BY account_id")).rows,
      offers: (await fdb.db.query("SELECT offer_id, state, remaining, reserved_shares rs, reserved_collateral rc FROM offers ORDER BY offer_id::numeric")).rows,
    });
    const before = await snapshot();
    expect(before.offers).toEqual([{ offer_id: "1", state: "open", remaining: U(6), rs: U(6), rc: "0" }, { offer_id: "2", state: "open", remaining: U(5), rs: "0", rc: U(2.5) }]);

    // unseen receipts from BEFORE H
    const pre: NdBlock[] = [
      block(90, [ev("offer_created", { offer_id: "1", owner_id: "alice.testnet", market_id: "mkt-1", outcome: "Yes", side: "Sell", price: "600000", quantity: U(10), expires_at_ns: null, reserved_collateral: "0", reserved_shares: U(10) })]),
      block(92, [ev("offer_created", { offer_id: "2", owner_id: "bob.testnet", market_id: "mkt-1", outcome: "Yes", side: "Buy", price: "500000", quantity: U(5), expires_at_ns: null, reserved_collateral: U(2.5), reserved_shares: "0" })]),
      block(95, [ev("offer_filled", { offer_id: "1", maker_id: "alice.testnet", taker_id: "bob.testnet", market_id: "mkt-1", outcome: "Yes", maker_side: "Sell", price: "600000", quantity: U(4), collateral_amount: U(2.4), remaining_quantity: U(6) })]),
    ];
    const idx = new Indexer(fdb.db, fakeNeardata(new Map(), () => 0), {});
    expect(await idx.processBlocks(pre)).toBe(3);
    // they ARE history ...
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM chain_events")).rows[0].n).toBe(3);
    expect((await fdb.db.query("SELECT COUNT(*)::int c, SUM(collateral_amount) v FROM fills")).rows[0]).toEqual({ c: 1, v: U(2.4) });
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM activity WHERE kind IN ('offer_created','fill_maker','fill_taker')")).rows[0].n).toBe(4);
    // ... but the snapshot (collateral, shares, offer quantities AND reserves) is untouched
    expect(await snapshot()).toEqual(before);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM stream_events WHERE type IN ('trade','book')")).rows[0].n).toBe(0); // no live notifications for history

    // receipts AFTER H change the snapshot exactly once
    const post: NdBlock[] = [
      block(105, [ev("offer_filled", { offer_id: "1", maker_id: "alice.testnet", taker_id: "bob.testnet", market_id: "mkt-1", outcome: "Yes", maker_side: "Sell", price: "600000", quantity: U(2), collateral_amount: U(1.2), remaining_quantity: U(4) })]),
      block(106, [ev("offer_filled", { offer_id: "2", maker_id: "bob.testnet", taker_id: "alice.testnet", market_id: "mkt-1", outcome: "Yes", maker_side: "Buy", price: "500000", quantity: U(1), collateral_amount: U(0.5), remaining_quantity: U(4) })]),
    ];
    expect(await idx.processBlocks(post)).toBe(2);
    expect(await idx.processBlocks(post)).toBe(0); // replay
    const after = await snapshot();
    expect(after.offers).toEqual([{ offer_id: "1", state: "open", remaining: U(4), rs: U(4), rc: "0" }, { offer_id: "2", state: "open", remaining: U(4), rs: "0", rc: U(2) }]);
    const a = after.accounts.find((x: any) => x.account_id === "alice.testnet"), b = after.accounts.find((x: any) => x.account_id === "bob.testnet");
    // alice: +1.2 (sold 2 yes from reserve) ; then sold 1 yes into bob's bid: +0.5 collateral, yes -1
    expect([a.a, a.ry, a.yes]).toEqual([U(52.4 + 1.2 + 0.5), U(4), U(39)]);
    // bob: bought 2 yes (+2 yes) paying 1.2 ; bid 1 filled: reserved 2.5->2.0, +1 yes
    expect([b.rc, b.yes]).toEqual([U(2), U(4 + 2 + 1)]);
    expect((await fdb.db.query("SELECT COUNT(*)::int c, SUM(collateral_amount) v FROM fills")).rows[0]).toEqual({ c: 3, v: U(4.1) }); // each fill counted once
    // an older, stale reconcile must refuse to overwrite the newer snapshot
    const stale = await reconcileMarket(fdb.db, rpc, "m_snap", 101);
    expect(stale.skipped).toMatch(/stale reconcile/);
    expect(await snapshot()).toEqual(after);
  });
});

describe.skipIf(!ok)("participant discovery is independent of the snapshot boundary", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    fdb = await freshDb();
    await fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at)
      VALUES ('m_part','testnet',$1,'mkt-1','tok','Q','r','s','1900000000000000000','res','{"symbol":"t","decimals":6,"name":"t"}','{}','keeper', now())`, [M]);
  });
  afterAll(async () => { await fdb?.drop(); });

  it("Alice holds collateral and shares, has no open offer, and is found only by historical backfill: her portfolio ends up equal to the contract, with no double counting", async () => {
    // contract truth at H=100: Alice deposited 30 and split 10 BEFORE the snapshot boundary; she has no offers. Bob has an open offer.
    const state = {
      offers: [offerView({ offer_id: "1", owner_id: "bob.testnet", outcome: "Yes", side: "Sell", price: "600000", quantity: U(5), remaining_quantity: U(5), reserved_shares: U(5) })],
      accounts: {
        "alice.testnet": acct("alice.testnet", { available_collateral: U(20), yes: U(10), no: U(10) }),
        "bob.testnet": acct("bob.testnet", { available_collateral: U(5), yes: U(0), reserved_yes: U(5), no: U(5) }),
      } as Record<string, any>,
    };
    const rpc = fakeViewsRpc(state);
    await reconcileMarket(fdb.db, rpc, "m_part", 100);                          // import-time snapshot: only Bob is discoverable (open offer)
    const accounts = async () => (await fdb.db.query("SELECT account_id, available_collateral a, yes, no FROM account_state WHERE market_ref='m_part' ORDER BY account_id")).rows;
    expect((await accounts()).map((x: any) => x.account_id)).toEqual(["bob.testnet"]);          // Alice is invisible: her portfolio would look empty

    const idx = new Indexer(fdb.db, fakeNeardata(new Map(), () => 0), {});
    const history: NdBlock[] = [
      block(80, [ev("storage_registered", { account_id: "alice.testnet", payer_id: "alice.testnet", storage_deposit_yocto: "1" })]),
      block(82, [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(30) })]),
      block(85, [ev("split", { account_id: "alice.testnet", market_id: "mkt-1", amount: U(10) })]),
    ];
    expect(await idx.processBlocks(history)).toBe(3);
    // discovered through history, but history must not move any balance
    expect((await fdb.db.query("SELECT account_id, hydrated_at FROM market_participants WHERE market_ref='m_part' AND account_id='alice.testnet'")).rows).toEqual([{ account_id: "alice.testnet", hydrated_at: null }]);
    expect((await accounts()).map((x: any) => x.account_id)).toEqual(["bob.testnet"]);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM chain_events WHERE market_ref='m_part'")).rows[0].n).toBe(3);
    // hydrate at a consistent block: the contract's numbers, exactly
    const rep = await reconcileMarket(fdb.db, rpc, "m_part", 100);
    expect(rep.skipped).toBeUndefined();
    expect(await accounts()).toEqual([{ account_id: "alice.testnet", a: U(20), yes: U(10), no: U(10) }, { account_id: "bob.testnet", a: U(5), yes: "0", no: U(5) }]);
    expect((await fdb.db.query("SELECT hydrated_at IS NOT NULL h FROM market_participants WHERE market_ref='m_part' AND account_id='alice.testnet'")).rows[0].h).toBe(true);
    // replaying the same history changes nothing (no double counting)
    expect(await idx.processBlocks(history)).toBe(0);
    expect((await accounts()).find((x: any) => x.account_id === "alice.testnet")).toEqual({ account_id: "alice.testnet", a: U(20), yes: U(10), no: U(10) });
    // a LATER event is applied exactly once on top of the hydrated balance
    const later: NdBlock[] = [block(110, [ev("merge", { account_id: "alice.testnet", market_id: "mkt-1", amount: U(4) })])];
    expect(await idx.processBlocks(later)).toBe(1); expect(await idx.processBlocks(later)).toBe(0);
    expect((await accounts()).find((x: any) => x.account_id === "alice.testnet")).toEqual({ account_id: "alice.testnet", a: U(24), yes: U(6), no: U(6) });
    // the API says so while she was not yet hydrated
    state.accounts["carol.testnet"] = acct("carol.testnet", { available_collateral: U(3) });
    await idx.processBlocks([block(90, [ev("deposit", { account_id: "carol.testnet", token_id: "t", amount: U(3) })])]);
    const { buildApp } = await import("../src/api/app.js"); const { loadConfig } = await import("../src/config/index.js");
    const app = buildApp({ db: fdb.db, rpc, cfg: loadConfig({ DATABASE_URL: "x" } as any) });
    const pf = (await app.inject("/v1/accounts/carol.testnet/portfolio")).json();
    expect(pf.pendingHydration).toEqual(["m_part"]); expect(pf.markets).toEqual([]);
    await reconcileMarket(fdb.db, rpc, "m_part", 110);
    const pf2 = (await app.inject("/v1/accounts/carol.testnet/portfolio")).json();
    expect(pf2.pendingHydration).toEqual([]); expect(pf2.markets[0].collateral.available).toBe(U(3));
    await app.close();
  });
});

describe.skipIf(!ok)("history gaps: proven skips vs unavailable provider data", () => {
  let fdb: Awaited<ReturnType<typeof freshDb>>;
  const mkMarket = (ref: string, contract: string) => fdb.db.query(`INSERT INTO markets(market_ref, network, contract_id, internal_market_id, token_id, question, rules, resolution_source, cutoff_ns, resolver_id, token_meta, config, source, verified_at, history_start_height)
      VALUES ($1,'testnet',$2,'mkt-1','tok','Q','r','s','1900000000000000000','res','{"symbol":"t","decimals":6,"name":"t"}','{}','keeper', now(), 100)`, [ref, contract]);
  beforeAll(async () => { fdb = await freshDb(); });
  afterAll(async () => { await fdb?.drop(); });

  const dep = (h: number, id: string, who = "alice.testnet") => block(h, [ev("deposit", { account_id: who, token_id: "t", amount: U(1) })], id);
  const mk = (h: number, logs: string[]) => blockH(h, [{ id: `g${h}`, logs }], "mkt-g.testnet");

  it("resolveRange: a genuinely skipped height is proven by chain linkage", async () => {
    const chain = new Map<number, NdBlock>([[100, mk(100, [])], [101, mk(101, [])], [103, mk(103, [])]]); link(chain); // 103 links to 101: 102 was skipped
    const r = await resolveRange(fakeNeardata(chain, () => 103), 101, 103);
    expect(r.skipped).toEqual([102]); expect(r.gaps).toEqual([]);
  });
  it("resolveRange: a height the provider lacks but the chain links to is an UNRESOLVED gap, never 'skipped'", async () => {
    const chain = new Map<number, NdBlock>([[100, mk(100, [])], [101, mk(101, [])], [102, mk(102, [])], [103, mk(103, [])]]); link(chain); // 103 links to 102
    const r = await resolveRange(fakeNeardata(chain, () => 103, { unavailable: new Set([102]) }), 101, 103);
    expect(r.skipped).toEqual([]); expect(r.gaps.map((g) => [g.from, g.to])).toEqual([[102, 102]]);
  });
  it("trailing misses use a forward anchor; no anchor means unresolved", async () => {
    const chain = new Map<number, NdBlock>([[101, mk(101, [])], [104, mk(104, [])]]); link(chain); // 104 links to 101: 102,103 skipped
    expect((await resolveRange(fakeNeardata(chain, () => 104), 101, 103)).skipped).toEqual([102, 103]);
    const none = new Map<number, NdBlock>([[101, mk(101, [])]]); link(none);
    expect((await resolveRange(fakeNeardata(none, () => 101), 101, 103)).gaps.map((g) => [g.from, g.to])).toEqual([[102, 103]]);
  });

  it("indexer keeps historyComplete=false while a gap is open; the gap's events are ingested once the provider has the block", async () => {
    await mkMarket("m_gap", "mkt-g.testnet");
    const chain = new Map<number, NdBlock>([
      [100, mk(100, [])],
      [101, mk(101, [ev("storage_registered", { account_id: "alice.testnet", payer_id: "alice.testnet", storage_deposit_yocto: "1" })])],
      [102, mk(102, [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(7) })])],      // provider is missing this block (not a skip)
      [104, mk(104, [ev("deposit", { account_id: "alice.testnet", token_id: "t", amount: U(1) })])],      // 103 genuinely skipped
    ]); link(chain);
    const unavailable = new Set([102]);
    const idx = new Indexer(fdb.db, fakeNeardata(chain, () => 104, { unavailable }), { startHeight: 101, batch: 50 });
    for (let i = 0; i < 4; i++) await idx.step();
    expect(await idx.checkpoint()).toBe(104);
    const gaps = (await fdb.db.query("SELECT scope, from_height, to_height FROM index_gaps WHERE resolved_at IS NULL")).rows;
    expect(gaps).toEqual([{ scope: "main", from_height: "102", to_height: "102" }]);   // 103 is NOT a gap (proven skipped)
    const m = (await fdb.db.query("SELECT history_complete, indexed_through FROM markets WHERE market_ref='m_gap'")).rows[0];
    expect(m.history_complete).toBe(false);
    expect((await idx.status()).openGaps).toBe(1);
    // provider catches up with the missing block
    unavailable.clear();
    await fdb.db.query("UPDATE index_gaps SET last_attempt_at = now() - interval '2 hours'");
    for (let i = 0; i < 3; i++) await idx.step();
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM index_gaps WHERE resolved_at IS NULL")).rows[0].n).toBe(0);
    expect((await fdb.db.query("SELECT COUNT(*)::int n FROM chain_events WHERE block_height=102")).rows[0].n).toBe(1);
    expect((await fdb.db.query("SELECT history_complete FROM markets WHERE market_ref='m_gap'")).rows[0].history_complete).toBe(true);
  });
});
