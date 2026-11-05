const ref = { type: "string", description: "Stable backend market reference (network + contract + internal id)" };
const dec = { type: "string", pattern: "^\\d+$", description: "Decimal string, base units" };
const p = (name: string, where = "path") => ({ name, in: where, required: where === "path", schema: { type: "string" } });
const ok = (d: string) => ({ "200": { description: d } });
export const openapi = {
  openapi: "3.1.0",
  info: { title: "NearOdds backend API", version: "1.0.0", description: "Indexed read API, SSE updates, wallet auth, watchlists, administration and tNOC faucet. Amounts, prices and ids are decimal strings. Wallets sign all trades/deposits/redemptions/withdrawals; this API never holds user keys." },
  servers: [{ url: "http://localhost:4000" }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Session token from POST /v1/auth/verify" } },
    schemas: { MarketRef: ref, Decimal: dec, Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } },
  },
  paths: {
    "/v1/health": { get: { tags: ["Operations"], summary: "Liveness", responses: ok("ok") } },
    "/v1/ready": { get: { tags: ["Operations"], summary: "Readiness: database + indexer lag", responses: { ...ok("ready"), "503": { description: "not ready" } } } },
    "/v1/ops/status": { get: { tags: ["Operations"], summary: "Indexer lag, worker heartbeats, job counts, unresolved (uncertain) transactions", responses: ok("status") } },
    "/v1/markets": { get: { tags: ["Markets"], summary: "List markets", parameters: [p("q", "query"), p("category", "query"), p("status", "query"), p("sort", "query"), p("limit", "query"), p("offset", "query")], responses: ok("page of markets") } },
    "/v1/categories": { get: { tags: ["Markets"], summary: "Categories with counts", responses: ok("categories") } },
    "/v1/markets/{marketRef}": { get: { tags: ["Markets"], summary: "Market detail incl. contract account + internal market id for wallet calls, trust model, coverage", parameters: [p("marketRef")], responses: ok("market") } },
    "/v1/markets/{marketRef}/book": { get: { tags: ["Order book"], summary: "Separate YES/NO books built from onchain offers (executable only) + unfillable offers", parameters: [p("marketRef")], responses: ok("book") } },
    "/v1/markets/{marketRef}/trades": { get: { tags: ["History"], summary: "Confirmed fills", parameters: [p("marketRef"), p("limit", "query"), p("before", "query")], responses: ok("trades") } },
    "/v1/markets/{marketRef}/candles": { get: { tags: ["History"], summary: "Price candles from confirmed fills", parameters: [p("marketRef"), p("outcome", "query"), p("interval", "query")], responses: ok("candles") } },
    "/v1/markets/{marketRef}/activity": { get: { tags: ["History"], summary: "Market activity", parameters: [p("marketRef")], responses: ok("activity") } },
    "/v1/accounts/{accountId}/portfolio": { get: { tags: ["Accounts"], summary: "Balances (available/reserved/pending), positions, offers, withdrawals", parameters: [p("accountId")], responses: ok("portfolio") } },
    "/v1/accounts/{accountId}/offers": { get: { tags: ["Accounts"], summary: "Open offers", parameters: [p("accountId")], responses: ok("offers") } },
    "/v1/accounts/{accountId}/withdrawals": { get: { tags: ["Accounts"], summary: "Withdrawals with explicit status", parameters: [p("accountId")], responses: ok("withdrawals") } },
    "/v1/accounts/{accountId}/activity": { get: { tags: ["Accounts"], summary: "Account activity", parameters: [p("accountId")], responses: ok("activity") } },
    "/v1/stream": { get: { tags: ["Live"], summary: "Server-Sent Events: market_created, market_status, book, trade, account, heartbeat (all carry freshness)", parameters: [p("markets", "query"), p("account", "query")], responses: ok("event stream") } },
    "/v1/auth/challenge": { post: { tags: ["Auth"], summary: "NEP-413 challenge for an account", responses: ok("message, recipient, nonce") } },
    "/v1/auth/verify": { post: { tags: ["Auth"], summary: "Verify NEP-413 signature (base64), single-use nonce, full-access key", responses: ok("session token") } },
    "/v1/auth/session": { get: { tags: ["Auth"], security: [{ bearer: [] }], summary: "Current session", responses: ok("session") } },
    "/v1/auth/logout": { post: { tags: ["Auth"], security: [{ bearer: [] }], summary: "Logout", responses: ok("ok") } },
    "/v1/watchlist": { get: { tags: ["Watchlist"], security: [{ bearer: [] }], summary: "List saved markets", responses: ok("items") } },
    "/v1/watchlist/{marketRef}": { put: { tags: ["Watchlist"], security: [{ bearer: [] }], summary: "Add", parameters: [p("marketRef")], responses: ok("ok") }, delete: { tags: ["Watchlist"], security: [{ bearer: [] }], summary: "Remove", parameters: [p("marketRef")], responses: ok("ok") } },
    "/v1/faucet": { get: { tags: ["Faucet"], summary: "Faucet state (testnet tNOC only)", responses: ok("state") } },
    "/v1/faucet/claim": { post: { tags: ["Faucet"], security: [{ bearer: [] }], summary: "Claim tNOC (idempotent per Idempotency-Key)", responses: ok("claim") } },
    "/v1/admin/templates": { get: { tags: ["Admin"], security: [{ bearer: [] }], summary: "List templates", responses: ok("templates") }, post: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Create template", responses: ok("template") } },
    "/v1/admin/templates/{id}": { patch: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Enable/disable or update", parameters: [p("id")], responses: ok("template") } },
    "/v1/admin/jobs": { get: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Jobs + transaction journal", responses: ok("jobs") } },
    "/v1/admin/resolutions": { get: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Resolution proposals", responses: ok("proposals") }, post: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Propose outcome with evidence", responses: ok("proposal") } },
    "/v1/admin/resolutions/{id}/review": { post: { tags: ["Admin"], security: [{ bearer: [] }], summary: "Approve or reject a proposal", parameters: [p("id")], responses: ok("proposal") } },
  },
};
