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

  // Trade journey as demo account: open market -> pick offer -> partial quantity -> review -> confirm -> balances
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Use demo account/ }).click();
  await page.goto(`${BASE}/markets/near-10-dec?outcome=NO`);
  await page.getByRole("radio", { name: "NO" }).waitFor();
  check("outcome button preselects NO", (await page.getByRole("radio", { name: "NO" }).getAttribute("aria-checked")) === "true");
  await page.goto(`${BASE}/markets/near-10-dec?outcome=YES`);
  await page.locator('[aria-label="YES sell offers (asks)"] button').first().waitFor();
  const asks = page.locator('[aria-label="YES sell offers (asks)"] button');
  const bestAsk = asks.last(); // best ask sits nearest the separator
  const askPrices = await asks.evaluateAll((els) => els.map((e) => parseFloat(e.querySelector("span:nth-child(2)").textContent)));
  check("asks sorted descending so the best ask is nearest the spread", askPrices.every((p, i) => i === 0 || askPrices[i - 1] >= p), askPrices.join(","));
  await bestAsk.click();
  check("clicking an offer fills the ticket (Buy YES at best ask)", (await page.getByRole("region", { name: "Trade", exact: true }).innerText()).includes("Buy YES") && (await page.getByLabel("Available offers").locator("button[aria-pressed=true]").innerText()).includes("0.42"));
  await page.locator("#qty").fill("3");
  await page.waitForTimeout(200);
  const summary = await page.getByLabel("Order summary").innerText();
  check("summary: 3 shares @0.42 = 1.26 TEST, payout 3.00", /1\.26 TEST/.test(summary) && /Payout if YES wins\s*3\.00 TEST/.test(summary), summary.replace(/\n+/g, " | "));
  await page.locator("#qty").fill("500");
  check("quantity above the offer's remaining amount is blocked", await page.getByRole("button", { name: /Only .* shares left/ }).isDisabled());
  await page.locator("#qty").fill("0.00005");
  check("lot rule rejects sub-lot quantities", (await page.getByRole("alert").first().innerText()).includes("0.0001"));
  await page.locator("#qty").fill("3");
  if (shots) await page.screenshot({ path: `${shots}/detail-1440.png` });
  await page.getByRole("button", { name: "Review order" }).click();
  if (shots) await page.screenshot({ path: `${shots}/ticket-review-1440.png` });
  await page.getByRole("button", { name: "Simulate buy" }).click();
  await page.getByText("Demo trade completed").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  check("balance updated in ticket (498.74 TEST)", (await page.getByRole("region", { name: "Trade", exact: true }).innerText()).includes("498.74 TEST"));
  check("shares strip shows 43", (await page.locator("main").innerText()).includes("YES 43"));

  // Rejected wallet transaction leaves state unchanged
  await page.getByRole("button", { name: "Demo account" }).click();
  await page.getByRole("menuitemcheckbox", { name: /reject next/ }).click();
  await page.locator('[aria-label="YES sell offers (asks)"] button').last().click();
  await page.locator("#qty").fill("1");
  await page.getByRole("button", { name: "Review order" }).click();
  await page.getByRole("button", { name: "Simulate buy" }).click();
  await page.getByText(/rejected in the wallet/i).first().waitFor({ timeout: 5000 });
  check("rejected transaction shows a recoverable error and changes nothing", (await page.getByRole("region", { name: "Trade", exact: true }).innerText()).includes("498.74 TEST"));

  // Limit offer creation, own-offer highlight, sticky ticket
  await page.getByRole("radio", { name: "Place a limit offer" }).click();
  await page.locator("#limit-price").fill("0.305");
  check("price tick is enforced", (await page.getByRole("alert").first().innerText()).includes("0.01"));
  await page.locator("#limit-price").fill("0.30");
  await page.locator("#qty").fill("10");
  check("limit order reserves 3.00 TEST", /Collateral reserved\s*3\.00 TEST/.test(await page.getByLabel("Order summary").innerText()));
  await page.getByRole("button", { name: "Review order" }).click();
  await page.getByRole("button", { name: "Simulate limit buy" }).click();
  await page.getByText("Demo limit offer placed").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const own = page.locator('[data-own="true"]');
  check("own offer is highlighted and disabled in the book", (await own.count()) >= 1 && (await own.first().isDisabled()));
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(200);
  const top = await page.getByRole("region", { name: "Trade", exact: true }).evaluate((e) => Math.round(e.getBoundingClientRect().top));
  check("ticket stays sticky below the header while scrolling", top > 100 && top < 200, `${top}`);
  const w = await page.getByRole("region", { name: "Trade", exact: true }).evaluate((e) => Math.round(e.getBoundingClientRect().width));
  check("ticket is 360px wide", w === 360, `${w}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (shots) { await page.getByRole("region", { name: "Order book" }).scrollIntoViewIfNeeded(); await page.getByRole("region", { name: "Order book" }).screenshot({ path: `${shots}/orderbook-1440.png` }); }

  await page.goto(`${BASE}/portfolio`);
  await page.waitForSelector("text=Positions");
  await page.waitForTimeout(500);
  const text = await page.locator("main").innerText();
  if (process.env.DEBUG_TEXT) console.log(text.replace(/\n+/g, " | "));
  check("portfolio shows 58 YES shares incl. 15 reserved in offers (40 + 3 bought + 15)", /58 \(15 in offers\)/.test(text));
  if (shots) await page.screenshot({ path: `${shots}/portfolio-1440.png` });

  // Offer cancellation updates committed collateral (seeded 12.00 + new 3.00)
  await page.getByRole("tab", { name: /Open offers/ }).click();
  const committed = () => page.getByText("Committed to offers").locator("xpath=following-sibling::p[1]").innerText();
  const committedBefore = await committed();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(1500);
  const committedAfter = await committed();
  check("cancelling a buy offer releases committed collateral", committedBefore !== committedAfter, `${committedBefore} -> ${committedAfter}`);

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
