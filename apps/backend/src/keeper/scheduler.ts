import type { Db } from "../db/index.js";
import { enqueue } from "./jobs.js";
import { TemplateSpec, dueOccurrences } from "./template.js";

/** Enqueue one create_market job per due occurrence. Dedupe key = template/version/occurrence, so ticks and restarts never double-create. */
export async function scheduleTick(db: Db, nowMs = Date.now()): Promise<{ enqueued: string[] }> {
  const enqueued: string[] = [];
  const tpls = (await db.query("SELECT id, slug, version, spec FROM templates WHERE enabled")).rows;
  for (const t of tpls) {
    const spec = TemplateSpec.parse(t.spec);
    for (const o of dueOccurrences(spec, t.version, nowMs)) {
      const r = await enqueue(db, "create_market", o.dedupe, { templateId: t.id, templateSlug: t.slug, templateVersion: t.version, occurrenceDate: o.date });
      if (r.created) { enqueued.push(o.dedupe); await db.query("UPDATE templates SET last_scheduled_for=to_timestamp($2/1000.0) WHERE id=$1", [t.id, o.cutoffMs]); }
    }
  }
  return { enqueued };
}
