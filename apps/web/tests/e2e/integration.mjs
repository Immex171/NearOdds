// Browser integration: the REAL built frontend (origin :3100) talking to a backend+chain stand-in on OTHER origins
// (:4100 API, :4200 RPC), so CORS is exercised. Wallet = the build-time test seam (NEXT_PUBLIC_E2E_WALLET=1).
// Build + run:  pnpm e2e:integration   (builds into .next-e2e, starts the server, runs this, stops it)
import { chromium } from "playwright-core";
import { startFixture } from "./fixture.mjs";

const WEB = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const shots = process.env.SHOTS_DIR;
const fx = await startFixture({ webOrigin: WEB });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? " — " + extra : ""}`); };
const T = 10n ** 12n;
const calls = () => fx.state().then((s) => s.calls);
const body = (p) => p.locator("body").innerText();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(viewport = { width: 1440, height: 900 }, opts = {}) {
  const ctx = await browser.newContext({ viewport, ...opts });
  await ctx.addInitScript(({ rpc }) => {
    window.__walletCalls = []; window.__rejectNext = false;
    window.__e2eWallet = {
      get accountId() { return localStorage.getItem("__e2eAccount") || null; },
      async signAndSendTransaction(p) {
        if (window.__rejectNext) { window.__rejectNext = false; throw new Error("User rejected the request"); }
        const a = p.actions[0].params;
        window.__walletCalls.push({ receiver: p.receiverId, method: a.methodName, args: a.args, deposit: a.deposit, gas: a.gas });
        const r = await fetch(rpc + "/__tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer: localStorage.getItem("__e2eAccount"), receiver: p.receiverId, method: a.methodName, args: a.args, deposit: a.deposit, gas: a.gas }) });
        return r.json();
      },
      async signMessage({ message, recipient, nonce }) {
        window.__signed = { message, recipient, nonceLen: nonce.length, nonceIsBytes: nonce instanceof Uint8Array };
        return { accountId: localStorage.getItem("__e2eAccount"), publicKey: "ed25519:E2E", signature: btoa("sig:" + btoa(String.fromCharCode(...nonce))) };
      },
    };
  }, { rpc: fx.rpcUrl });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|503|500/.test(m.text())) errors.push(m.text()); });
  page.errors = errors; page.ctx = ctx;
  return page;
}
const as = (page, who) => page.evaluate((w) => (w ? localStorage.setItem("__e2eAccount", w) : localStorage.removeItem("__e2eAccount")), who);
const wcalls = (page) => page.evaluate(() => window.__walletCalls);
const waitText = (page, re, timeout = 15000) => page.waitForFunction((s) => new RegExp(s, "i").test(document.body.innerText), re.source, { timeout });

async function fundsAction(page, kind, amount) {
  await page.locator(`#${kind}-amt`).fill(String(amount));
  await page.getByRole("button", { name: "Review" }).nth(kind === "deposit" ? 0 : 1).click();
  await page.getByRole("button", { name: new RegExp(`Confirm ${kind}`) }).click();
}
async function pickMarket(page, ref) { await page.getByTestId("market-picker").selectOption(ref); await page.waitForFunction((r) => document.querySelector('[data-testid="funds-panel"]')?.getAttribute("data-market") === r, ref); }

