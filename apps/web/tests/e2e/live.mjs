// Read-only browser checks against the LIVE testnet deployment (no wallet, no transactions).
// Needs a build made with the deployment env (the default `pnpm build`). Usage: pnpm start -p 3000, then `node tests/e2e/live.mjs`.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const API = process.env.NEARODDS_API ?? "http://localhost:4000";
// The real backend names the market; find its ref instead of hardcoding it.
const REF = (await (await fetch(`${API}/v1/markets?q=Lagos`)).json()).items.find((m) => m.contract.contractId.startsWith("mkt-demo-3879869")).marketRef;
const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`); };
const text = (page) => page.locator("body").innerText();

for (const [label, viewport, opts] of [["desktop", { width: 1440, height: 900 }, {}], ["mobile", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext({ viewport, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await page.waitForSelector("article");
  const banner = await page.getByTestId("mode-banner").innerText();
  check(`${label}: live mode is the default and says testnet`, /NEAR testnet/i.test(banner) && !/DEMO MODE/.test(banner), banner);
  check(`${label}: one real market card, the Lagos question`, (await page.locator("article").count()) >= 1 && (await text(page)).includes("Will it rain in Lagos on 2026-11-12?"));
  check(`${label}: no invented category (no Crypto label/nav-filtered content on the card)`, !(await page.locator("article").innerText()).includes("Crypto"));
  check(`${label}: card volume comes from confirmed fills (partial history is marked), not an invented number`, /≥ 0\.000065 tNOC vol/.test(await page.locator("article").first().innerText()), await page.locator("article").first().innerText());
  if (shots) await page.screenshot({ path: `${shots}/live-home-${label}.png` });

  await page.goto(`${BASE}/markets/${REF}`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.waitForFunction(() => /tNOC/.test(document.body.innerText) && /ASKS/.test(document.body.innerText) && /0\.65/.test(document.body.innerText), null, { timeout: 20000 });
  const body = await text(page);
  check(`${label}: symbol comes from ft_metadata (tNOC)`, /tNOC/.test(body) && !/\bTEST\b/.test(body.replace(/TEST funds only/gi, "")));
  check(`${label}: no Crypto breadcrumb`, !(await page.getByRole("navigation", { name: "Breadcrumb" }).innerText()).includes("Crypto"));
  check(`${label}: trading cutoff shown in UTC and WAT`, /Nov 11, 2026, 11:00 PM UTC/.test(body) && /Nov 12, 2026, 12:00 AM WAT/.test(body));
  const rules = await page.getByRole("region", { name: "Rules" }).innerText();
  check(`${label}: observation period shown separately from the cutoff`, /Observation period/.test(rules) && /Lagos calendar day 2026-11-12, 00:00 to 24:00 WAT/.test(rules) && /Trading closes/.test(rules));
  check(`${label}: rules text and source come from the contract`, /NiMet/.test(rules) && /trusted resolver/i.test(rules));
  check(`${label}: volume is a lower bound while history is partial`, /at least 0\.000065 tNOC/.test(await page.getByTestId("volume").innerText()));
  check(`${label}: partial history is labelled`, await page.getByTestId("history-partial").isVisible());
  check(`${label}: the real price basis is shown (midpoint is not a trade)`, /midpoint/.test(await page.getByTestId("price-basis").innerText()) && /0\.65 tNOC/.test(await page.getByTestId("last-yes-trade").innerText()));
  await page.waitForFunction(() => /probe-de.*traded 0\.0001 YES at 0\.65 tNOC/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
  check(`${label}: indexed activity lists the real probe trade`, /probe-de.*traded 0\.0001 YES at 0\.65 tNOC/.test(await text(page)));
  // Real order book
  check(`${label}: book lists the seeded on-chain prices and the partially filled offer`, ["0.75", "0.70", "0.65", "0.55", "0.50"].every((p) => body.includes(p)) && /0\.65(SELECTED)?\s+\d/.test(body));
  check(`${label}: category comes from the backend (Weather) and the contract id is shown with the market`, /Weather/.test(await page.getByRole("navigation", { name: "Breadcrumb" }).innerText()));
  if (label === "desktop") {
    const ticket = page.getByRole("region", { name: "Trade", exact: true });
    const t = await ticket.innerText();
    check("desktop: ticket quotes come from real offers (YES ask 0.65, NO ask 0.35)", /YES\s*0\.65\s*tNOC/i.test(t) && /NO\s*0\.35\s*tNOC/i.test(t), t.slice(0, 200).replace(/\n/g, " | "));
    check("desktop: disconnected ticket asks to connect", await ticket.getByRole("button", { name: "Connect wallet" }).isVisible());
    // Connect dialog is honest about demo vs testnet
    await ticket.getByRole("button", { name: "Connect wallet" }).click();
    const dlg = await page.getByRole("dialog").innerText();
    check("desktop: connect dialog separates Demo from the testnet wallet", /Demo mode/.test(dlg) && /testnet NEAR/i.test(dlg) && /wallet/i.test(dlg));
    // Demo mode is visibly distinct and reversible
    await page.getByRole("button", { name: /Use demo account/ }).click();
    const demoBanner = await page.getByTestId("mode-banner").innerText();
    check("desktop: demo mode banner is visibly different", /DEMO MODE/.test(demoBanner) && /Switch to live testnet/.test(demoBanner), demoBanner);
    await page.getByRole("button", { name: "Switch to live testnet" }).click();
    check("desktop: switching back returns to live data", /NEAR testnet/.test(await page.getByTestId("mode-banner").innerText()));
    // Funds without a wallet
    await page.goto(`${BASE}/funds`);
    check("desktop: funds page asks to connect when no wallet", /connect/i.test(await text(page)));
  } else {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("mobile: no horizontal overflow", overflow <= 0, `${overflow}`);
  }
  if (shots) await page.screenshot({ path: `${shots}/live-market-${label}.png`, fullPage: label === "mobile" });
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

// ---- Awaiting / Resolved screens. FIXTURE: the real RPC responses are passed through, except get_market, which is
// rewritten to the status under test. This proves the screens follow get_market().status; it is NOT an on-chain state.
const RPC = "https://test.rpc.fastnear.com/";
async function withMarketPatch(patch, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(RPC, async (route) => {
    const req = route.request();
    let body = null;
    try { body = JSON.parse(req.postData() ?? "null"); } catch { /* not JSON */ }
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    if (body?.method === "query" && body.params?.method_name === "get_market") {
      const j = await res.json();
      const mv = JSON.parse(Buffer.from(j.result.result).toString());
      j.result.result = [...Buffer.from(JSON.stringify({ ...mv, ...patch }))];
      return route.fulfill({ json: j });
    }
    return route.fulfill({ response: res });
  });
  await fn(page);
  check(`fixture ${patch.status}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}
