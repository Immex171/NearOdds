// End-to-end demo journey. Usage: pnpm build && pnpm start (port 3000), then `pnpm e2e`.
// Uses the system Chrome (CHROME_PATH, default /usr/bin/google-chrome). No chain access; demo adapter only.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`); };

async function desktop() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await page.waitForSelector("article");
  if (shots) await page.screenshot({ path: `${shots}/home-1440.png` });
  const cards = await page.locator("article").count();
  check("homepage shows >=16 market cards", cards >= 16, `${cards}`);
  const ys = await page.locator("article").evaluateAll((els) => els.slice(0, 4).map((e) => Math.round(e.getBoundingClientRect().top)));
  check("four cards per row at 1440", new Set(ys).size === 1, ys.join(","));
  const h = await page.locator("article").first().evaluate((e) => e.getBoundingClientRect().height);
  check("card height 190-230", h >= 190 && h <= 230, `${Math.round(h)}`);

  // Bookmark persists
  await page.locator("article").first().getByRole("button", { name: /bookmark/i }).click();
  await page.reload();
  await page.waitForSelector("article");
  check("bookmark persists across reload", (await page.getByRole("button", { name: "Remove bookmark" }).count()) >= 1);

  // Sorting
  const firstTitle = async () => page.locator("article h3").first().innerText();
  const before = await firstTitle();
  await page.selectOption("#sort", "closing");
  check("sorting changes order", (await firstTitle()) !== before);

  // Category filters + URL
  await page.getByRole("link", { name: "Crypto", exact: true }).click();
  await page.waitForURL(/category=Crypto/);
  await page.waitForSelector("article");
  const cryptoCount = await page.locator("article").count();
  const railW = await page.locator("aside").first().evaluate((e) => e.getBoundingClientRect().width);
  check("crypto page has filter rail ~212px", railW >= 205 && railW <= 225, `${Math.round(railW)}`);
  await page.getByLabel(/^BTC/).click();
  await page.waitForURL(/tag=BTC/);
  const btc = await page.locator("article").count();
  check("asset filter narrows results and updates URL", btc > 0 && btc < cryptoCount, `${cryptoCount} -> ${btc}`);
  if (shots) await page.screenshot({ path: `${shots}/crypto-1440.png` });
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await page.waitForFunction((n) => document.querySelectorAll("article").length === n, cryptoCount, { timeout: 3000 }).catch(() => {});
  check("clear filters restores results", (await page.locator("article").count()) === cryptoCount);
  await page.goto(`${BASE}/markets?q=zzzz`);
  check("no-results state", await page.getByText("No markets match these filters").isVisible());

  // Search
  await page.goto(BASE);
  await page.getByRole("combobox", { name: "Search markets" }).fill("fed");
  await page.getByRole("option").first().waitFor();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
  await page.waitForURL(/\/markets\/fed-dec-cut/);
  check("search opens the market via keyboard", true);

  // ---- Trade journey as demo account ----
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Use demo account/ }).click();
  await page.evaluate(() => localStorage.setItem("nearodds:debug", "1"));
  await page.goto(`${BASE}/markets/near-10-dec?outcome=NO`);
  await page.getByRole("radio", { name: "NO" }).waitFor();
  check("outcome button preselects NO", (await page.getByRole("radio", { name: "NO" }).getAttribute("aria-checked")) === "true");
  await page.goto(`${BASE}/markets/near-10-dec?outcome=YES`);
  const ticket = page.getByRole("region", { name: "Trade", exact: true });
  await page.locator('[aria-label="YES sell offers (asks)"] button').first().waitFor();

  // Rules: structured, objective, and consistent with the title
  const rules = await page.getByRole("region", { name: "Rules" }).innerText();
  check("rules: strict YES and 10-or-less NO conditions", /strictly greater than \$10\.00/.test(rules) && /\$10\.00 or less/.test(rules));
  check("rules: trading close (Dec 31 23:00 UTC), observation (Jan 1 00:00 UTC) and source are separate", /Trading closes\s*Dec 31, 2026, 11:00 PM UTC/.test(rules) && /Price observation\s*Jan 1, 2027, 12:00 AM UTC/.test(rules) && /Resolution source\s*CoinGecko/.test(rules));
  check("rules: missing data does not default to NO", /does not default to NO/.test(rules));
  check("rules: no description sentence used as a rule", !/rallied alongside/.test(rules));
  check("title matches the condition (close above $10 on Dec 31)", /close above \$10 on December 31, 2026/.test(await page.locator("h1").innerText()));

  // Balance is explicit and shared
  check("ticket shows a numeric available balance", (await page.getByTestId("balance").innerText()).includes("500.00 TEST"));
  check("ticket is compact: no permanently expanded offer list", (await ticket.locator('[aria-label="Available offers"]').count()) === 0);
  check("selected-offer summary shows price and availability", /Price: 0\.42 TEST\s*·\s*Available: 55 shares/.test(await page.getByTestId("selected-offer").innerText()));

  // Pick the best ask in the order book -> synchronised selection
  const asks = page.locator('[aria-label="YES sell offers (asks)"] button');
  const askPrices = await asks.evaluateAll((els) => els.map((e) => parseFloat(e.querySelector("span:nth-child(2)").textContent)));
  check("asks sorted descending so the best ask is nearest the spread", askPrices.every((p, i) => i === 0 || askPrices[i - 1] >= p), askPrices.join(","));
  await asks.last().click();
  check("order-book row marked SELECTED", (await asks.last().innerText()).includes("SELECTED"));
  const book = await page.getByRole("region", { name: "Order book" }).innerText();
  check("order book labels: Asks, Bids, units, cumulative value", /asks/i.test(book) && /bids/i.test(book) && /Price \(TEST\/share\)/.test(book) && /Cumulative value \(TEST\)/.test(book));
  check("cumulative arithmetic: 55x0.42=23.10 then +95x0.43=63.95", /0\.42[\s\S]*?55[\s\S]*?23\.10/.test(book) && /0\.43[\s\S]*?95[\s\S]*?63\.95/.test(book));

  await page.locator("#qty").fill("10");
  await page.waitForTimeout(200);
  const summary = await page.getByLabel("Order summary").innerText();
  check("summary: cost 4.20, fees 0 TEST, payout if YES wins 10.00", /Cost\s*4\.20 TEST/.test(summary) && /Fees\s*0 TEST\s/.test(summary + " ") && /Payout if YES wins\s*10\.00 TEST/.test(summary), summary.replace(/\n+/g, " | "));
  check("fee copy is exactly 'Fees 0 TEST'", !/none at this stage/.test(summary));
  await page.locator("#qty").fill("500");
  check("quantity above the offer's remaining amount is blocked", await ticket.getByRole("button", { name: /Only 55 shares available/ }).isDisabled());
  await page.locator("#qty").fill("0.00005");
  check("lot rule rejects sub-lot quantities", (await page.getByRole("alert").first().innerText()).includes("0.0001"));
  await page.locator("#qty").fill("10");
  check("primary action reads 'Review order' then 'Simulate buy YES'", await ticket.getByRole("button", { name: "Review order" }).isEnabled());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  if (shots) await page.screenshot({ path: `${shots}/detail-top-1440.png` });
  await ticket.getByRole("button", { name: "Review order" }).click();
  await ticket.getByRole("button", { name: "Simulate buy YES" }).click();
  await page.getByText("Demo trade completed").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  check("available collateral decreased by 4.20 (495.80 TEST)", (await page.getByTestId("balance").innerText()).includes("495.80 TEST"));
  check("YES holdings increased by 10 (50)", (await page.locator("main").innerText()).includes("YES 50"));
  check("offer remaining quantity is now 45", /0\.42[\s\S]*?\b45\b/.test(await asks.last().innerText()) && (await asks.last().innerText()).includes("45"));
  check("activity records the action exactly once", (await page.getByRole("region", { name: "Activity" }).innerText()).split("Bought 10 YES").length === 2);

  // Buy/Sell and YES/NO switching keep ticket and book in sync
  await ticket.getByRole("radio", { name: "Sell" }).click();
  check("switching to Sell selects the best bid", (await page.getByTestId("selected-offer").innerText()).includes("0.40") && (await page.locator('[aria-label="YES buy offers (bids)"] button').first().innerText()).includes("SELECTED"));
  await ticket.getByRole("radio", { name: "NO" }).click();
  check("switching to NO moves the order book to NO", (await page.getByRole("region", { name: "Order book" }).getByRole("tab", { name: "NO" }).getAttribute("aria-selected")) === "true");
  await ticket.getByRole("radio", { name: "Buy" }).click();
  await ticket.getByRole("radio", { name: "YES" }).click();

  // Change offer selector
  await ticket.getByRole("button", { name: "Change offer" }).click();
  await ticket.getByRole("button", { name: /0\.44 TEST/ }).click();
  check("Change offer selects another offer and the book follows", (await page.getByTestId("selected-offer").innerText()).includes("0.44") && (await page.locator('[aria-label="YES sell offers (asks)"] button[aria-pressed=true]').innerText()).includes("0.44"));

  // Offer becoming unavailable
  const pickedId = await page.locator('[aria-label="YES sell offers (asks)"] button[aria-pressed=true]').getAttribute("data-offer-id");
  await page.evaluate((id) => window.__demo.removeOffer(id), pickedId);
  await page.waitForTimeout(400);
  check("offer removed elsewhere -> 'Offer no longer available'", await ticket.getByRole("button", { name: "Offer no longer available" }).isDisabled());

  // Insufficient balance (limit buy 0.90 x 600 = 540 TEST > available)
  await ticket.getByRole("radio", { name: "Place a limit offer" }).click();
  await page.locator("#limit-price").fill("0.90");
  await page.locator("#qty").fill("600");
  check("insufficient balance blocks the action", await ticket.getByRole("button", { name: "Insufficient balance" }).isDisabled());
  await ticket.getByRole("radio", { name: "Sell" }).click();
  await page.locator("#qty").fill("500");
  check("insufficient shares blocks the action", await ticket.getByRole("button", { name: "Insufficient shares" }).isDisabled());
  await ticket.getByRole("radio", { name: "Buy" }).click();

  // Rejected wallet transaction leaves state unchanged
  await page.getByRole("button", { name: "Demo account" }).click();
  await page.getByRole("menuitemcheckbox", { name: /reject next/ }).click();
  await page.locator("#limit-price").fill("0.30");
  await page.locator("#qty").fill("10");
  await ticket.getByRole("button", { name: "Review order" }).click();
  await ticket.getByRole("button", { name: "Simulate limit buy YES" }).click();
  await page.getByText(/rejected in the wallet/i).first().waitFor({ timeout: 5000 });
  check("rejected transaction shows a recoverable error and changes nothing", (await page.getByTestId("balance").innerText()).includes("495.80 TEST"));

  // Limit offer creation, own-offer highlight
  await ticket.getByRole("button", { name: "Edit order" }).click().catch(() => {});
  await page.locator("#limit-price").fill("0.305");
  check("price tick is enforced", (await page.getByRole("alert").first().innerText()).includes("0.01"));
  await page.locator("#limit-price").fill("0.30");
  check("limit order reserves 3.00 TEST", /Collateral reserved\s*3\.00 TEST/.test(await page.getByLabel("Order summary").innerText()));
  await ticket.getByRole("button", { name: "Review order" }).click();
  await ticket.getByRole("button", { name: "Simulate limit buy YES" }).click();
  await page.getByText("Demo limit offer placed").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const own = page.locator('[data-own="true"]');
  check("own offer is highlighted and disabled in the book", (await own.count()) >= 1 && (await own.first().isDisabled()));
  check("balance after limit offer = 492.80 TEST", (await page.getByTestId("balance").innerText()).includes("492.80 TEST"));

  // Sticky ticket: top, middle, bottom
  const header = () => page.evaluate(() => Math.round(document.querySelector("header").getBoundingClientRect().bottom));
  const box = () => ticket.evaluate((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) }; });
  const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  for (const [name, y] of [["top", 0], ["middle", Math.round(maxScroll / 2)], ["bottom", maxScroll]]) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(250);
    const h = await header(), t = await box();
    const buttonVisible = await ticket.getByRole("button", { name: /Review order|Simulate|Enter|Insufficient|Connect|Offer/ }).last().evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    const buySell = await ticket.getByRole("radio", { name: "Buy" }).evaluate((e) => e.getBoundingClientRect().top);
    check(`ticket at ${name}: below header with gap, within viewport, Buy/Sell and primary action reachable`, t.top >= h + 8 && t.bottom <= 900 && buySell >= h && buttonVisible, `header=${h} ticket=${t.top}-${t.bottom} w=${t.w}`);
    if (name === "bottom" && shots) await page.screenshot({ path: `${shots}/detail-bottom-1440.png` });
  }
  check("ticket is 360px wide", (await box()).w === 360);
  await page.evaluate(() => window.scrollTo(0, 0));

  // Refresh preserves state; Portfolio shows the same balances
  await page.reload();
  await page.getByTestId("balance").waitFor();
  await page.waitForTimeout(600);
  check("refresh preserves demo state (492.80 TEST)", (await page.getByTestId("balance").innerText()).includes("492.80 TEST"));
  await page.goto(`${BASE}/portfolio`);
  await page.waitForSelector("text=Positions");
  await page.waitForTimeout(500);
  const text = await page.locator("main").innerText();
  check("portfolio shows the same available balance", text.includes("492.80 TEST"));
  check("portfolio shows 65 YES (40 + 10 bought + 15 in offers)", /65 \(15 in offers\)/.test(text));
  if (shots) await page.screenshot({ path: `${shots}/portfolio-1440.png` });

  // Offer cancellation updates committed collateral (seeded 12.00 + new 3.00)
  await page.getByRole("tab", { name: /Open offers/ }).click();
  const committed = () => page.getByText("Committed to offers").locator("xpath=following-sibling::p[1]").innerText();
  const committedBefore = await committed();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(1500);
  const committedAfter = await committed();
  check("cancelling a buy offer releases committed collateral", committedBefore !== committedAfter, `${committedBefore} -> ${committedAfter}`);
  const availPortfolio = await page.getByText("Available collateral").locator("xpath=following-sibling::p[1]").innerText();
  await page.goto(`${BASE}/funds`);
  await page.waitForSelector("text=In your wallet");
  check("Funds shows the same available balance as Portfolio", (await page.locator("main").innerText()).includes(availPortfolio), availPortfolio);

  // Manage shares
  await page.goto(`${BASE}/markets/near-10-dec`);
  await page.getByRole("button", { name: "Manage shares" }).click();
  await page.locator("#ms-amt").fill("10");
  await page.getByRole("button", { name: "Simulate create shares" }).click();
  await page.getByText("Demo YES + NO shares created").waitFor({ timeout: 5000 });
  check("complete-set split works", true);

  // No-offers + closed
  await page.goto(`${BASE}/markets/unemployment-4-5`);
  await page.locator("#qty").fill("5");
  check("no-offers state", await page.getByRole("button", { name: "No available offers" }).isDisabled());
  await page.goto(`${BASE}/markets/cpi-below-3`);
  check("closed market state", await page.getByRole("button", { name: "Market closed" }).isDisabled());
  check("no uncaught errors (desktop)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

async function mobile() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector("article");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const wide = (pg) => pg.evaluate(() => [...document.querySelectorAll("main *, header *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest(".no-scrollbar") && getComputedStyle(e).position !== "absolute").length);
  check("no horizontal overflow on mobile home", overflow <= 0 && (await wide(page)) === 0, `${overflow} / ${await wide(page)} wide elements`);
  if (shots) await page.screenshot({ path: `${shots}/home-390.png` });
  await page.evaluate(() => localStorage.setItem("nearodds:session", '"demo"'));
  await page.goto(`${BASE}/markets/near-10-dec`);
  await page.locator('[aria-label="YES sell offers (asks)"] button').first().waitFor();
  if (shots) await page.screenshot({ path: `${shots}/detail-390.png` });
  await page.getByRole("button", { name: "Trade", exact: true }).click();
  await page.getByRole("dialog", { name: "Trade" }).waitFor();
  check("trade bottom sheet opens", true);
  await page.keyboard.press("Escape");
  await page.locator('[aria-label="YES sell offers (asks)"] button').last().click();
  await page.getByRole("dialog", { name: "Trade" }).waitFor();
  check("tapping an offer opens the sheet with that offer selected", (await page.getByRole("dialog").innerText()).includes("0.42"));
  await page.locator("#qty").fill("2");
  await page.locator("#qty").focus();
  if (shots) await page.screenshot({ path: `${shots}/sheet-390.png` });
  await page.keyboard.press("Escape");
  const o2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no horizontal overflow on mobile detail", o2 <= 0 && (await wide(page)) === 0, `${o2} / ${await wide(page)} wide elements`);
  await ctx.close();
}

await desktop();
await mobile();
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