// =====================================================================================================================
// 1. Discovery, categories, search, price semantics (no wallet)
// =====================================================================================================================
{
  const page = await newPage();
  await page.goto(WEB);
  await page.waitForSelector("article");
  check("origins differ (web :3100, API :4100, RPC :4200) and the API answers cross-origin", (await page.locator("article").count()) === 2);
  check("live mode banner, not demo", /NEAR testnet/.test(await page.getByTestId("mode-banner").innerText()));
  check("category nav is built from the backend (Weather), not a fixed list", (await page.getByRole("navigation", { name: "Categories" }).innerText()).includes("Weather") && !(await page.getByRole("navigation", { name: "Categories" }).innerText()).includes("Crypto"));
  await page.goto(`${WEB}/markets?category=Weather`); await page.waitForSelector("article");
  check("a backend category such as Weather lists its markets", (await page.locator("article").count()) === 2);

  // server-backed search
  await page.goto(WEB); await page.waitForSelector("article");
  await page.getByRole("combobox", { name: "Search markets" }).first().fill("oslo");
  await page.getByRole("option").first().waitFor();
  check("search queries the backend (finds the Oslo market)", /Oslo/.test(await page.getByRole("option").first().innerText()));

  // price semantics on the Lagos market
  await page.goto(`${WEB}/markets/m_lagos`);
  await page.waitForFunction(() => /ASKS/.test(document.body.innerText) && /0\.65/.test(document.body.innerText), null, { timeout: 20000 });
  const lagos = await body(page);
  check("headline 60% is labelled as the MIDPOINT of bid/ask", /60%/.test(await page.getByTestId("headline-price").innerText()) && /midpoint of the best bid and ask/.test(await page.getByTestId("price-basis").innerText()));
  check("last YES trade (0.65) is shown separately and is not the headline", /0\.65 tNOC/.test(await page.getByTestId("last-yes-trade").innerText()));
  check("order book 'last trade' never shows the midpoint", /Last YES trade\s*0\.65/.test(await page.getByTestId("last-trade").innerText()));
  check("partial history is labelled partial (chart/notice)", /Partial history/i.test(lagos) && (await page.getByTestId("data-notice").innerText()).includes("Partial history"));
  check("24h movement is unavailable with partial history (not invented)", await page.getByTestId("movement-unavailable").isVisible());
  check("volume is shown as 'at least' with a partial-history tag", /at least 0\.000065 tNOC/.test(await page.getByTestId("volume").innerText()) && /partial history/.test(await page.getByTestId("volume").locator("..").innerText()), await page.getByTestId("volume").innerText());
  check("Lagos YES/NO books are its own: asks 0.65 and 0.70, none of the Oslo 0.30", ["0.65", "0.70"].every((x) => lagos.includes(x)) && !lagos.includes("0.30"));
  check("cutoff in UTC+WAT and observation separately", /Nov 11, 2026, 11:00 PM UTC/.test(lagos) && /Nov 12, 2026, 12:00 AM WAT/.test(lagos) && /Observation period/.test(lagos));
  const rules = await page.getByRole("region", { name: "Rules" }).innerText();
  check("review process is reflected (trusted resolver, missing evidence never NO)", /trusted resolver/i.test(rules) && /never becomes NO/i.test(rules));
  await page.goto(`${WEB}/markets/m_snow`);
  await page.waitForFunction(() => /0\.30/.test(document.body.innerText), null, { timeout: 20000 });
  const snow = await body(page);
  check("Oslo market: its own book (0.30), complete history, no Lagos prices", snow.includes("0.30") && !snow.includes("0.65") && !/Partial history/.test(snow) && /midpoint/.test(snow));
  check("Oslo market: no trades -> movement unavailable, last trade none", (await page.getByTestId("last-yes-trade").innerText()) === "none");
  if (shots) await page.screenshot({ path: `${shots}/int-market-desktop.png` });

  // new keeper market appears without reload while another market is selected
  await page.goto(`${WEB}/markets/m_lagos`); await page.waitForSelector("h1");
  await page.evaluate(() => { window.__noReload = 1; });
  await fx.ctl("publish", { ref: "m_new", contractId: "mkt-new.testnet", question: "Will it hail in Kano on 2026-12-01?", category: "Climate", tag: "Kano", offers: [{ id: "4", outcome: "Yes", side: "Sell", price: 400000, qty: 5_000_000 }] });
  await page.getByRole("link", { name: "NearOdds home" }).click();
  await page.waitForFunction(() => /Kano/.test(document.body.innerText), null, { timeout: 15000 });
  check("a keeper-published market appears in discovery without rebuilding or reloading, while a different market was open", (await page.evaluate(() => window.__noReload)) === 1 && /Kano/.test(await body(page)));
  check("its brand-new category (Climate) appears in the nav", (await page.getByRole("navigation", { name: "Categories" }).innerText()).includes("Climate"));
  check("no page errors (discovery)", page.errors.length === 0, page.errors.join(" | "));
  await page.ctx.close();
}