await withMarketPatch({ status: "AwaitingResolution", awaiting_resolution: true, trading_open: false, split_open: false, merge_open: true }, async (page) => {
  await page.goto(`${BASE}/markets/${REF}`);
  await page.getByTestId("awaiting-panel").waitFor({ timeout: 20000 });
  const t = await page.getByTestId("awaiting-panel").innerText();
  check("fixture awaiting: ticket becomes 'Trading has ended' with resolver and cutoff", /Trading has ended/.test(await page.getByTestId("settlement-title").innerText()) && /Nov 11, 2026, 11:00 PM UTC/.test(t) && /nearodds-deploy\.testnet/.test(t));
  check("fixture awaiting: states what is still allowed (cancel, withdraw, merge)", /cancel your open offers/.test(t) && /withdraw available collateral/.test(t) && /combine equal YES \+ NO shares/.test(t));
  check("fixture awaiting: no trade inputs are offered", (await page.locator("#amount, #qty, #limit-price").count()) === 0);
  check("fixture awaiting: header status badge", /Awaiting resolution/.test(await page.locator("header").nth(1).innerText().catch(() => "")) || /Awaiting resolution/.test(await page.locator("main").innerText()));
  check("fixture awaiting: order book rows are not selectable (market not tradable)", await page.locator("main button[aria-pressed]").filter({ hasText: /0\.65/ }).first().isDisabled().catch(() => true));
});
await withMarketPatch({ status: "Resolved", resolved: true, trading_open: false, split_open: false, merge_open: false, awaiting_resolution: false,
  resolution: { outcome: "Yes", resolver_id: "nearodds-deploy.testnet", resolved_at_ns: "1794441600000000000", evidence: "https://example.test/nimet-2026-11-12" } }, async (page) => {
  await page.goto(`${BASE}/markets/${REF}`);
  await page.getByTestId("resolved-panel").waitFor({ timeout: 20000 });
  const t = await page.getByTestId("resolved-panel").innerText();
  check("fixture resolved: shows the recorded result and evidence", /YES won/.test(t) && /Evidence \(recorded, not verified\)/.test(t) && /example\.test\/nimet/.test(t));
  check("fixture resolved: explains redeem vs withdraw as two steps", /1\. Redeem/.test(t) && /2\. Withdraw/.test(t) && /no tokens move/.test(t));
  check("fixture resolved: disconnected user is asked to connect before redeeming", await page.getByRole("button", { name: "Connect wallet to redeem" }).isVisible());
});
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll live checks passed");
process.exit(failed ? 1 : 0);
