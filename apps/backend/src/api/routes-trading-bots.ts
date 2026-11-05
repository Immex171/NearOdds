import type { FastifyInstance } from "fastify";
import { requireAdmin, type Ctx } from "./app.js";
import { HttpError, intParam } from "./http.js";
import { BotConfig, NewBot } from "../trading-bot/config.js";
import { readSnapshot, summarize } from "../trading-bot/chain.js";
import { decide } from "../trading-bot/decide.js";
import { loadFacts, loadBot, type BotRow } from "../trading-bot/ops.js";
import { credentialsConfigured, executionNetworkAllowed } from "../trading-bot/signer.js";
import { gatherStateFacts, deriveState } from "../trading-bot/state.js";
import { RpcUnavailableError } from "../near/rpc.js";
import { withTx } from "../db/index.js";

const ser = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

async function validateConfig(ctx: Ctx, network: string, raw: unknown): Promise<BotConfig> {
  const p = BotConfig.safeParse(raw);
  if (!p.success) throw new HttpError(400, "invalid_config", "bot configuration failed validation", p.error.issues);
  for (const m of p.data.markets) {
    const row = (await ctx.db.query("SELECT network FROM markets WHERE market_ref=$1", [m.marketRef])).rows[0];
    if (!row) throw new HttpError(400, "unknown_market", `market ${m.marketRef} is not in the registry`);
    if (row.network !== network) throw new HttpError(400, "network_mismatch", `market ${m.marketRef} is on ${row.network}, the bot on ${network}`);
  }
  return p.data;
}

export async function botStatus(ctx: Ctx, bot: BotRow) {
  const { db, cfg } = ctx;
  const credsOk = credentialsConfigured(bot);
  const execAllowed = cfg.bot.executionEnabled && executionNetworkAllowed(bot.network) && bot.network === cfg.network;
  const facts = await gatherStateFacts(db, bot.id, credsOk, execAllowed);
  const live = deriveState(bot, facts);
  const st = (await db.query("SELECT * FROM bot_market_status WHERE bot_id=$1", [bot.id])).rows;
  const mk = (await db.query("SELECT market_ref, contract_id, internal_market_id, token_id, network, question FROM markets WHERE market_ref = ANY($1)", [bot.config.markets.map((m) => m.marketRef)])).rows;
  const quotes = (await db.query("SELECT * FROM bot_quotes WHERE bot_id=$1 AND state='active' ORDER BY market_ref, offer_id::numeric", [bot.id])).rows;
  const pend = (await db.query("SELECT id, market_ref, kind, slot, op_key, state, tx_hash, reason, created_at FROM bot_operations WHERE bot_id=$1 AND state IN ('proposed','submitted','uncertain') ORDER BY id", [bot.id])).rows;
  const spent = (await db.query("SELECT COALESCE(SUM(yocto),0) s FROM bot_native_spend WHERE bot_id=$1", [bot.id])).rows[0].s;
  const alloc = (await db.query("SELECT market_ref, COALESCE(SUM((params->>'amount')::numeric),0) s FROM bot_operations WHERE bot_id=$1 AND kind='deposit' AND state='confirmed' GROUP BY market_ref", [bot.id])).rows;
  const lastDec = (await db.query("SELECT DISTINCT ON (market_ref) market_ref, id, outcome, reasons, actions, created_at FROM bot_decisions WHERE bot_id=$1 ORDER BY market_ref, id DESC", [bot.id])).rows;
  const fillCount = (await db.query("SELECT COUNT(*)::int n, COALESCE(SUM(collateral_amount),0) v FROM fills WHERE maker_id=$1 OR taker_id=$1", [bot.account_id])).rows[0];
  const now = Date.now();
  // Markets removed from the configuration stay visible (cancellation/reconciliation only) until their quotes and operations are gone.
  const inCfg = new Set(bot.config.markets.map((m) => m.marketRef));
  const extra = new Set<string>();
  for (const q of quotes) if (!inCfg.has(q.market_ref)) extra.add(q.market_ref);
  for (const o of pend) if (!inCfg.has(o.market_ref)) extra.add(o.market_ref);
  const extraRows = extra.size ? (await db.query("SELECT market_ref, contract_id, internal_market_id, token_id, network, question FROM markets WHERE market_ref = ANY($1)", [[...extra]])).rows : [];
  mk.push(...extraRows);
  const entries = [...bot.config.markets.map((m) => ({ ...m, removed: false })), ...[...extra].map((r) => ({ marketRef: r, enabled: false, reference: null, quantityPerQuote: undefined, removed: true }))];
  return {
    id: bot.id, slug: bot.slug,
    account: { accountId: bot.account_id, network: bot.network, credentialsConfigured: credsOk },
    mode: bot.mode, desiredState: bot.desired_state, state: live.state, stateReason: live.reason, configVersion: bot.config_version,
    execution: { enabledByEnvironment: cfg.bot.executionEnabled, networkAllowed: executionNetworkAllowed(bot.network) && bot.network === cfg.network, note: "Real transactions are sent only in execute mode, with BOT_EXECUTION_ENABLED=true, on Sandbox or testnet, with verified credentials." },
    limits: bot.config.limits, strategy: bot.config.strategy, funding: bot.config.funding,
    spending: { nativeSpentYocto: String(spent), nativeLimitYocto: bot.config.limits.maxNativeSpendYocto, collateralDepositedByMarket: Object.fromEntries(alloc.map((a: any) => [a.market_ref, String(a.s)])) },
    markets: entries.map((m) => {
      const s = st.find((x: any) => x.market_ref === m.marketRef); const row = mk.find((x: any) => x.market_ref === m.marketRef); const d = lastDec.find((x: any) => x.market_ref === m.marketRef);
      const scale = 1_000_000n;
      return {
        marketRef: m.marketRef, enabled: m.enabled, removedFromConfig: m.removed, question: row?.question ?? null,
        contract: row ? { contractId: row.contract_id, marketId: row.internal_market_id, tokenId: row.token_id } : null,
        reference: m.reference ? { yesPrice: m.reference.yesPrice, noPrice: (scale - BigInt(m.reference.yesPrice)).toString(), label: m.reference.label, source: m.reference.source, asOf: m.reference.asOf, expiresAt: m.reference.expiresAt, expired: now >= Date.parse(m.reference.expiresAt), note: "A strategy input, not an independent probability estimate." } : null,
        lastChainRead: s ? { at: s.last_chain_read_at, blockHeight: s.block_height === null ? null : Number(s.block_height) } : null,
        balances: s?.snapshot ? { collateral: s.snapshot.collateral, shares: s.snapshot.shares, tokenBalance: s.snapshot.tokenBalance, nativeBalanceYocto: s.snapshot.nativeBalanceYocto, registeredWithToken: s.snapshot.registeredWithToken, registeredWithMarket: s.snapshot.registeredWithMarket } : null,
        position: s?.snapshot?.redemption ?? null,
        needsFunding: s?.needs_funding ?? false,
        openQuotes: quotes.filter((q: any) => q.market_ref === m.marketRef).map((q: any) => ({ offerId: q.offer_id, offerRef: `${q.market_ref}:${q.offer_id}`, slot: q.slot, price: q.price, quantity: q.quantity, remaining: q.remaining, expiresAtNs: q.expires_at_ns, origin: q.origin })),
        lastDecision: d ? { id: d.id, outcome: d.outcome, at: d.created_at, reasons: d.reasons, actions: d.actions } : null,
      };
    }),
    pendingOperations: pend.map((p: any) => ({ id: p.id, marketRef: p.market_ref, kind: p.kind, slot: p.slot, opKey: p.op_key, state: p.state, txHash: p.tx_hash })),
    fills: { count: fillCount.n, volume: String(fillCount.v), note: "From the indexer; may lag the chain." },
  };
}