// =====================================================================================================================
// 2. Wallet journey as alice: sign-in, watchlist, faucet, registration, deposit, trading, two markets
// =====================================================================================================================
const ALICE = "alice.testnet";
const page = await newPage();
await page.goto(WEB); await as(page, ALICE); await page.reload(); await page.waitForSelector("article");
await fx.ctl("mint", { account: "carol.testnet", amount: "50000000" });
{
  await page.goto(`${WEB}/markets/m_lagos`);
  const ticket = page.getByRole("region", { name: "Trade", exact: true });
  await ticket.getByRole("button", { name: /Set up account to trade/ }).waitFor({ timeout: 20000 });
  check("ticket for an unregistered wallet sends the user to account setup (per market)", /register with its contract and with the tNOC token/i.test(await page.getByTestId("setup-needed").innerText()));

  await page.goto(`${WEB}/funds?market=m_lagos`);
  await page.getByRole("region", { name: "Account setup" }).waitFor();
  check("funds page is market-scoped and shows the Lagos contract", /mkt-lagos\.testnet/.test(await body(page)));
  await page.getByRole("button", { name: "Register with token" }).click();
  await page.getByRole("button", { name: "Register with market" }).waitFor();
  await page.waitForFunction(() => document.querySelector("[aria-label='Account setup']")?.innerText.includes("Registered."), null, { timeout: 15000 });
  await page.getByRole("button", { name: "Register with market" }).click();
  await page.waitForFunction(() => !/Register with market/.test(document.querySelector("[aria-label='Account setup']")?.innerText ?? ""), null, { timeout: 15000 });
  const reg = await wcalls(page);
  check("token registration: token contract, 0.00125 NEAR, registration_only", reg[0]?.receiver === "tok.testnet" && reg[0].method === "storage_deposit" && reg[0].deposit === "1250000000000000000000" && reg[0].args.registration_only === true && reg[0].args.account_id === ALICE, JSON.stringify(reg[0]));
  check("market registration targets the SELECTED market contract with its storage cost", reg[1]?.receiver === "mkt-lagos.testnet" && reg[1].deposit === "40960000000000000000000" && reg[1].args.account_id === null, JSON.stringify(reg[1]));

  // sign-in (NEP-413)
  const faucet = page.getByTestId("faucet");
  await faucet.getByRole("button", { name: "Sign in with wallet" }).click();
  await faucet.getByTestId("faucet-claim").waitFor();
  const signed = await page.evaluate(() => window.__signed);
  const st = await fx.state();
  check("NEP-413: wallet signed the challenge message + recipient + decoded 32-byte nonce", signed.recipient === "nearodds.app" && signed.nonceLen === 32 && signed.nonceIsBytes && /Sign in to NearOdds as alice\.testnet/.test(signed.message));
  check("verify was posted with the account, public key and base64 signature/nonce", st.verifyCalls[0]?.accountId === ALICE && st.verifyCalls[0].publicKey === "ed25519:E2E" && typeof st.verifyCalls[0].nonce === "string");

  // faucet: first response is lost; the retry must reuse the SAME idempotency key
  await fx.ctl("setFaucet", { dropResponse: true });
  await faucet.getByTestId("faucet-claim").click();
  await sleep(2500); if (process.env.DEBUG_E2E) console.log("FAUCET:", await faucet.innerText(), JSON.stringify((await fx.state()).faucetPosts));
  await faucet.getByTestId("faucet-retry").waitFor({ timeout: 15000 });
  await faucet.getByTestId("faucet-claim").click();
  await faucet.getByTestId("faucet-queued").waitFor({ timeout: 15000 });
  const fp = (await fx.state()).faucetPosts;
  check("faucet retry reuses the same Idempotency-Key and creates ONE claim", fp.length === 2 && fp[0].key === fp[1].key && fp[0].key.length >= 8 && (await fx.S.faucet.claims.size) === 1, JSON.stringify(fp));
  check("a queued claim says the wallet is NOT funded yet", /not funded yet/i.test(await faucet.getByTestId("faucet-queued").innerText()));
  await fx.ctl("completeFaucetClaim", { id: "claim-1", state: "minted" });
  await faucet.getByTestId("faucet-minted").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /\b100(\.00)? tNOC/.test(document.querySelector("[data-testid='funds-panel']")?.innerText ?? ""), null, { timeout: 15000 });
  check("after mint the wallet balance is refreshed (100 tNOC) and faucet is separate from native NEAR", /does not send NEAR/i.test(await faucet.innerText()));

  // deposits go to the selected market only
  await fundsAction(page, "deposit", 20);
  await page.waitForFunction(() => /Deposited 20/.test(document.body.innerText), null, { timeout: 15000 });
  let c = await wcalls(page); const dep = c[c.length - 1];
  check("deposit: ft_transfer_call on the token, receiver_id = the Lagos contract, 300 Tgas, 1 yocto", dep.receiver === "tok.testnet" && dep.method === "ft_transfer_call" && dep.args.receiver_id === "mkt-lagos.testnet" && dep.gas === (300n * T).toString() && dep.deposit === "1" && dep.args.amount === "20000000", JSON.stringify(dep));

  await pickMarket(page, "m_snow");
  check("switching market updates registration state (Oslo: not registered with the contract)", await page.getByRole("button", { name: "Register with market" }).isVisible());
  await page.getByRole("button", { name: "Register with market" }).click();
  await page.waitForFunction(() => !/Register with market/.test(document.querySelector("[aria-label='Account setup']")?.innerText ?? ""), null, { timeout: 15000 });
  await fundsAction(page, "deposit", 5);
  await page.waitForFunction(() => /Deposited 5/.test(document.body.innerText), null, { timeout: 15000 });
  c = await wcalls(page);
  check("Oslo registration + deposit target mkt-snow.testnet, not Lagos", c.at(-2).receiver === "mkt-snow.testnet" && c.at(-2).method === "storage_deposit" && c.at(-1).args.receiver_id === "mkt-snow.testnet", JSON.stringify(c.slice(-2)));
  await page.waitForFunction(() => /\b5(\.00)? tNOC/.test(document.querySelector("[data-testid='stat-In this market']")?.innerText ?? ""), null, { timeout: 15000 });
  check("Oslo shows 5 deposited here; wallet shows the one token balance (75), not per market", /\b5(\.00)? tNOC/.test(await page.getByTestId("stat-In this market").innerText()) && /\b75(\.00)? tNOC/.test(await page.getByTestId("stat-In your wallet").innerText()));
  await pickMarket(page, "m_lagos");
  if (process.env.DEBUG_E2E) { await sleep(2500); console.log("STATS:", await page.getByTestId("funds-panel").innerText().then((t) => t.slice(0, 400)), JSON.stringify(await fx.state().then((x) => x.tokenBal))); }
  await page.waitForFunction(() => /\b20(\.00)? tNOC/.test(document.querySelector("[data-testid='stat-In this market']")?.innerText ?? ""), null, { timeout: 15000 });
  check("Lagos still shows its own 20 tNOC deposit (separate buckets)", true);

  // watchlist (needs the session)
  await page.goto(`${WEB}/markets/m_lagos`); await page.getByRole("button", { name: "Bookmark market" }).waitFor(); await page.waitForSelector("[data-auth='signed-in']", { timeout: 15000 });
  await page.getByRole("button", { name: "Bookmark market" }).click();
  await page.waitForFunction(() => document.querySelector("button[aria-label='Remove bookmark']"), null, { timeout: 10000 });
  check("watchlist add writes PUT /v1/watchlist/m_lagos", (await fx.state()).watch[ALICE]?.includes("m_lagos"));
  await page.getByRole("button", { name: "Remove bookmark" }).click();
  await page.waitForFunction(() => document.querySelector("button[aria-label='Bookmark market']"), null, { timeout: 10000 });
  await sleep(300);
  check("watchlist remove writes DELETE", !(await fx.state()).watch[ALICE]?.includes("m_lagos"));

  // trading: partial fill on each market where BOTH contracts have a local offer "4"
  const buy = async () => {
    const t = page.getByRole("region", { name: "Trade", exact: true });
    await t.getByRole("radio", { name: /^YES / }).click();
    await t.getByLabel("Amount in tNOC").fill("1.3");
    await t.getByRole("button", { name: /^Buy YES$/ }).click();
  };
  await page.waitForFunction(() => document.querySelector("[data-testid='selected-offer']")?.innerText.includes("0.65"), null, { timeout: 20000 });
  await buy();
  await waitText(page, /Filled 2 shares for 1\.3 tNOC \(8 still on that offer\)/);
  c = await wcalls(page); const f1 = c.at(-1);
  check("Lagos fill: fill_offer on mkt-lagos with local offer_id 4 (partial: 2 shares)", f1.receiver === "mkt-lagos.testnet" && f1.method === "fill_offer" && f1.args.offer_id === "4" && f1.args.quantity === "2000000" && f1.deposit === "1" && f1.gas === (100n * T).toString(), JSON.stringify(f1));
  await page.goto(`${WEB}/markets/m_snow`);
  await page.waitForFunction(() => /0\.30/.test(document.querySelector("[data-testid='selected-offer']")?.innerText ?? ""), null, { timeout: 20000 });
  const t2 = page.getByRole("region", { name: "Trade", exact: true });
  await t2.getByRole("radio", { name: /^YES / }).click(); await t2.getByLabel("Amount in tNOC").fill("0.9"); await t2.getByRole("button", { name: /^Buy YES$/ }).click();
  await waitText(page, /Filled 3 shares for 0\.9 tNOC \(4 still on that offer\)/);
  c = await wcalls(page); const f2 = c.at(-1);
  check("Oslo fill: the SAME local offer id 4 goes to mkt-snow, a different offer at 0.30", f2.receiver === "mkt-snow.testnet" && f2.args.offer_id === "4" && f2.args.quantity === "3000000", JSON.stringify(f2));
  const pf = await fetch(`${fx.apiUrl}/v1/markets/m_lagos/book`).then((r) => r.json());
  check("the Lagos offer 4 kept 8 shares after the Oslo fill (isolated)", pf.yes.asks.find((o) => o.offerId === "4").remainingQuantity === "8000000");

  // limit offer then cancel from the portfolio on Oslo
  await t2.getByRole("combobox", { name: "Order mode" }).selectOption("limit");
  await t2.getByRole("radio", { name: /^YES / }).click();
  await t2.getByLabel("Limit price").fill("0.10"); await t2.getByLabel("Shares").fill("3");
  await t2.getByRole("button", { name: /Place buy offer/ }).click();
  await waitText(page, /Limit offer #\d+ is open/);
  c = await wcalls(page); const lo = c.at(-1);
  check("limit offer: create_offer on mkt-snow with contract enums and market_id mkt-1", lo.receiver === "mkt-snow.testnet" && lo.method === "create_offer" && lo.args.market_id === "mkt-1" && lo.args.outcome === "Yes" && lo.args.side === "Buy" && lo.args.price === "100000" && lo.args.quantity === "3000000", JSON.stringify(lo));
  await page.goto(`${WEB}/portfolio`);
  await page.getByRole("tab", { name: /Open offers/ }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await waitText(page, /Offer cancelled\. Released 0\.3 tNOC/);
  c = await wcalls(page);
  check("cancel: cancel_offer on mkt-snow with the offer's LOCAL id", c.at(-1).receiver === "mkt-snow.testnet" && c.at(-1).method === "cancel_offer" && /^\d+$/.test(c.at(-1).args.offer_id), JSON.stringify(c.at(-1)));
  await page.getByRole("tab", { name: /Positions/ }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='deposits-by-market'] li").length === 2, null, { timeout: 15000 });
  const dm = await page.getByTestId("deposits-by-market").innerText();
  check("portfolio refreshes: deposits listed per market contract (separate)", /Lagos/.test(dm) && /Oslo/.test(dm) && /mkt-lagos\.testnet/.test(dm) && /mkt-snow\.testnet/.test(dm));
  check("portfolio wallet balance is one number for the shared token", /Wallet balance[\s\S]*?\d+(\.\d+)? tNOC/.test(await body(page)) && (await body(page)).match(/Wallet balance/g).length === 1);

  // another trader changes an offer: clear message, no wallet call
  await fx.ctl("register", { account: "carol.testnet" });
  const tx = (signer, receiver, method, args) => fetch(`${fx.rpcUrl}/__tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signer, receiver, method, args }) });
  await tx("carol.testnet", "mkt-lagos.testnet", "storage_deposit", { account_id: null });
  await tx("carol.testnet", "tok.testnet", "ft_transfer_call", { receiver_id: "mkt-lagos.testnet", amount: "20000000", msg: "deposit" });
  await page.goto(`${WEB}/markets/m_lagos`);
  await page.waitForFunction(() => /0\.65/.test(document.querySelector("[data-testid='selected-offer']")?.innerText ?? ""), null, { timeout: 20000 });
  const tk = page.getByRole("region", { name: "Trade", exact: true });
  await tk.getByRole("radio", { name: /^YES / }).click(); await tk.getByLabel("Amount in tNOC").fill("0.65");
  await fx.ctl("emit", { type: "trade", payload: { marketRef: "m_lagos" } });
  // carol takes the whole remaining offer 4 AFTER the page loaded it (the indexed book is stale)
  await fx.ctl("set", { lag: true });
  await tx("carol.testnet", "mkt-lagos.testnet", "fill_offer", { offer_id: "4", quantity: "8000000" });
  const before = (await wcalls(page)).length;
  await tk.getByRole("button", { name: /^Buy YES$/ }).click();
  await waitText(page, /no longer available: another trader filled or cancelled it/);
  check("stale offer: clear message and the wallet is never opened", (await wcalls(page)).length === before);
  await fx.ctl("set", { lag: false });

  // wallet rejection
  await page.evaluate(() => { window.__rejectNext = true; });
  await page.reload();
  await page.waitForFunction(() => /0\.70/.test(document.querySelector("[data-testid='selected-offer']")?.innerText ?? ""), null, { timeout: 20000 });
  await page.evaluate(() => { window.__rejectNext = true; });
  const tk2 = page.getByRole("region", { name: "Trade", exact: true });
  await tk2.getByRole("radio", { name: /^YES / }).click(); await tk2.getByLabel("Amount in tNOC").fill("0.7");
  await tk2.getByRole("button", { name: /^Buy YES$/ }).click();
  await waitText(page, /declined the request in your wallet/);
  check("wallet rejection is explained and nothing was sent", (await fx.state()).calls.filter((x) => x.method === "fill_offer" && x.signer === ALICE).length === 2);
  check("no page errors (wallet journey)", page.errors.length === 0, page.errors.join(" | "));
}

// =====================================================================================================================
// 3. Lifecycle: cutoff, pending withdrawal, resolution -> redeem -> withdraw
// =====================================================================================================================
{
  let c;
  await fx.ctl("close", { contractId: "mkt-lagos.testnet", ref: "m_lagos" });
  await page.goto(`${WEB}/markets/m_lagos`);
  await page.getByTestId("awaiting-panel").waitFor({ timeout: 20000 });
  check("after the cutoff the ticket is replaced by the awaiting panel (status from the contract)", /Trading closed at/i.test(await page.getByTestId("awaiting-panel").innerText()));

  // pending withdrawal on Oslo: unconfirmed, never resent
  await fx.ctl("set", { withdrawalMode: "hang" });
  await page.goto(`${WEB}/funds?market=m_snow`); await page.getByTestId("funds-panel").waitFor();
  await fundsAction(page, "withdraw", 1);
  await waitText(page, /NOT confirmed/);
  check("withdraw while Pending: reported as unconfirmed and the pending notice shows", await page.getByTestId("withdrawal-pending").isVisible());
  check("no automatic resend: exactly one withdraw call", (await fx.state()).calls.filter((x) => x.method === "withdraw").length === 1);
  await page.waitForFunction(() => document.querySelector("[data-testid='withdrawal-pending']"), null, { timeout: 5000 });
  await page.locator("#withdraw-amt").fill("1");
  check("a second withdrawal is blocked while one is pending", await page.getByRole("button", { name: /Review/ }).nth(1).isDisabled());
  await page.goto(`${WEB}/portfolio`); await page.getByRole("tab", { name: /Withdrawals/ }).click();
  check("portfolio lists the withdrawal as Pending: not confirmed", /Pending: not confirmed/.test(await page.getByTestId("withdrawals").innerText()));
  await fx.ctl("finishWithdrawal", { contractId: "mkt-snow.testnet", account: ALICE });
  await page.reload(); await page.getByRole("tab", { name: /Withdrawals/ }).click();
  await page.waitForFunction(() => /Completed/.test(document.querySelector("[data-testid='withdrawals']")?.innerText ?? ""), null, { timeout: 15000 });
  check("once the contract records Completed it is shown as completed", true);
  await fx.ctl("set", { withdrawalMode: "complete" });

  // resolve Lagos Yes: preview -> redeem (internal) -> separate withdraw
  await fx.ctl("resolve", { contractId: "mkt-lagos.testnet", ref: "m_lagos", outcome: "Yes" });
  await page.goto(`${WEB}/markets/m_lagos`);
  await page.getByTestId("resolved-panel").waitFor({ timeout: 20000 });
  const rp = await page.getByTestId("resolved-panel").innerText();
  check("resolved panel shows the result and evidence", /YES/.test(rp) && /Reviewed NiMet report/.test(rp));
  const prev = await page.getByLabel("Redemption preview").innerText();
  check("redemption preview from the contract (2 winning shares, payout 2 tNOC)", /Winning YES shares\s*2/.test(prev) && /Winning payout\s*2(\.00)? tNOC/.test(prev), prev);
  const walletBefore = (await fx.state()).tokenBal[ALICE];
  await page.getByRole("button", { name: "Redeem", exact: true }).click();
  await waitText(page, /inside this market\. Withdraw it/);
  c = await wcalls(page);
  check("redeem: redeem on mkt-lagos with market_id mkt-1, 1 yocto", c.at(-1).receiver === "mkt-lagos.testnet" && c.at(-1).method === "redeem" && c.at(-1).args.market_id === "mkt-1" && c.at(-1).deposit === "1", JSON.stringify(c.at(-1)));
  check("redeem moved NO tokens to the wallet", (await fx.state()).tokenBal[ALICE] === walletBefore);
  check("the panel explains Redeem credits internal collateral and Withdraw is separate", /Two steps/.test(await page.getByTestId("resolved-panel").innerText()));
  await page.goto(`${WEB}/funds?market=m_lagos`); await page.getByTestId("funds-panel").waitFor();
  await fundsAction(page, "withdraw", 2);
  await waitText(page, /Withdrew 2 tNOC to your wallet/);
  c = await wcalls(page);
  check("withdraw is its own call on the Lagos contract; the wallet balance then rises", c.at(-1).receiver === "mkt-lagos.testnet" && c.at(-1).method === "withdraw" && BigInt((await fx.state()).tokenBal[ALICE]) === BigInt(walletBefore) + 2_000_000n, JSON.stringify(c.at(-1)));
  check("no page errors (lifecycle)", page.errors.length === 0, page.errors.join(" | "));
}

// =====================================================================================================================
// 4. Streams, account/session changes, degraded data
// =====================================================================================================================
{
  const st = await fx.state();
  check("one SSE connection scoped to the connected account (all markets, so new markets reach discovery)", st.streamOpens.some((u) => u.includes("account=alice.testnet") && !u.includes("markets=")));
  const opens = st.streamOpens.length;
  await fx.ctl("dropSse");
  await page.waitForFunction(async () => true);
  await sleep(2500);
  check("after the stream drops it reconnects", (await fx.state()).streamOpens.length > opens);

  // sign-out when the wallet account changes
  await page.goto(WEB); await page.waitForSelector("article");
  await page.getByRole("button", { name: /alice/ }).click();
  check("signed in as alice (menu offers sign-out)", await page.getByTestId("sign-out").isVisible());
  await page.keyboard.press("Escape");
  await as(page, "bob.testnet"); await page.reload(); await page.waitForSelector("article");
  await page.getByRole("button", { name: /bob/ }).click();
  check("changing the wallet account ends the application session", await page.getByTestId("sign-in").isVisible() && !(await page.getByTestId("sign-out").isVisible().catch(() => false)));
  await page.keyboard.press("Escape");
  await as(page, ALICE); await page.reload(); await page.waitForSelector("article");
  await page.getByRole("button", { name: /alice/ }).click();
  check("a different account's saved session is not reused when switching back", await page.getByTestId("sign-in").isVisible());
  await page.keyboard.press("Escape");

  // degraded data
  await fx.ctl("set", { lag: true });
  await fx.ctl("emit", { type: "trade", payload: { marketRef: "m_snow" } });
  await page.reload(); await page.waitForSelector("article");
  await waitText(page, /blocks behind the chain/);
  check("indexer delay is shown (80 blocks behind)", /80 blocks behind/.test(await page.getByTestId("data-notice").innerText()));
  await fx.ctl("set", { lag: false });

  await page.goto(`${WEB}/markets/m_snow`); await page.waitForSelector("h1");
  await fx.ctl("set", { rpcDown: true });
  await page.reload(); await page.waitForSelector("h1");
  await waitText(page, /contract could not be read just now/);
  check("RPC failure: indexed data stays visible, the notice explains status comes from the indexer", /contract could not be read just now/.test(await page.getByTestId("data-notice").innerText()));
  const t = page.getByRole("region", { name: "Trade", exact: true });
  await waitText(page, /failed verification|Trading unavailable|Balance unavailable|Verifying/i);
  check("RPC failure: wallet actions stay disabled (market failed verification)", await t.getByRole("button", { name: /Trading unavailable|Balance unavailable|Verifying|Loading balance/ }).first().isDisabled());
  await fx.ctl("set", { rpcDown: false });

  await page.goto(WEB); await page.waitForSelector("article");
  await fx.ctl("set", { apiDown: true });
  await fx.ctl("emit", { type: "trade", payload: { marketRef: "m_snow" } });
  await page.waitForFunction(() => /did not answer/.test(document.body.innerText), null, { timeout: 25000 });
  check("API outage after loading: last data stays visible with a stale warning", (await page.locator("article").count()) >= 2 && /last data we received/.test(await page.getByTestId("data-notice").innerText()));
  await page.reload();
  await page.waitForFunction(() => /Something went wrong|did not answer/.test(document.body.innerText), null, { timeout: 25000 });
  check("API outage on first load: an error with retry, not an empty or zero state", (await page.getByRole("button", { name: "Try again" }).count()) > 0);
  await fx.ctl("set", { apiDown: false });
  await page.getByRole("button", { name: "Try again" }).first().click();
  await page.waitForSelector("article", { timeout: 20000 });
  check("retry recovers", true);
  await page.ctx.close();
}

// =====================================================================================================================
// 5. Mobile layout
// =====================================================================================================================
{
  const m = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await m.goto(WEB); await as(m, ALICE); await m.reload(); await m.waitForSelector("article");
  for (const path of ["/", "/markets/m_snow", "/funds?market=m_snow", "/portfolio"]) {
    await m.goto(`${WEB}${path}`); await m.waitForSelector("h1, h2, article", { timeout: 20000 }); await sleep(800);
    const w = await m.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    check(`mobile ${path}: no horizontal page scroll`, w[0] <= w[1], `${w}`);
    if (shots) await m.screenshot({ path: `${shots}/int-mobile-${path.replace(/[^a-z]+/gi, "_")}.png` });
  }
  await m.goto(`${WEB}/markets/m_snow`);
  await m.getByRole("button", { name: "Trade", exact: true }).click();
  check("mobile: trade sheet opens with the compact ticket", await m.getByRole("dialog").getByRole("region", { name: "Trade" }).isVisible());
  check("no page errors (mobile)", m.errors.length === 0, m.errors.join(" | "));
  await m.ctx.close();
}

await browser.close(); fx.stop();
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nAll ${results.length} integration checks passed`);
process.exit(failed ? 1 : 0);
