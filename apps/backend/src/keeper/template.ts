import { z } from "zod";
import { addDays, localDate, msToNs, ymd, zonedToUtcMs } from "./time.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const yocto = z.string().regex(/^\d+$/);

export const LIMITS = { marketId: [1, 64], question: [1, 512], rules: [0, 2048], source: [1, 512] } as const;

export const TemplateSpec = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/),
  category: z.string().min(1).max(40),
  tag: z.string().max(40).optional(),
  questionTemplate: z.string().min(1),
  rulesTemplate: z.string(),
  resolutionSource: z.string().min(1),
  schedule: z.object({
    frequency: z.enum(["daily", "weekly"]),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),   // 0=Sunday; weekly uses these observation weekdays
    timezone: z.string().refine((t) => { try { new Intl.DateTimeFormat("en", { timeZone: t }); return true; } catch { return false; } }, "unknown IANA timezone"),
    leadDays: z.number().int().min(0).max(30),                      // create this many days before the observation day starts
    minLeadMinutes: z.number().int().min(0).default(30),            // refuse to create a market whose cutoff is closer than this
  }),
  cutoff: z.object({ offsetMinutesFromObservationStart: z.number().int().default(0) }),
  observation: z.object({ startOffsetMinutes: z.number().int().default(0), durationMinutes: z.number().int().min(1) }).nullable(),
  evidence: z.object({ required: z.boolean(), description: z.string().min(1) }),
  resolverAccount: z.string().regex(ACCOUNT),
  collateralToken: z.string().regex(ACCOUNT),
  artifact: z.object({ id: z.string(), version: z.string() }),
  internalMarketId: z.string().default("mkt-1"),
  limits: z.object({
    fundingYocto: yocto,                       // sent to each new market account
    creationBudgetYocto: yocto,                // total funding this template may ever spend
    minDeployerBalanceYocto: yocto,            // deployer must keep at least this after funding
    maxPerDay: z.number().int().min(1).max(100),
  }),
  resolution: z.discriminatedUnion("policy", [
    z.object({ policy: z.literal("reviewed") }),
    z.object({ policy: z.literal("automatic"), provider: z.string().min(1), decisionRule: z.string().min(1) }),
  ]),
});
export type TemplateSpec = z.infer<typeof TemplateSpec>;

export interface Occurrence {
  date: string; dedupe: string;
  cutoffMs: number; obsStartMs: number | null; obsEndMs: number | null; createFromMs: number;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const KNOWN = ["date", "cutoffUtc", "cutoffLocal", "timezone", "observationStartLocal", "observationEndLocal", "observationStartUtc", "observationEndUtc"];

export function placeholdersIn(s: string): string[] { return [...s.matchAll(PLACEHOLDER)].map((m) => m[1]); }

const fmtLocal = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(new Date(ms));

/** Occurrence for an observation date (local calendar date in the template timezone). */
export function occurrenceFor(spec: TemplateSpec, version: number, y: number, m: number, d: number): Occurrence {
  const tz = spec.schedule.timezone;
  const dayStart = zonedToUtcMs(y, m, d, 0, 0, tz);
  const cutoffMs = dayStart + spec.cutoff.offsetMinutesFromObservationStart * 60_000;
  const obsStartMs = spec.observation ? dayStart + spec.observation.startOffsetMinutes * 60_000 : null;
  const obsEndMs = spec.observation && obsStartMs !== null ? obsStartMs + spec.observation.durationMinutes * 60_000 : null;
  const date = ymd(y, m, d);
  return { date, dedupe: `tpl:${spec.slug}:v${version}:${date}`, cutoffMs, obsStartMs, obsEndMs, createFromMs: dayStart - spec.schedule.leadDays * 86_400_000 };
}

/** Dates (local) whose creation window is open at `nowMs`: creation time reached, cutoff still ahead. */
export function dueOccurrences(spec: TemplateSpec, version: number, nowMs: number): Occurrence[] {
  const tz = spec.schedule.timezone;
  const today = localDate(nowMs, tz);
  const out: Occurrence[] = [];
  for (let n = -1; n <= spec.schedule.leadDays + 1; n++) {
    const day = addDays(today.y, today.m, today.d, n);
    if (spec.schedule.frequency === "weekly" && !(spec.schedule.weekdays ?? []).includes(day.weekday)) continue;
    const o = occurrenceFor(spec, version, day.y, day.m, day.d);
    if (nowMs >= o.createFromMs && nowMs < o.cutoffMs) out.push(o);
  }
  return out;
}

export function render(tpl: string, spec: TemplateSpec, o: Occurrence): string {
  const tz = spec.schedule.timezone;
  const v: Record<string, string> = {
    date: o.date, timezone: tz,
    cutoffUtc: new Date(o.cutoffMs).toISOString(), cutoffLocal: fmtLocal(o.cutoffMs, tz),
    observationStartLocal: o.obsStartMs ? fmtLocal(o.obsStartMs, tz) : "", observationEndLocal: o.obsEndMs ? fmtLocal(o.obsEndMs, tz) : "",
    observationStartUtc: o.obsStartMs ? new Date(o.obsStartMs).toISOString() : "", observationEndUtc: o.obsEndMs ? new Date(o.obsEndMs).toISOString() : "",
  };
  return tpl.replace(PLACEHOLDER, (_, k) => { if (!(k in v)) throw new Error(`unknown placeholder {{${k}}}`); return v[k]; });
}

export interface RenderedMarket { question: string; rules: string; resolutionSource: string; marketId: string; splitCutoffNs: string; obsStartNs: string | null; obsEndNs: string | null }

/** Pure validation of one occurrence. Returns problems (empty = valid). */
export function renderAndValidate(spec: TemplateSpec, o: Occurrence, nowMs: number): { problems: string[]; market?: RenderedMarket } {
  const problems: string[] = [];
  for (const f of [spec.questionTemplate, spec.rulesTemplate, spec.resolutionSource]) for (const p of placeholdersIn(f)) if (!KNOWN.includes(p)) problems.push(`unknown placeholder {{${p}}}`);
  if (problems.length) return { problems };
  const market: RenderedMarket = {
    question: render(spec.questionTemplate, spec, o), rules: render(spec.rulesTemplate, spec, o), resolutionSource: render(spec.resolutionSource, spec, o),
    marketId: spec.internalMarketId, splitCutoffNs: msToNs(o.cutoffMs), obsStartNs: o.obsStartMs ? msToNs(o.obsStartMs) : null, obsEndNs: o.obsEndMs ? msToNs(o.obsEndMs) : null,
  };
  const chk = (name: string, s: string, [lo, hi]: readonly [number, number]) => { const n = bytes(s); if (n < lo || n > hi) problems.push(`${name} is ${n} bytes; allowed ${lo}-${hi}`); if (lo > 0 && !s.trim()) problems.push(`${name} is blank`); };
  chk("market_id", market.marketId, LIMITS.marketId); chk("question", market.question, LIMITS.question); chk("rules", market.rules, LIMITS.rules); chk("resolution_source", market.resolutionSource, LIMITS.source);
  if (o.cutoffMs < nowMs + spec.schedule.minLeadMinutes * 60_000) problems.push(`cutoff ${new Date(o.cutoffMs).toISOString()} is not at least ${spec.schedule.minLeadMinutes} minutes in the future`);
  if (o.obsStartMs !== null && o.cutoffMs > o.obsStartMs) problems.push("trading cutoff must not be after the observation start");
  if (o.obsEndMs !== null && o.obsStartMs !== null && o.obsEndMs <= o.obsStartMs) problems.push("observation end must be after start");
  return { problems, market };
}
