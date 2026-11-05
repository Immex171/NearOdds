import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
import { withTx } from "../db/index.js";
import { loadApprovedArtifact } from "./artifacts.js";
import type { ProviderRegistry } from "./resolution.js";
import { TemplateSpec } from "./template.js";

export class TemplateError extends Error { constructor(readonly code: string, msg: string, readonly details?: unknown) { super(msg); } }

function check(spec: TemplateSpec, cfg: Config, providers: ProviderRegistry) {
  try { loadApprovedArtifact(cfg.artifactsFile, spec.artifact.id, spec.artifact.version); } catch (e) { throw new TemplateError("artifact_not_approved", (e as Error).message); }
  if (spec.resolution.policy === "automatic") {
    const p = providers.get(spec.resolution.provider);
    if (!p) throw new TemplateError("provider_not_available", `automatic resolution requires a registered, tested provider; "${spec.resolution.provider}" is not registered (available: ${providers.ids().join(", ") || "none"})`);
  }
  if (spec.schedule.frequency === "weekly" && !(spec.schedule.weekdays?.length)) throw new TemplateError("bad_schedule", "weekly templates need weekdays");
  if (spec.resolution.policy === "reviewed" && !spec.evidence.required) throw new TemplateError("evidence_required", "reviewed resolution requires evidence.required = true");
}

export async function createTemplate(db: Db, raw: unknown, createdBy: string, cfg: Config, providers: ProviderRegistry) {
  const parsed = TemplateSpec.safeParse(raw);
  if (!parsed.success) throw new TemplateError("invalid_template", "template failed validation", parsed.error.issues);
  check(parsed.data, cfg, providers);
  try {
    return await withTx(db, async (c) => {
      const r = await c.query("INSERT INTO templates(slug, enabled, category, tag, spec, created_by) VALUES ($1,false,$2,$3,$4,$5) RETURNING *", [parsed.data.slug, parsed.data.category, parsed.data.tag ?? null, JSON.stringify(parsed.data), createdBy]);
      await c.query("INSERT INTO template_revisions(template_id, version, spec) VALUES ($1,$2,$3)", [r.rows[0].id, r.rows[0].version, JSON.stringify(parsed.data)]);
      return r.rows[0];
    });
  } catch (e: any) { if (e.code === "23505") throw new TemplateError("slug_exists", "a template with this slug exists; update it instead"); throw e; }
}

/** Changing the spec bumps `version`, so the new version's occurrences get fresh dedupe keys and old ones are untouched. */
export async function updateTemplate(db: Db, id: string, patch: { enabled?: boolean; spec?: unknown }, cfg: Config, providers: ProviderRegistry) {
  const cur = (await db.query("SELECT * FROM templates WHERE id=$1", [id])).rows[0];
  if (!cur) throw new TemplateError("not_found", "template not found");
  let spec = cur.spec, version = cur.version;
  if (patch.spec !== undefined) {
    const parsed = TemplateSpec.safeParse(patch.spec);
    if (!parsed.success) throw new TemplateError("invalid_template", "template failed validation", parsed.error.issues);
    if (parsed.data.slug !== cur.slug) throw new TemplateError("slug_immutable", "slug cannot change");
    check(parsed.data, cfg, providers);
    spec = parsed.data; version = cur.version + 1;
  }
  const enabled = patch.enabled ?? cur.enabled;
  if (enabled && patch.spec === undefined) check(TemplateSpec.parse(cur.spec), cfg, providers);
  return withTx(db, async (c) => {
    const row = (await c.query("UPDATE templates SET enabled=$2, spec=$3, version=$4, category=$5, tag=$6, updated_at=now() WHERE id=$1 RETURNING *", [id, enabled, JSON.stringify(spec), version, spec.category, spec.tag ?? null])).rows[0];
    // Revisions are immutable: queued/running jobs keep reading the revision they were scheduled with.
    if (version !== cur.version) await c.query("INSERT INTO template_revisions(template_id, version, spec) VALUES ($1,$2,$3)", [id, version, JSON.stringify(spec)]);
    return row;
  });
}

/** The frozen specification a job was scheduled with. Never the mutable template row. */
export async function loadRevision(db: Db, templateId: string, version: number): Promise<TemplateSpec> {
  const r = await db.query("SELECT spec FROM template_revisions WHERE template_id=$1 AND version=$2", [templateId, version]);
  if (!r.rowCount) throw new TemplateError("revision_missing", `template ${templateId} revision ${version} not found`);
  return TemplateSpec.parse(r.rows[0].spec);
}
