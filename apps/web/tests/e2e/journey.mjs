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

  // Trade journey as demo account
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Use demo account/ }).click();
  await page.goto(`${BASE}/markets/near-10-dec?outcome=NO`);
  await page.getByRole("radio", { name: "NO" }).waitFor();
  check("outcome button preselects NO", (await page.getByRole("radio", { name: "NO" }).getAttribute("aria-checked")) === "true");
  await page.getByRole("radio", { name: "YES" }).click();
  await page.locator("#qty").fill("25");
  await page.waitForTimeout(300);
  const summary = await page.getByLabel("Order summary").innerText();
  console.log(summary.replace(/\n+/g, " | "));
  if (shots) await page.screenshot({ path: `${shots}/detail-1440.png`, fullPage: false });
  await page.getByRole("button", { name: "Review order" }).click();
  await page.getByRole("button", { name: "Simulate buy" }).click();
  await page.getByText("Demo trade completed").first().waitFor({ timeout: 5000 });
  check("simulated buy confirmed", true);
  await page.goto(`${BASE}/portfolio`);
  await page.waitForSelector("text=Positions");
  await page.waitForTimeout(500);
  const text = await page.locator("main").innerText();
  if (process.env.DEBUG_TEXT) console.log(text.replace(/\n+/g, " | "));
  check("portfolio shows 65 YES shares for NEAR market (40 + 25)", /65/.test(text));
  check("available collateral dropped by exactly 10.50 TEST", /489\.50 TEST/.test(text));
  if (shots) await page.screenshot({ path: `${shots}/portfolio-1440.png` });

  // Offer cancellation updates committed collateral
  await page.getByRole("tab", { name: /Open offers/ }).click();
  const committedBefore = await page.getByText("Committed to offers").locator("xpath=following-sibling::p[1]").innerText();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(1500);
  const committedAfter = await page.getByText("Committed to offers").locator("xpath=following-sibling::p[1]").innerText();
  check("cancelling the buy offer releases committed collateral", committedBefore !== committedAfter, `${committedBefore} -> ${committedAfter}`);

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
  await page.goto(`${BASE}/markets/near-10-dec`);
  await page.getByRole("button", { name: "Trade", exact: true }).click();
  await page.getByRole("dialog", { name: "Trade" }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/sheet-390.png` });
  check("trade bottom sheet opens", true);
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
