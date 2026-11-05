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

  // Regression: saved demo state from an older shape must not crash the market page
  await page.evaluate(() => {
    const old = { markets: [{ id: "near-10-dec", resolution: { yesWins: "x", noWins: "y", source: "CoinGecko" } }], book: [], mine: [], positions: [], extra: [] };
    localStorage.setItem("nearodds:demo-state:v1", JSON.stringify(old));
    localStorage.setItem("nearodds:demo-state:v2", JSON.stringify(old));
  });
  const errsBefore = errors.length;
  await page.goto(`${BASE}/markets/near-10-dec`);
  await page.getByRole("region", { name: "Rules" }).waitFor();
  check("stale saved demo state is discarded and the rules render", /Price observation/.test(await page.getByRole("region", { name: "Rules" }).innerText()) && errors.length === errsBefore, errors.slice(errsBefore).join(" | "));

  // ---- Ticket presentations while disconnected ----
  const ticket = page.getByRole("region", { name: "Trade", exact: true });
  const height = () => ticket.evaluate((e) => Math.round(e.getBoundingClientRect().height));
  const val = (sel) => page.locator(sel).inputValue();
  await page.evaluate(() => localStorage.removeItem("nearodds:session"));
  await page.goto(`${BASE}/markets/near-10-dec?outcome=YES`);
  await ticket.getByRole("button", { name: "Connect wallet" }).waitFor();
  await page.locator('[aria-label="YES sell offers (asks)"] button').first().waitFor();
  const hBuyMarket = await height();
  check("disconnected Buy/Market ticket is ~380-400px tall", hBuyMarket >= 370 && hBuyMarket <= 410, `${hBuyMarket}px`);
  check("identity: 48px icon, one-line muted question, bold 'December 31, 2026 · YES'", (await ticket.getByTestId("identity-label").innerText()).trim() === "December 31, 2026 · YES" && (await ticket.locator("p.truncate").count()) === 2);
  const iconSize = await ticket.locator("span[aria-hidden].rounded-xl").first().evaluate((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]);
  check("market icon is a 48px square", iconSize[0] === 48 && iconSize[1] === 48, iconSize.join("x"));
  check("Buy/Sell sit below the identity, with a short underline on the active tab", (await ticket.getByRole("radio", { name: "Buy" }).locator("span[aria-hidden]").count()) === 1);
  const dd = await ticket.getByLabel("Order mode").locator("option").allInnerTexts();
  check("mode dropdown offers Market / Limit", dd.join("|") === "Market|Limit");
  const yb = await ticket.getByRole("radio", { name: /^YES/ }).evaluate((e) => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), t: e.textContent, bg: getComputedStyle(e).backgroundColor }; });
  const nb = await ticket.getByRole("radio", { name: /^NO/ }).evaluate((e) => ({ w: Math.round(e.getBoundingClientRect().width), t: e.textContent }));
  check("large YES/NO buttons: 46-48px, equal width, quotes with TEST", yb.h >= 46 && yb.h <= 48 && /YES 0\.42 TEST/.test(yb.t) && /NO 0\.\d\d TEST/.test(nb.t), `${yb.h}px ${yb.t} | ${nb.t}`);
  const bg = await ticket.evaluate((e) => getComputedStyle(e).backgroundColor);
  check("ticket background is charcoal #1C2027", bg === "rgb(28, 32, 39)", bg);
  const btn = await ticket.getByRole("button", { name: "Connect wallet" }).evaluate((e) => ({ h: Math.round(e.getBoundingClientRect().height), bg: getComputedStyle(e).backgroundColor, r: getComputedStyle(e).borderTopLeftRadius }));
  check("primary button 46-48px, indigo #3E5DFF, 8px corners", btn.h >= 46 && btn.h <= 48 && btn.bg === "rgb(62, 93, 255)" && btn.r === "8px", JSON.stringify(btn));
  const amountSize = await page.locator("#amount").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  check("Buy/Market amount is 30-36px text", amountSize >= 30 && amountSize <= 36, `${amountSize}px`);
  check("Market mode has no limit price or expiration", (await page.locator("#limit-price").count()) === 0 && (await ticket.getByLabel("Expires").count()) === 0);
  check("disconnected: no balance line, no summary", (await ticket.getByTestId("balance").count()) === 0 && (await ticket.getByLabel("Order summary").count()) === 0);
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-buy-market-disconnected.png` });
  await ticket.getByRole("radio", { name: "Sell" }).click();
  check("Sell keeps the large YES/NO buttons, now with bid quotes", /YES 0\.40 TEST/.test(await ticket.getByRole("radio", { name: /^YES/ }).innerText()));
  check("Sell/Market shows Shares row and 25/50/75/Max shortcuts", (await page.locator("#qty").count()) === 1 && (await ticket.getByRole("button", { name: "Max" }).count()) === 1 && (await ticket.getByRole("button", { name: "25%" }).count()) === 1);
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-sell-market-disconnected.png` });

  // ---- Trade journey as demo account ----
  await page.getByRole("button", { name: "Connect wallet" }).first().click();
  await page.getByRole("button", { name: /Use demo account/ }).click();
  await page.evaluate(() => localStorage.setItem("nearodds:debug", "1"));
  await page.goto(`${BASE}/markets/near-10-dec?outcome=NO`);
  await ticket.getByRole("radio", { name: /^NO/ }).waitFor();
  check("outcome button preselects NO", (await ticket.getByRole("radio", { name: /^NO/ }).getAttribute("aria-checked")) === "true");
  await page.goto(`${BASE}/markets/near-10-dec?outcome=YES`);
  await page.locator('[aria-label="YES sell offers (asks)"] button').first().waitFor();

  // Rules
  const rules = await page.getByRole("region", { name: "Rules" }).innerText();
  check("rules: strict YES and 10-or-less NO conditions", /strictly greater than \$10\.00/.test(rules) && /\$10\.00 or less/.test(rules));
  check("rules: trading close, observation and source are separate", /Trading closes\s*Dec 31, 2026, 11:00 PM UTC/.test(rules) && /Price observation\s*Jan 1, 2027, 12:00 AM UTC/.test(rules) && /Resolution source\s*CoinGecko/.test(rules));

  await page.getByTestId("balance").waitFor();
  check("connected: one numeric balance line (500.00 TEST)", (await page.getByTestId("balance").innerText()).includes("500.00 TEST"));
  check("secondary offer line: '0.42 TEST/share · 55 available · Change'", /0\.42 TEST\/share · 55 available · Change/.test(await page.getByTestId("selected-offer").innerText()));
  check("no prominent blue offer callout", (await ticket.locator('[class*="border-brand"]').count()) === 0);
  check("empty Market form shows no summary rows", (await ticket.getByLabel("Order summary").count()) === 0);

  // Order book selection sync
  const asks = page.locator('[aria-label="YES sell offers (asks)"] button');
  const askPrices = await asks.evaluateAll((els) => els.map((e) => parseFloat(e.querySelector("span:nth-child(2)").textContent)));
  check("asks sorted descending so the best ask is nearest the spread", askPrices.every((p, i) => i === 0 || askPrices[i - 1] >= p), askPrices.join(","));
  await asks.last().click();
  check("order-book row marked SELECTED", (await asks.last().innerText()).includes("SELECTED"));
  const book = await page.getByRole("region", { name: "Order book" }).innerText();
  check("order book labels and cumulative arithmetic", /asks/i.test(book) && /bids/i.test(book) && /Cumulative value \(TEST\)/.test(book) && /0\.42[\s\S]*?55[\s\S]*?23\.10/.test(book) && /0\.43[\s\S]*?95[\s\S]*?63\.95/.test(book));

  // Buy + Market: budget -> shares bound to the selected offer
  await page.locator("#amount").fill("4.20");
  await page.waitForTimeout(200);
  const bm = await page.getByLabel("Order summary").innerText();
  check("Buy/Market 4.20 TEST buys 10 shares: 'Est. shares 10', payout 10.00 TEST", /Est\. shares\s*10/.test(bm) && /Payout if YES wins\s*10\.00 TEST/.test(bm), bm.replace(/\n+/g, " | "));
  await ticket.getByRole("button", { name: "+10", exact: true }).click();
  check("budget shortcut +10 raises the amount to 14.2", (await val("#amount")) === "14.2");
  await page.locator("#amount").fill("100");
  check("budget above the offer's liquidity is blocked", await ticket.getByRole("button", { name: /Exceeds liquidity \(max 23\.10 TEST\)/ }).isDisabled());
  await page.locator("#amount").fill("0.00001");
  check("tiny budget is blocked", await ticket.getByRole("button", { name: "Amount too small" }).isDisabled());
  await page.locator("#amount").fill("4.20");
  check("primary action reads 'Simulate buy YES'", await ticket.getByRole("button", { name: "Simulate buy YES" }).isEnabled());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  if (shots) await page.screenshot({ path: `${shots}/detail-top-1440.png` });
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-buy-market.png` });
  await ticket.getByRole("button", { name: "Simulate buy YES" }).click();
  await page.getByText("Demo trade completed").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  check("available collateral decreased by 4.20 (495.80 TEST)", (await page.getByTestId("balance").innerText()).includes("495.80 TEST"));
  check("YES holdings increased by 10 (50)", (await page.locator("main").innerText()).includes("YES 50"));
  check("offer remaining quantity is now 45", (await asks.last().innerText()).includes("45"));
  check("activity records the action exactly once", (await page.getByRole("region", { name: "Activity" }).innerText()).split("Bought 10 YES").length === 2);

  // Sell + Market
  await ticket.getByRole("radio", { name: "Sell" }).click();
  check("Sell: best bid selected (0.40) and book follows", (await page.getByTestId("selected-offer").innerText()).includes("0.40") && (await page.locator('[aria-label="YES buy offers (bids)"] button').first().innerText()).includes("SELECTED"));
  await ticket.getByRole("button", { name: "25%" }).click();
  check("25% of 50 held shares = 12.5", (await val("#qty")) === "12.5");
  await ticket.getByRole("button", { name: "Max" }).click();
  check("Max is bounded by the bound bid's 80 and holdings (50)", (await val("#qty")) === "50");
  await page.locator("#qty").fill("5");
  const sm = await page.getByLabel("Order summary").innerText();
  check("Sell/Market: 'You’ll receive 2.00 TEST' only", /You’ll receive\s*2\.00 TEST/.test(sm) && !/Payout/.test(sm), sm.replace(/\n+/g, " | "));
  check("Sell primary action 'Simulate sell YES'", await ticket.getByRole("button", { name: "Simulate sell YES" }).isEnabled());
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-sell-market.png` });
  await ticket.getByRole("radio", { name: /^NO/ }).click();
  check("switching to NO updates the identity, quotes and order book", (await ticket.getByTestId("identity-label").innerText()).includes("NO") && (await page.getByRole("region", { name: "Order book" }).getByRole("tab", { name: "NO" }).getAttribute("aria-selected")) === "true");
  await ticket.getByRole("radio", { name: /^YES/ }).click();
  await page.locator("#qty").fill("500");
  check("Sell above the bound bid's quantity is blocked", await ticket.getByRole("button", { name: /Only 80 shares available/ }).isDisabled());
  await page.locator("#qty").fill("60");
  check("Sell above holdings is blocked", await ticket.getByRole("button", { name: "Insufficient shares" }).isDisabled());
  await ticket.getByRole("radio", { name: "Buy" }).click();

  // Change offer, then the offer disappears
  await ticket.getByRole("button", { name: "Change" }).click();
  await ticket.getByRole("button", { name: /0\.44 TEST/ }).click();
  check("Change selects another offer and the book follows", (await page.getByTestId("selected-offer").innerText()).includes("0.44") && (await page.locator('[aria-label="YES sell offers (asks)"] button[aria-pressed=true]').innerText()).includes("0.44"));
  const pickedId = await page.locator('[aria-label="YES sell offers (asks)"] button[aria-pressed=true]').getAttribute("data-offer-id");
  await page.evaluate((id) => window.__demo.removeOffer(id), pickedId);
  await page.waitForTimeout(400);
  await page.locator("#amount").fill("1");
  check("offer removed elsewhere -> 'Offer no longer available'", await ticket.getByRole("button", { name: "Offer no longer available" }).isDisabled());

  // Buy + Limit
  await ticket.getByLabel("Order mode").selectOption("limit");
  const priceBefore = await val("#limit-price");
  await ticket.getByRole("button", { name: "Increase price by 0.01" }).click();
  const p1 = await val("#limit-price");
  await ticket.getByRole("button", { name: "Decrease price by 0.01" }).click();
  await ticket.getByRole("button", { name: "Decrease price by 0.01" }).click();
  const p2 = await val("#limit-price");
  check("limit price +/- steps by the 0.01 tick", priceBefore === "" && p1 === "0.43" && p2 === "0.41", `${p1} ${p2}`);
  await page.locator("#limit-price").fill("0.90");
  await page.locator("#qty").fill("600");
  check("insufficient balance blocks the action", await ticket.getByRole("button", { name: "Insufficient balance" }).isDisabled());
  await page.locator("#limit-price").fill("0.305");
  check("price tick is enforced on typed prices", (await page.getByRole("alert").first().innerText()).includes("0.01"));
  await page.locator("#limit-price").fill("0.30");
  await page.locator("#qty").fill("");
  await ticket.getByRole("button", { name: "+100", exact: true }).click();
  await ticket.getByRole("button", { name: "−10", exact: true }).click();
  check("share shortcuts +100 then −10 = 90", (await val("#qty")) === "90");
  await ticket.getByRole("button", { name: "−100", exact: true }).click();
  check("share shortcuts never go negative (0)", (await val("#qty")) === "0");
  await ticket.getByRole("button", { name: "+10", exact: true }).click();
  await ticket.getByLabel("Expires").selectOption("24h");
  check("expiration lists only contract-supported choices", (await ticket.getByLabel("Expires").locator("option").allInnerTexts()).join("|") === "No expiry|1 hour|24 hours|7 days");
  const bl = await page.getByLabel("Order summary").innerText();
  check("Buy/Limit footer: Expires, Total 3.00 TEST, Payout if YES wins 10.00 TEST", /Expires/.test(bl) && /Total\s*3\.00 TEST/.test(bl) && /Payout if YES wins\s*10\.00 TEST/.test(bl), bl.replace(/\n+/g, " | "));
  check("Buy/Limit primary label 'Simulate buy offer'", await ticket.getByRole("button", { name: "Simulate buy offer" }).isEnabled());
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-buy-limit.png` });

  // Rejected wallet transaction leaves state unchanged
  await page.getByRole("button", { name: "Demo account" }).click();
  await page.getByRole("menuitemcheckbox", { name: /reject next/ }).click();
  await ticket.getByRole("button", { name: "Simulate buy offer" }).click();
  await page.getByText(/rejected in the wallet/i).first().waitFor({ timeout: 5000 });
  check("rejected transaction shows a recoverable error and changes nothing", (await page.getByTestId("balance").innerText()).includes("495.80 TEST"));

  // Sell + Limit
  await ticket.getByRole("radio", { name: "Sell" }).click();
  check("Sell/Limit keeps both YES/NO buttons and uses 25/50/75/Max", (await ticket.getByRole("radio", { name: /^NO/ }).count()) === 1 && (await ticket.getByRole("button", { name: "75%" }).count()) === 1);
  await page.locator("#limit-price").fill("0.80");
  await page.locator("#qty").fill("");
  await ticket.getByRole("button", { name: "50%" }).click();
  check("50% of the 50 available shares = 25", (await val("#qty")) === "25");
  await page.locator("#qty").fill("5");
  const slSummary = await page.getByLabel("Order summary").innerText();
  check("Sell/Limit: Expires + 'You’ll receive 4.00 TEST'", /Expires/.test(slSummary) && /You’ll receive\s*4\.00 TEST/.test(slSummary) && !/Payout/.test(slSummary), slSummary.replace(/\n+/g, " | "));
  check("Sell/Limit primary label 'Simulate sell offer'", await ticket.getByRole("button", { name: "Simulate sell offer" }).isEnabled());
  if (shots) await ticket.screenshot({ path: `${shots}/ticket-sell-limit.png` });
  await ticket.getByRole("radio", { name: "Buy" }).click();
  await page.locator("#limit-price").fill("0.30");
  await page.locator("#qty").fill("10");
  await ticket.getByRole("button", { name: "Simulate buy offer" }).click();
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
    const buySell = await ticket.getByRole("radio", { name: "Buy" }).evaluate((e) => e.getBoundingClientRect().top);
    check(`ticket at ${name}: below header with gap, within viewport, Buy/Sell reachable`, t.top >= h + 8 && t.bottom <= 900 && buySell >= h, `header=${h} ticket=${t.top}-${t.bottom} w=${t.w}`);
    if (name === "bottom" && shots) await page.screenshot({ path: `${shots}/detail-bottom-1440.png` });
  }
  check("ticket is 350-360px wide", [350, 360].includes((await box()).w), `${(await box()).w}`);
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
  check("portfolio shows 50 YES + 15 in offers", /65 \(15 in offers\)/.test(text));
  if (shots) await page.screenshot({ path: `${shots}/portfolio-1440.png` });

  await page.getByRole("tab", { name: /Open offers/ }).click();
  const committed = async () => /([\d.,]+) TEST in offers/.exec(await page.getByTestId("deposits-by-market").innerText())?.[1] ?? "";
  const committedBefore = await committed();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForTimeout(1500);
  const committedAfter = await committed();
  check("cancelling a buy offer releases committed collateral", committedBefore !== committedAfter, `${committedBefore} -> ${committedAfter}`);
  const availPortfolio = /([\d.,]+ TEST) available/.exec(await page.getByTestId("deposits-by-market").innerText())?.[1] ?? "";
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
  await page.locator("#amount").fill("5");
  check("no-offers state", await page.getByRole("button", { name: "No available offers" }).isDisabled());
  await page.goto(`${BASE}/markets/cpi-below-3`);
  await page.getByTestId("awaiting-panel").waitFor();
  check("awaiting-resolution market: trade form replaced by the 'Trading has ended' panel", /Trading has ended/.test(await page.getByTestId("settlement-title").innerText()) && (await page.locator("#amount, #qty").count()) === 0);
  check("awaiting panel lists what is still allowed (cancel, withdraw, merge)", /cancel your open offers/.test(await page.getByTestId("awaiting-panel").innerText()) && /combine equal YES \+ NO/.test(await page.getByTestId("awaiting-panel").innerText()));
  await page.goto(`${BASE}/markets/world-cup-brazil`);
  await page.getByTestId("resolved-panel").waitFor();
  const resolvedText = await page.getByTestId("resolved-panel").innerText();
  check("resolved market shows the result and the two-step redeem/withdraw explanation", /YES won/.test(resolvedText) && /Redeem/.test(resolvedText) && /Withdraw/.test(resolvedText));
  const preview = page.getByRole("group", { name: "Redemption preview" }).or(page.locator("dl[aria-label='Redemption preview']"));
  await preview.waitFor();
  const pt = await preview.innerText();
  check("redemption preview lists winning shares, payout and balance after", /Winning YES shares\s*25/.test(pt) && /Winning payout\s*25(\.00)? TEST/.test(pt) && /Available balance after/.test(pt), pt.replace(/\n/g, " | "));
  await page.getByRole("button", { name: "Simulate redeem" }).click();
  await page.getByText(/Demo redemption completed/).first().waitFor({ timeout: 5000 });
  check("demo redeem credits the payout and leaves nothing more to redeem", /nothing to redeem/i.test(await page.getByTestId("resolved-panel").innerText()));
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
  await page.locator("#amount").fill("2");
  await page.locator("#amount").focus();
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
