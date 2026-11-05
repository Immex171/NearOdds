import type { Config } from "../config/index.js";
import type { Db } from "../db/index.js";
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
    const r = await db.query("INSERT INTO templates(slug, enabled, category, tag, spec, created_by) VALUES ($1,false,$2,$3,$4,$5) RETURNING *", [parsed.data.slug, parsed.data.category, parsed.data.tag ?? null, JSON.stringify(parsed.data), createdBy]);
    return r.rows[0];
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
  return (await db.query("UPDATE templates SET enabled=$2, spec=$3, version=$4, updated_at=now() WHERE id=$1 RETURNING *", [id, enabled, JSON.stringify(spec), version])).rows[0];
}