async function persistState(ctx: Ctx, bot: BotRow) {
  const cur = (await ctx.db.query("SELECT * FROM trading_bots WHERE id=$1", [bot.id])).rows[0];
  const credsOk = credentialsConfigured(cur);
  const execAllowed = ctx.cfg.bot.executionEnabled && executionNetworkAllowed(cur.network) && cur.network === ctx.cfg.network;
  const s = deriveState(cur, await gatherStateFacts(ctx.db, cur.id, credsOk, execAllowed));
  await ctx.db.query("UPDATE trading_bots SET state=$2, state_reason=$3 WHERE id=$1", [cur.id, s.state, s.reason]);
}

export function registerTradingBotRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, cfg } = ctx;
  const base = "/v1/admin/trading-bots";
  const get = async (id: string) => { const b = await loadBot(db, id); if (!b) throw new HttpError(404, "not_found", "bot not found"); return b; };

  app.get(base, async (req) => {
    await requireAdmin(ctx, req);
    const bots = (await db.query("SELECT * FROM trading_bots ORDER BY id")).rows as BotRow[];
    return { items: await Promise.all(bots.map(async (b) => { const s = await botStatus(ctx, b); return { id: s.id, slug: s.slug, account: s.account, mode: s.mode, desiredState: s.desiredState, state: s.state, stateReason: s.stateReason, configVersion: s.configVersion, markets: s.markets.length }; })) };
  });

  app.post(base, async (req, reply) => {
    const s = await requireAdmin(ctx, req);
    const p = NewBot.safeParse(req.body);
    if (!p.success) throw new HttpError(400, "invalid_config", "bot failed validation", p.error.issues);
    const others = [cfg.deployer.accountId, cfg.resolver.accountId, cfg.tokenOwner.accountId];
    if (others.includes(p.data.accountId)) throw new HttpError(400, "account_not_distinct", "the bot account must differ from the deployer, resolver and token-owner accounts");
    const config = await validateConfig(ctx, p.data.network, p.data.config);
    try {
      const r = await db.query("INSERT INTO trading_bots(slug, account_id, network, credentials_env, config, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [p.data.slug, p.data.accountId, p.data.network, p.data.credentialsEnv, JSON.stringify(config), s.accountId]);
      await db.query("INSERT INTO trading_bot_configs(bot_id, version, config, created_by) VALUES ($1,1,$2,$3)", [r.rows[0].id, JSON.stringify(config), s.accountId]);
      return reply.code(201).send(ser(await botStatus(ctx, r.rows[0])));
    } catch (e: any) { if (e.code === "23505") throw new HttpError(409, "slug_exists", "a bot with this slug exists"); throw e; }
  });

  app.get(`${base}/:id`, async (req) => { await requireAdmin(ctx, req); return ser(await botStatus(ctx, await get((req.params as any).id))); });

  /** New decisions use the new version; operations already proposed keep the version they were recorded with. */
  app.put(`${base}/:id/config`, async (req) => {
    const s = await requireAdmin(ctx, req);
    const bot = await get((req.params as any).id);
    const config = await validateConfig(ctx, bot.network, (req.body as any)?.config ?? req.body);
    const v = bot.config_version + 1;
    await db.query("UPDATE trading_bots SET config=$2, config_version=$3, updated_at=now() WHERE id=$1", [bot.id, JSON.stringify(config), v]);
    await db.query("INSERT INTO trading_bot_configs(bot_id, version, config, created_by) VALUES ($1,$2,$3,$4)", [bot.id, v, JSON.stringify(config), s.accountId]);
    return ser(await botStatus(ctx, (await get(bot.id))));
  });

  /** Proposed quotes WITHOUT trading or persisting anything. Evaluates "as if running" against a fresh finalized snapshot. */
  app.post(`${base}/:id/preview`, async (req) => {
    await requireAdmin(ctx, req);
    const bot = await get((req.params as any).id);
    const out = [];
    for (const m of bot.config.markets) {
      const row = (await db.query("SELECT market_ref, network, contract_id, internal_market_id, token_id, cutoff_ns FROM markets WHERE market_ref=$1", [m.marketRef])).rows[0];
      try {
        const snap = await readSnapshot(ctx.rpc, row, bot.account_id);
        const facts = await loadFacts(db, bot, m.marketRef);
        const dec = decide({ nowMs: Date.now(), snap, facts: { ...facts, desired: "running", hasPendingOps: facts.hasPendingOps }, cfg: bot.config, marketRef: m.marketRef });
        out.push({ marketRef: m.marketRef, blockHeight: snap.blockHeight, outcome: dec.outcome, legs: dec.legs, referenceNo: dec.referenceNo, actions: dec.actions, reasons: dec.reasons, snapshot: summarize(snap) });
      } catch (e) {
        if (e instanceof RpcUnavailableError) out.push({ marketRef: m.marketRef, outcome: "skipped", actions: [], reasons: [{ code: "chain_unavailable", message: e.message }] });
        else throw e;
      }
    }
    return ser({ botId: bot.id, configVersion: bot.config_version, tradedNothing: true, markets: out });
  });

  app.post(`${base}/:id/start`, async (req) => {
    await requireAdmin(ctx, req);
    const bot = await get((req.params as any).id);
    const mode = (req.body as any)?.mode ?? "paper";
    if (mode !== "paper" && mode !== "execute") throw new HttpError(400, "bad_request", "mode must be paper|execute");
    if (mode === "execute") {
      if (!cfg.bot.executionEnabled) throw new HttpError(409, "execution_disabled", "BOT_EXECUTION_ENABLED is not set for this environment");
      if (!executionNetworkAllowed(bot.network) || bot.network !== cfg.network) throw new HttpError(409, "network_not_allowed", "execution is allowed only on Sandbox or testnet matching the worker's network");
      if (!credentialsConfigured(bot)) throw new HttpError(409, "setup_required", `credentials not configured (env ${bot.credentials_env})`);
    }
    // Atomic with proposals/signing (they hold a SHARE lock on this row): leaving execute mode is only possible when nothing is live.
    await withTx(db, async (c) => {
      const cur = (await c.query("SELECT mode FROM trading_bots WHERE id=$1 FOR UPDATE", [bot.id])).rows[0];
      if (cur.mode === "execute" && mode === "paper") {
        const w = (await c.query("SELECT (SELECT COUNT(*) FROM bot_operations WHERE bot_id=$1 AND state IN ('proposed','submitted','uncertain'))::int ops, (SELECT COUNT(*) FROM bot_quotes WHERE bot_id=$1 AND state='active')::int quotes", [bot.id])).rows[0];
        if (w.ops > 0 || w.quotes > 0) throw new HttpError(409, "outstanding_work", `cannot switch to paper mode while ${w.ops} operation(s) are unresolved and ${w.quotes} quote(s) are live. Stop the bot, wait until it reports "stopped", then start it in paper mode.`, w);
      }
      await c.query("UPDATE trading_bots SET mode=$2, desired_state='running', updated_at=now() WHERE id=$1", [bot.id, mode]);
    });
    await persistState(ctx, bot);
    return ser(await botStatus(ctx, await get(bot.id)));
  });

  const stopLike = (path: "pause" | "stop", desired: "paused" | "stopped") => app.post(`${base}/:id/${path}`, async (req) => {
    await requireAdmin(ctx, req);
    const bot = await get((req.params as any).id);
    // In ONE transaction (the signing guard locks the same rows in the same order): set the desired state, then cancel every
    // operation that has no signed transaction yet. Anything already signed stays tracked and is reconciled by the worker.
    await withTx(db, async (c) => {
      await c.query("UPDATE trading_bots SET desired_state=$2, updated_at=now() WHERE id=$1", [bot.id, desired]);
      await c.query(`UPDATE bot_operations o SET state='cancelled', failure=$2, updated_at=now()
                     WHERE bot_id=$1 AND state IN ('proposed','submitted') AND kind <> 'cancel_offer' AND NOT EXISTS (SELECT 1 FROM tx_journal j WHERE j.op_key=o.op_key)`, [bot.id, `cancelled before signing: ${path} requested`]);
    });
    // 3. the worker cancels remaining quotes; the state stays pausing/stopping until nothing is unresolved
    await persistState(ctx, bot);
    return ser(await botStatus(ctx, await get(bot.id)));
  });
  stopLike("pause", "paused"); stopLike("stop", "stopped");

  const list = (name: string, sql: string, map: (r: any) => unknown, byAccount = false) => app.get(`${base}/:id/${name}`, async (req) => {
    await requireAdmin(ctx, req);
    const bot = await get((req.params as any).id); const limit = intParam((req.query as any).limit, 50, 1, 200);
    const q = sql.replace("$LIMIT", String(limit));
    return ser({ items: (await db.query(q, [byAccount ? bot.account_id : bot.id])).rows.map(map) });
  });
  list("orders", "SELECT * FROM bot_quotes WHERE bot_id=$1 ORDER BY created_at DESC LIMIT $LIMIT", (q) => ({ marketRef: q.market_ref, offerId: q.offer_id, offerRef: `${q.market_ref}:${q.offer_id}`, slot: q.slot, price: q.price, quantity: q.quantity, remaining: q.remaining, state: q.state, closeReason: q.close_reason, origin: q.origin, createdAt: q.created_at, closedAt: q.closed_at }));
  list("fills", "SELECT f.*, m.contract_id FROM fills f JOIN markets m USING (market_ref) WHERE (f.maker_id=$1 OR f.taker_id=$1) ORDER BY f.id DESC LIMIT $LIMIT", (f) => ({ marketRef: f.market_ref, tradeId: f.id, offerId: f.offer_id, outcome: f.outcome, price: f.price, quantity: f.quantity, collateralAmount: f.collateral_amount, role: f.maker_id === f.taker_id ? "both" : "maker/taker", maker: f.maker_id, taker: f.taker_id, blockHeight: Number(f.block_height), timestampNs: f.ts_ns }), true);
  list("decisions", "SELECT * FROM bot_decisions WHERE bot_id=$1 ORDER BY id DESC LIMIT $LIMIT", (d) => ({ id: d.id, marketRef: d.market_ref, configVersion: d.config_version, mode: d.mode, outcome: d.outcome, actions: d.actions, reasons: d.reasons, opIds: d.op_ids, blockHeight: d.block_height === null ? null : Number(d.block_height), at: d.created_at }));
  list("operations", "SELECT * FROM bot_operations WHERE bot_id=$1 ORDER BY id DESC LIMIT $LIMIT", (o) => ({ id: o.id, marketRef: o.market_ref, kind: o.kind, slot: o.slot, generation: o.generation, opKey: o.op_key, configVersion: o.config_version, state: o.state, txHash: o.tx_hash, offerId: o.offer_id, reason: o.reason, failure: o.failure, params: o.params, createdAt: o.created_at }));
}
