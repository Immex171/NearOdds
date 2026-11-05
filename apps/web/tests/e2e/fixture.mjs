// A stateful stand-in for the NearOdds backend AND the chain, served from two DIFFERENT origins (so browser CORS is
// exercised). It mirrors apps/backend response shapes and the contracts' rules closely enough to drive the UI, with
// controls to inject lag, partial history, outages, a hanging withdrawal and newly published markets.
// It is a SIMULATION; real-contract evidence comes from tests/sandbox.test.ts.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const ONE = 1_000_000n;
const CUTOFF = "1794438000000000000";
const TRADING = { price_scale: "1000000", price_tick: "10000", min_price: "10000", max_price: "990000", quantity_lot: "100", min_order_quantity: "10000", max_open_offers_per_account: 10, fee_bps: 0 };
const TOKEN = "tok.testnet";

export async function startFixture({ webOrigin, apiPort = 4100, rpcPort = 4200 }) {
  const S = {
    height: 1000, lag: false, apiDown: false, rpcDown: false, partial: true, withdrawalMode: "complete", faucet: { enabled: true, cooldown: false, quota: false, claimsByKey: new Map(), claims: new Map(), posts: [] },
    hold: new Set(), tokenBal: new Map(), tokenReg: new Set(), txs: new Map(), nonce: 0, sessions: new Map(), watch: new Map(), sse: new Set(), fills: [], calls: [],
    contracts: new Map(), markets: [], idx: null,
  };
  const acct = () => ({ registered: true, available: 0n, reserved: 0n, yes: 0n, no: 0n, reservedYes: 0n, reservedNo: 0n, pending: null, wdSeq: 0, redeemed: false });
  function addMarket({ ref, contractId, question, category = "Weather", tag = "Lagos", source = "keeper", offers = [] }) {
    const c = { contractId, marketId: "mkt-1", tokenId: TOKEN, status: "Open", accounts: new Map(), offers: new Map(), next: 1, outcome: null };
    for (const o of offers) { c.offers.set(o.id, { id: o.id, owner: "lp.testnet", outcome: o.outcome, side: o.side, price: BigInt(o.price), remaining: BigInt(o.qty), qty: BigInt(o.qty) }); c.next = Math.max(c.next, Number(o.id) + 1); }
    const lp = acct(); c.accounts.set("lp.testnet", lp);
    S.contracts.set(contractId, c);
    S.markets.push({ ref, contractId, question, category, tag, source, createdAt: new Date().toISOString() });
    S.idx = snapshot();
    return ref;
  }
  const snapshot = () => structuredClone(S.contracts, { transfer: [] });
  const view = () => (S.lag && S.idx ? S.idx : S.contracts);
  const sync = () => { if (!S.lag) S.idx = snapshot(); };
  const hashOf = () => createHash("sha256").update(`tx${++S.nonce}`).digest("hex").slice(0, 44);

  // seed: two markets with the same internal market id AND overlapping local offer ids
  addMarket({ ref: "m_lagos", contractId: "mkt-lagos.testnet", question: "Will it rain in Lagos on 2026-11-12?", offers: [
    { id: "4", outcome: "Yes", side: "Sell", price: 650000, qty: 10_000_000 }, { id: "8", outcome: "Yes", side: "Sell", price: 700000, qty: 10_000_000 },
    { id: "5", outcome: "No", side: "Sell", price: 350000, qty: 10_000_000 }, { id: "9", outcome: "Yes", side: "Buy", price: 550000, qty: 10_000_000 } ] });
  addMarket({ ref: "m_snow", contractId: "mkt-snow.testnet", question: "Will it snow in Oslo on 2026-12-24?", category: "Weather", tag: "Oslo", offers: [
    { id: "4", outcome: "Yes", side: "Sell", price: 300000, qty: 7_000_000 }, { id: "9", outcome: "Yes", side: "Buy", price: 200000, qty: 7_000_000 } ] });
  // the second market's local ids 4 and 9 collide with the first on purpose
  S.markets[0].historyComplete = false; S.markets[1].historyComplete = true;
  S.lastTrade = new Map([["m_lagos", "650000"]]);
  S.fills.push({ ref: "m_lagos", id: "1", offerId: "4", outcome: "Yes", price: "650000", quantity: "100", collateral: "65", maker: "lp.testnet", taker: "probe.testnet", ts: BigInt(Date.now() - 3 * 3_600_000) * 1_000_000n });

  const fresh = () => ({ blockHeight: S.height, tipHeight: S.lag ? S.height + 80 : S.height, lagBlocks: S.lag ? 80 : 0, checkpointUpdatedAt: new Date().toISOString(), generatedAt: new Date().toISOString() });
  const cOf = (ref) => { const m = S.markets.find((x) => x.ref === ref); return m ? { m, c: view().get(m.contractId) } : null; };
  const quote = (c, outcome, ref) => {
    const open = [...c.offers.values()].filter((o) => o.outcome === outcome && o.remaining > 0n && c.status === "Open");
    const bids = open.filter((o) => o.side === "Buy").sort((a, b) => Number(b.price - a.price));
    const asks = open.filter((o) => o.side === "Sell").sort((a, b) => Number(a.price - b.price));
    const bid = bids[0]?.price ?? null, ask = asks[0]?.price ?? null;
    const last = [...S.fills].reverse().find((f) => f.ref === ref && f.outcome === outcome)?.price ?? null;
    let displayed = null, basis = "none";
    if (bid != null && ask != null && ask - bid <= 100000n) { displayed = String((bid + ask) / 2n); basis = "midpoint"; } else if (last) { displayed = last; basis = "last_trade"; }
    return { bestBid: bid?.toString() ?? null, bestAsk: ask?.toString() ?? null, lastTrade: last, displayed, basis };
  };
  const marketDto = (m) => {
    const c = view().get(m.contractId);
    const fills = S.fills.filter((f) => f.ref === m.ref);
    return {
      marketRef: m.ref, network: "testnet", contract: { contractId: m.contractId, marketId: "mkt-1", tokenId: TOKEN }, question: m.question, rules: "Observation period: the day. Trading closes first.", resolutionSource: "NiMet", category: m.category, tag: m.tag,
      token: { symbol: "tNOC", name: "NearOdds TEST Collateral (no value)", decimals: 6, isTestToken: true }, status: c.status === "Resolved" ? "Resolved" : c.status === "Awaiting" ? "AwaitingResolution" : "Open",
      uiStatus: c.status === "Resolved" ? "resolved" : c.status === "Awaiting" ? "awaiting" : "open", tradingOpen: c.status === "Open", tradingCutoff: { ns: CUTOFF, iso: "2026-11-11T23:00:00.000Z" },
      observation: { startNs: CUTOFF, endNs: "1794524400000000000", startIso: "2026-11-11T23:00:00.000Z", endIso: "2026-11-12T23:00:00.000Z" }, resolver: "resolver.testnet",
      resolution: c.status === "Resolved" ? { outcome: c.outcome, resolver_id: "resolver.testnet", resolved_at_ns: "1", evidence: "Reviewed NiMet report" } : null,
      trustModel: { model: "manual-trusted-resolver", summary: "One configured resolver account sets a final YES or NO once. No VOID or dispute path.", voidSupported: false, disputesSupported: false },
      trading: TRADING, volume: fills.reduce((a, f) => a + BigInt(f.collateral), 0n).toString(), tradeCount: fills.length, openOfferCount: [...c.offers.values()].filter((o) => o.remaining > 0n).length,
      quotes: { Yes: quote(c, "Yes", m.ref), No: quote(c, "No", m.ref) }, supply: { outstandingYes: "0", outstandingNo: "0", marketBacking: "0" }, source: m.source, templateId: null, occurrenceKey: null,
      createdAt: m.createdAt, verifiedAt: m.createdAt,
      coverage: { historyComplete: m.historyComplete ?? true, historyStartHeight: 1, indexedThrough: S.height, note: m.historyComplete === false ? "Trade history may be incomplete: events before the indexer's start are not reconstructible from contract views." : "Event history is complete from historyStartHeight." },
      reconcile: { ok: true, blockHeight: S.height, at: new Date().toISOString(), driftCount: 0 },
    };
  };
  const offerDto = (ref, o) => ({ offerId: o.id, offerRef: `${ref}:${o.id}`, owner: o.owner, price: o.price.toString(), remainingQuantity: o.remaining.toString(), originalQuantity: o.qty.toString(), expiresAtNs: null, createdAtNs: "1" });

  // ---------- API ----------
  const cors = (req, res) => { const o = req.headers.origin; if (o === webOrigin) { res.setHeader("access-control-allow-origin", o); res.setHeader("vary", "Origin"); } res.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key,last-event-id"); res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS"); };
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
  const sessionOf = (req) => { const h = req.headers.authorization; return h?.startsWith("Bearer ") ? S.sessions.get(h.slice(7)) : undefined; };
  const err = (res, code, c, message) => json(res, code, { error: { code: c, message } });

  const api = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, "http://x"); const p = u.pathname; const q = u.searchParams;
    if (p === "/v1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const client = { res, account: q.get("account"), url: req.url }; S.sse.add(client);
      res.write(`retry: 500\nevent: hello\ndata: ${JSON.stringify({ freshness: fresh(), resync: !!req.headers["last-event-id"] })}\n\n`);
      S.streamOpens = (S.streamOpens ?? []).concat(req.url);
      req.on("close", () => S.sse.delete(client));
      return;
    }
    if (S.apiDown) return err(res, 503, "rpc_unavailable", "backend temporarily unavailable");
    let m;
    if (p === "/v1/health") return json(res, 200, { status: "ok" });
    if (p === "/v1/markets") {
      let items = S.markets.map(marketDto);
      const qq = q.get("q")?.toLowerCase(); if (qq) items = items.filter((x) => x.question.toLowerCase().includes(qq) || x.contract.contractId.includes(qq));
      if (q.get("category")) items = items.filter((x) => x.category === q.get("category"));
      return json(res, 200, { items, page: { limit: 100, offset: 0, total: items.length }, freshness: fresh() });
    }
    if (p === "/v1/categories") { const n = new Map(); S.markets.forEach((x) => n.set(x.category, (n.get(x.category) ?? 0) + 1)); return json(res, 200, { items: [...n].map(([category, count]) => ({ category, count })) }); }
    if ((m = /^\/v1\/markets\/([^/]+)(?:\/(book|trades|candles|activity))?$/.exec(p))) {
      const x = cOf(m[1]); if (!x) return err(res, 404, "not_found", "market not found");
      const ref = m[1];
      if (!m[2]) return json(res, 200, { ...marketDto(x.m), resolutionStatus: { policy: "reviewed", provider: null, cutoffPassed: x.c.status !== "Open", observationComplete: false, evidence: "missing", note: null, lastCheckedAt: null, rule: "Separate conditions: the contract-enforced trading cutoff, completion of the observation period, and available reviewed evidence. Missing or ambiguous evidence never becomes NO." }, deployment: null, freshness: fresh() });
      if (m[2] === "book") {
        const side = (outcome) => { const open = [...x.c.offers.values()].filter((o) => o.outcome === outcome && o.remaining > 0n); const f = x.c.status === "Open";
          const bids = f ? open.filter((o) => o.side === "Buy").sort((a, b) => Number(b.price - a.price)).map((o) => offerDto(ref, o)) : []; const asks = f ? open.filter((o) => o.side === "Sell").sort((a, b) => Number(a.price - b.price)).map((o) => offerDto(ref, o)) : [];
          return { bids, asks, bidLevels: [], askLevels: [], empty: !bids.length && !asks.length }; };
        const unf = x.c.status === "Open" ? [] : [...x.c.offers.values()].filter((o) => o.remaining > 0n).map((o) => ({ ...offerDto(ref, o), outcome: o.outcome, side: o.side, reason: "market_closed", cancellable: true }));
        return json(res, 200, { marketRef: ref, contract: { contractId: x.m.contractId, marketId: "mkt-1" }, status: "Open", yes: side("Yes"), no: side("No"), unfillable: unf, note: "", freshness: fresh() });
      }
      if (m[2] === "trades") return json(res, 200, { items: [], nextBefore: null, freshness: fresh() });
      if (m[2] === "candles") {
        const fs = S.fills.filter((f) => f.ref === ref && f.outcome === q.get("outcome")); const candles = fs.map((f) => ({ startNs: (f.ts / 3_600_000_000_000n * 3_600_000_000_000n).toString(), open: f.price, high: f.price, low: f.price, close: f.price, volume: f.collateral, shares: f.quantity, trades: 1 }));
        return json(res, 200, { marketRef: ref, outcome: q.get("outcome") ?? "Yes", interval: "1h", methodology: "x", candles, freshness: fresh() });
      }
      return json(res, 200, { items: S.fills.filter((f) => f.ref === ref).map((f) => ({ id: f.id, marketRef: ref, account: f.taker, kind: "fill_taker", amount: f.collateral, detail: { price: f.price, quantity: f.quantity, outcome: f.outcome }, timestampNs: f.ts.toString(), receiptId: null })), freshness: fresh() });
    }
    if ((m = /^\/v1\/accounts\/([^/]+)\/(portfolio|offers|withdrawals|activity)$/.exec(p))) {
      const a = m[1]; const markets = []; const openOffers = []; const withdrawals = [];
      for (const mk of S.markets) { const c = view().get(mk.contractId); const ac = c.accounts.get(a); if (!ac) continue;
        markets.push({ marketRef: mk.ref, contract: { contractId: mk.contractId, marketId: "mkt-1" }, question: mk.question, status: c.status, registered: true, token: { symbol: "tNOC", decimals: 6 }, collateral: { available: ac.available.toString(), reserved: ac.reserved.toString(), pendingWithdrawal: ac.pending?.status === "Pending" ? ac.pending.amount.toString() : "0" },
          positions: { yes: { available: ac.yes.toString(), reserved: ac.reservedYes.toString(), total: (ac.yes + ac.reservedYes).toString() }, no: { available: ac.no.toString(), reserved: ac.reservedNo.toString(), total: (ac.no + ac.reservedNo).toString() } }, redeemed: ac.redeemed, lastReconciledHeight: S.height, driftNote: null, redeemHint: null });
        for (const o of c.offers.values()) if (o.owner === a && o.remaining > 0n) openOffers.push({ marketRef: mk.ref, offerId: o.id, offerRef: `${mk.ref}:${o.id}`, outcome: o.outcome, side: o.side, price: o.price.toString(), remainingQuantity: o.remaining.toString(), originalQuantity: o.qty.toString(), expiresAtNs: null, state: "open" });
        if (ac.pending) withdrawals.push({ marketRef: mk.ref, withdrawalId: ac.pending.id, withdrawalRef: `${mk.ref}:${ac.pending.id}`, amount: ac.pending.amount.toString(), status: ac.pending.status, receiver: a, requestedNs: "1", settledNs: null, confirmed: ac.pending.status !== "Pending" }); }
      if (m[2] === "portfolio") return json(res, 200, { accountId: a, markets, openOffers, withdrawals, freshness: fresh() });
      if (m[2] === "offers") return json(res, 200, { items: openOffers, freshness: fresh() });
      if (m[2] === "withdrawals") return json(res, 200, { items: withdrawals, freshness: fresh() });
      return json(res, 200, { items: [], freshness: fresh() });
    }
    if (p === "/v1/auth/challenge" && req.method === "POST") { const b = await readBody(req); const nonce = Buffer.alloc(32, S.nonce + 7).toString("base64"); return json(res, 200, { accountId: b.accountId, message: `Sign in to NearOdds as ${b.accountId}.`, recipient: "nearodds.app", nonce, nonceHex: "", expiresAt: "" }); }
    if (p === "/v1/auth/verify" && req.method === "POST") {
      const b = await readBody(req); S.verifyCalls = (S.verifyCalls ?? []).concat(b);
      if (Buffer.from(b.signature, "base64").toString() !== `sig:${b.nonce}`) return err(res, 401, "bad_signature", "signature does not verify");
      const token = `T${S.sessions.size + 1}-${b.accountId}`; S.sessions.set(token, { accountId: b.accountId });
      return json(res, 200, { token, accountId: b.accountId, expiresAt: "2099-01-01T00:00:00.000Z", isAdmin: false });
    }
    if (p === "/v1/auth/session") { const s = sessionOf(req); return s ? json(res, 200, { accountId: s.accountId, expiresAt: "2099-01-01T00:00:00.000Z", isAdmin: false }) : err(res, 401, "unauthenticated", "a valid session token is required"); }
    if (p === "/v1/auth/logout") { const h = req.headers.authorization?.slice(7); S.sessions.delete(h); S.loggedOut = (S.loggedOut ?? 0) + 1; return json(res, 200, { ok: true }); }
    if (p === "/v1/watchlist") { const s = sessionOf(req); if (!s) return err(res, 401, "unauthenticated", "sign in"); const w = S.watch.get(s.accountId) ?? new Set(); return json(res, 200, { items: [...w].map((r) => ({ marketRef: r, question: "", addedAt: "" })) }); }
    if ((m = /^\/v1\/watchlist\/([^/]+)$/.exec(p))) { const s = sessionOf(req); if (!s) return err(res, 401, "unauthenticated", "sign in"); const w = S.watch.get(s.accountId) ?? new Set(); req.method === "PUT" ? w.add(m[1]) : w.delete(m[1]); S.watch.set(s.accountId, w); return json(res, 200, { marketRef: m[1], watching: req.method === "PUT" }); }
    if (p === "/v1/faucet" && req.method === "GET") return json(res, 200, { enabled: S.faucet.enabled, disabledReason: S.faucet.enabled ? null : "token-owner signer is not available (TOKEN_OWNER_CREDENTIALS_FILE)", tokenId: TOKEN, amountPerClaim: "100000000", limits: { perAccount: "300000000", globalPer24h: "10000000000", cooldownSeconds: 60 }, globalClaimedLast24h: "0", nativeBudgetYocto: "1", nativeSpentYocto: "0", queuedClaims: 0, notice: "Test token with no value (tNOC)." });
    if (p === "/v1/faucet/claim" && req.method === "POST") {
      const s = sessionOf(req); if (!s) return err(res, 401, "unauthenticated", "sign in"); const key = req.headers["idempotency-key"];
      S.faucet.posts.push({ key, account: s.accountId });
      if (!key || key.length < 8) return err(res, 400, "idempotency_key_required", "send an Idempotency-Key header");
      if (S.faucet.dropResponse) { S.faucet.dropResponse = false; if (!S.faucet.claimsByKey.has(key)) { const id = `claim-${S.faucet.claims.size + 1}`; const c = { claimId: id, accountId: s.accountId, amount: "100000000", state: "queued", jobState: "queued" }; S.faucet.claims.set(id, c); S.faucet.claimsByKey.set(key, c); } res.writeHead(502); return res.end(); }
      const dup = S.faucet.claimsByKey.get(key); if (dup) return json(res, 200, { ...dup, replayed: true });
      if (S.faucet.cooldown) return err(res, 429, "cooldown", "wait 60s between claims");
      if (S.faucet.quota) return err(res, 429, "account_quota", "per-account limit reached");
      const id = `claim-${S.faucet.claims.size + 1}`; const c = { claimId: id, accountId: s.accountId, amount: "100000000", state: "queued", jobState: "queued" }; S.faucet.claims.set(id, c); S.faucet.claimsByKey.set(key, c);
      return json(res, 202, { ...c, replayed: false });
    }
    if ((m = /^\/v1\/faucet\/claims\/([^/]+)$/.exec(p))) { const c = S.faucet.claims.get(m[1]); return c ? json(res, 200, c) : err(res, 404, "not_found", "claim not found"); }
    if (p.startsWith("/__ctl/")) return json(res, 404, {});
    return err(res, 404, "not_found", "no such route");
  });

  // ---------- chain RPC + control ----------
  const FIRST = (c, a) => { let x = c.accounts.get(a); return x; };
  const needAcct = (c, who) => { const a = FIRST(c, who); if (!a) throw new Error("account is not registered"); return a; };
  const pv = (c, o) => ({ offer_id: o.id, market_id: "mkt-1", owner_id: o.owner, outcome: o.outcome, side: o.side, price: o.price.toString(), quantity: o.qty.toString(), remaining_quantity: o.remaining.toString(), expires_at_ns: null, created_at_ns: "1", status: "Open", fillable: c.status === "Open" });
  const accView = (c, who) => { const a = c.accounts.get(who); return a ? { account_id: who, storage_deposit: "1", available_collateral: a.available.toString(), reserved_collateral: a.reserved.toString(), yes: a.yes.toString(), no: a.no.toString(), reserved_yes: a.reservedYes.toString(), reserved_no: a.reservedNo.toString(), pending_withdrawal: a.pending ? { withdrawal_id: a.pending.id, receiver_id: who, amount: a.pending.amount.toString(), status: a.pending.status } : null } : null; };
  const marketView = (c) => ({ market_id: "mkt-1", question: S.markets.find((m) => m.contractId === c.contractId).question, rules: "Observation period: the day. Trading closes first.", resolution_source: "NiMet", split_cutoff_ns: CUTOFF, split_open: c.status === "Open", trading_cutoff_ns: CUTOFF, trading_open: c.status === "Open", status: c.status === "Resolved" ? "Resolved" : c.status === "Awaiting" ? "AwaitingResolution" : "Open", awaiting_resolution: c.status === "Awaiting", resolved: c.status === "Resolved", merge_open: c.status !== "Resolved", resolver_id: "resolver.testnet", resolution: c.status === "Resolved" ? { outcome: c.outcome, resolver_id: "resolver.testnet", resolved_at_ns: "1", evidence: "Reviewed NiMet report" } : null, collateral_token_id: TOKEN });
  const preview = (c, who) => { const a = c.accounts.get(who); const win = a ? (c.outcome === "Yes" ? a.yes + a.reservedYes : a.no + a.reservedNo) : 0n; const lose = a ? (c.outcome === "Yes" ? a.no + a.reservedNo : a.yes + a.reservedYes) : 0n; const rel = a ? a.reserved : 0n; return { redeemable: c.status === "Resolved" && (win + lose + rel > 0n), outcome: c.outcome, winning_shares: win.toString(), losing_shares: lose.toString(), payout: win.toString(), released_collateral: rel.toString(), released_shares: "0", offers_to_release: [], available_collateral_after: ((a?.available ?? 0n) + win + rel).toString() }; };
  const views = {
    get_config: (c) => ({ schema_version: 3, market_id: "mkt-1", collateral_token_id: TOKEN, resolver_id: "resolver.testnet", decimals: 6, deposit_msg: "deposit", storage_cost_per_account: "40960000000000000000000", resolution_model: "manual", trading: TRADING }),
    get_market: (c) => marketView(c),
    get_account: (c, a) => accView(c, a.account_id),
    get_account_offers: (c, a) => [...c.offers.values()].filter((o) => o.owner === a.account_id && o.remaining > 0n).map((o) => pv(c, o)),
    get_offer: (c, a) => { const o = c.offers.get(a.offer_id); return o && o.remaining > 0n ? pv(c, o) : null; },
    get_redemption_preview: (c, a) => preview(c, a.account_id),
  };
  const tokenViews = { ft_metadata: () => ({ name: "NearOdds TEST Collateral (no value)", symbol: "tNOC", decimals: 6 }), storage_balance_bounds: () => ({ min: "1250000000000000000000", max: null }),
    ft_balance_of: (a) => (S.tokenBal.get(a.account_id) ?? 0n).toString(), storage_balance_of: (a) => (S.tokenReg.has(a.account_id) ? { total: "1250000000000000000000", available: "0" } : null) };

  const price = (p, q) => (p * q) / ONE;
  function apply(signer, receiver, method, args) {
    if (receiver === TOKEN) {
      if (method === "storage_deposit") { S.tokenReg.add(args.account_id); return null; }
      if (method === "ft_transfer_call") {
        const c = S.contracts.get(args.receiver_id); const amount = BigInt(args.amount); if (!c) throw new Error("unknown receiver");
        const bal = S.tokenBal.get(signer) ?? 0n; if (bal < amount) throw new Error("insufficient token balance");
        const a = c.accounts.get(signer); if (!a) return String(0n); // market refunds an unregistered depositor
        S.tokenBal.set(signer, bal - amount); a.available += amount; return String(amount);
      }
      throw new Error(`token: unexpected ${method}`);
    }
    const c = S.contracts.get(receiver); if (!c) throw new Error(`unknown contract ${receiver}`);
    if (method === "storage_deposit") { if (!c.accounts.has(signer)) c.accounts.set(signer, acct()); return null; }
    const a = needAcct(c, signer);
    const needMarket = () => { if (args.market_id !== "mkt-1") throw new Error("wrong market_id"); };
    if (method === "split_position") { needMarket(); if (c.status !== "Open") throw new Error("trading is closed"); const n = BigInt(args.amount); if (a.available < n) throw new Error("insufficient available collateral"); a.available -= n; a.yes += n; a.no += n; return null; }
    if (method === "merge_positions") { needMarket(); const n = BigInt(args.amount); if (a.yes < n || a.no < n) throw new Error("insufficient YES/NO shares"); a.yes -= n; a.no -= n; a.available += n; return null; }
    if (method === "create_offer") {
      needMarket(); if (c.status !== "Open") throw new Error("trading is closed"); const p = BigInt(args.price), q = BigInt(args.quantity);
      if (args.side === "Buy") { const cost = price(p, q); if (a.available < cost) throw new Error("insufficient available collateral"); a.available -= cost; a.reserved += cost; }
      else { const k = args.outcome === "Yes" ? "yes" : "no"; if (a[k] < q) throw new Error("insufficient YES/NO shares"); a[k] -= q; a[args.outcome === "Yes" ? "reservedYes" : "reservedNo"] += q; }
      const id = String(c.next++); c.offers.set(id, { id, owner: signer, outcome: args.outcome, side: args.side, price: p, remaining: q, qty: q }); return pv(c, c.offers.get(id));
    }
    if (method === "fill_offer") {
      if (c.status !== "Open") throw new Error("trading is closed"); const o = c.offers.get(args.offer_id); if (!o || o.remaining <= 0n) throw new Error("offer not found"); const q = BigInt(args.quantity);
      if (o.owner === signer) throw new Error("you cannot fill your own offer"); if (q > o.remaining) throw new Error("fill quantity exceeds remaining"); const cost = price(o.price, q); const maker = c.accounts.get(o.owner);
      const k = o.outcome === "Yes" ? "yes" : "no", rk = o.outcome === "Yes" ? "reservedYes" : "reservedNo";
      if (o.side === "Sell") { if (a.available < cost) throw new Error("insufficient available collateral"); a.available -= cost; a[k] += q; maker[rk] -= q; maker.available += cost; }
      else { if (a[k] < q) throw new Error("insufficient YES/NO shares"); a[k] -= q; a.available += cost; maker.reserved -= cost; maker[k] += q; }
      o.remaining -= q; const ref = S.markets.find((m) => m.contractId === receiver).ref;
      S.fills.push({ ref, id: String(S.fills.length + 1), offerId: o.id, outcome: o.outcome, price: o.price.toString(), quantity: q.toString(), collateral: cost.toString(), maker: o.owner, taker: signer, ts: BigInt(Date.now()) * 1_000_000n });
      return { offer_id: o.id, quantity: q.toString(), collateral_amount: cost.toString(), remaining_quantity: o.remaining.toString(), status: o.remaining === 0n ? "Filled" : "PartiallyFilled" };
    }
    if (method === "cancel_offer") {
      const o = c.offers.get(args.offer_id); if (!o || o.remaining <= 0n) throw new Error("offer not found"); if (o.owner !== signer) throw new Error("only the owner can cancel");
      let rc = 0n, rs = 0n; if (o.side === "Buy") { rc = price(o.price, o.remaining); a.reserved -= rc; a.available += rc; } else { rs = o.remaining; const k = o.outcome === "Yes" ? "yes" : "no"; a[o.outcome === "Yes" ? "reservedYes" : "reservedNo"] -= rs; a[k] += rs; }
      o.remaining = 0n; return { offer_id: o.id, released_collateral: rc.toString(), released_shares: rs.toString() };
    }
    if (method === "withdraw") {
      const n = BigInt(args.amount); if (a.available < n) throw new Error("insufficient available collateral"); if (a.pending?.status === "Pending") throw new Error("a withdrawal is already pending");
      a.available -= n; a.wdSeq += 1; const id = String(a.wdSeq);
      if (S.withdrawalMode === "complete") { a.pending = { id, amount: n, status: "Completed" }; S.tokenBal.set(signer, (S.tokenBal.get(signer) ?? 0n) + n); }
      else if (S.withdrawalMode === "fail") { a.pending = { id, amount: n, status: "FailedRestored" }; a.available += n; }
      else a.pending = { id, amount: n, status: "Pending" };
      return a.pending.status;
    }
    if (method === "redeem") {
      needMarket(); if (c.status !== "Resolved") throw new Error("the market is not resolved yet"); const p = preview(c, signer); if (!p.redeemable) throw new Error("nothing to redeem");
      a.available += BigInt(p.payout) + BigInt(p.released_collateral); a.reserved = 0n; a.yes = a.no = a.reservedYes = a.reservedNo = 0n; a.redeemed = true;
      for (const o of c.offers.values()) if (o.owner === signer) o.remaining = 0n;
      return { payout: p.payout, released_collateral: p.released_collateral, released_shares: "0" };
    }
    throw new Error(`unexpected method ${method}`);
  }

  const emit = (type, payload) => { for (const cl of S.sse) { if (type === "account" && cl.account !== payload.account) continue; cl.res.write(`event: ${type}\ndata: ${JSON.stringify({ ...payload, freshness: fresh() })}\n\n`); } };
  const okOutcome = (value) => ({ status: { SuccessValue: Buffer.from(JSON.stringify(value ?? null)).toString("base64") }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] });
  const failOutcome = (msg) => ({ status: { SuccessValue: "" }, final_execution_status: "FINAL", receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${msg}` } } } } } } }] });

  const rpc = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const b = await readBody(req);
    if (req.url === "/__tx") { // the fake wallet sends here
      const hash = hashOf(); S.calls.push({ signer: b.signer, receiver: b.receiver, method: b.method, args: b.args, deposit: b.deposit, gas: b.gas, hash });
      let out; try { out = okOutcome(apply(b.signer, b.receiver, b.method, b.args)); S.height += 3; sync(); } catch (e) { out = failOutcome(e.message); }
      S.txs.set(hash, out); return json(res, 200, { transaction_outcome: { id: hash } });
    }
    if (req.url.startsWith("/__ctl/")) {
      const k = req.url.slice(7);
      const ctl = {
        state: () => ({ calls: S.calls, faucetPosts: S.faucet.posts, verifyCalls: S.verifyCalls ?? [], streamOpens: S.streamOpens ?? [], loggedOut: S.loggedOut ?? 0, watch: Object.fromEntries([...S.watch].map(([a, w]) => [a, [...w]])), sseClients: S.sse.size, tokenBal: Object.fromEntries([...S.tokenBal].map(([a, v]) => [a, v.toString()])) }),
        set: () => { Object.assign(S, b); if ("lag" in b) sync(); return {}; },
        setFaucet: () => { Object.assign(S.faucet, b); return {}; },
        mint: () => { S.tokenReg.add(b.account); S.tokenBal.set(b.account, (S.tokenBal.get(b.account) ?? 0n) + BigInt(b.amount)); return {}; },
        register: () => { S.tokenReg.add(b.account); return {}; },
        publish: () => { addMarket(b); emit("market_created", { marketRef: b.ref }); return {}; },
        close: () => { S.contracts.get(b.contractId).status = "Awaiting"; sync(); emit("market_status", { marketRef: b.ref }); return {}; },
        resolve: () => { const c = S.contracts.get(b.contractId); c.status = "Resolved"; c.outcome = b.outcome; sync(); emit("market_status", { marketRef: b.ref }); return {}; },
        emit: () => { emit(b.type, b.payload ?? {}); return {}; },
        sync: () => { S.idx = snapshot(); return {}; },
        finishWithdrawal: () => { const c = S.contracts.get(b.contractId); const a = c.accounts.get(b.account); a.pending.status = "Completed"; S.tokenBal.set(b.account, (S.tokenBal.get(b.account) ?? 0n) + a.pending.amount); sync(); return {}; },
        completeFaucetClaim: () => { const c = S.faucet.claims.get(b.id); c.state = b.state ?? "minted"; if (c.state === "minted") S.tokenBal.set(c.accountId, (S.tokenBal.get(c.accountId) ?? 0n) + BigInt(c.amount)); return {}; },
        dropSse: () => { for (const cl of S.sse) cl.res.destroy(); return {}; },
      }[k];
      return json(res, 200, ctl ? ctl() : { error: "unknown" });
    }
    if (S.rpcDown) return json(res, 500, { error: { message: "rpc down" } });
    const { method, params } = b; const ok = (result) => json(res, 200, { jsonrpc: "2.0", id: 1, result });
    if (method === "block") return ok({ header: { height: S.height } });
    if (method === "tx") { if (S.hold.has(params.tx_hash)) return ok(undefined); return ok(S.txs.get(params.tx_hash)); }
    if (method === "query" && params.request_type === "view_account") return ok({ amount: "5000000000000000000000000" });
    if (method === "query") {
      const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString()); const wrap = (v) => ok({ result: [...Buffer.from(JSON.stringify(v))] });
      if (params.account_id === TOKEN) return wrap(tokenViews[params.method_name](args));
      const c = S.contracts.get(params.account_id); if (!c) return json(res, 200, { jsonrpc: "2.0", id: 1, result: { error: `account ${params.account_id} does not exist` } });
      return wrap(views[params.method_name](c, args));
    }
    return json(res, 200, { jsonrpc: "2.0", id: 1, error: { message: `unsupported ${method}` } });
  });
  await Promise.all([new Promise((r) => api.listen(apiPort, r)), new Promise((r) => rpc.listen(rpcPort, r))]);
  const ctl = (name, body = {}) => fetch(`http://localhost:${rpcPort}/__ctl/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  return { apiUrl: `http://localhost:${apiPort}`, rpcUrl: `http://localhost:${rpcPort}`, ctl, state: () => ctl("state"), S, stop: () => { for (const c of S.sse) c.res.destroy(); api.close(); rpc.close(); } };
}
