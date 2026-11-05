/**
 * Controlled single creation. Inserts the template DISABLED, then enqueues exactly ONE occurrence job (same dedupe key the
 * scheduler would use). The recurring schedule is NOT enabled. Refuses without --confirm <plan hash> and when blockers exist.
 *   pnpm create-once --template templates/lagos-rain.testnet.json --date 2026-11-13 --confirm <hash>
 * A running worker (pnpm worker) then executes the job. This command itself never signs anything.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import { createPool, migrate } from "../db/index.js";
import { enqueue } from "../keeper/jobs.js";
import { defaultProviders } from "../keeper/resolution.js";
import { createTemplate } from "../keeper/templates.js";
import { buildPlan } from "./plan-creation.js";

const arg = (n: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
const tpl = arg("template") ?? "templates/lagos-rain.testnet.json", date = arg("date") ?? "2026-11-13";
const { plan, hash } = await buildPlan(tpl, date);
if (arg("confirm") !== hash) { console.error(`refusing: pass --confirm ${hash} after reviewing 'pnpm plan-creation'`); process.exit(2); }
if (plan.blockers.length) { console.error("refusing: blockers present:\n - " + plan.blockers.join("\n - ")); process.exit(3); }
const cfg = loadConfig(); const db = createPool(cfg.databaseUrl); await migrate(db);
let t = (await db.query("SELECT * FROM templates WHERE slug=$1", [plan.template.slug])).rows[0];
if (!t) t = await createTemplate(db, JSON.parse(readFileSync(tpl, "utf8")), "create-once", cfg, defaultProviders());
const j = await enqueue(db, "create_market", plan.occurrence.dedupeKey, { templateId: t.id, templateSlug: t.slug, templateVersion: t.version, occurrenceDate: date });
console.log(j.created ? `enqueued job ${j.id} (${plan.occurrence.dedupeKey}); template enabled=${t.enabled}` : `job already exists: ${j.id}`);
await db.end();
