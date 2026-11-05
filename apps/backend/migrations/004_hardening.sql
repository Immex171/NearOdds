-- Snapshot boundaries: history is always recorded; the account/offer snapshot only takes events NEWER than snapshot_height.
ALTER TABLE markets ADD COLUMN snapshot_height bigint;   -- block at which account/offer/withdrawal snapshot was last anchored (reconcile)
ALTER TABLE markets ADD COLUMN applied_height bigint;    -- highest block whose events changed the snapshot
UPDATE markets SET snapshot_height = (reconcile->>'blockHeight')::bigint, applied_height = (reconcile->>'blockHeight')::bigint WHERE reconcile IS NOT NULL;

-- Unresolved indexing gaps (provider could not prove a height is skipped).
CREATE TABLE index_gaps (
  id              bigserial PRIMARY KEY,
  scope           text NOT NULL,                  -- 'main' or a market_ref (catch-up)
  from_height     bigint NOT NULL,
  to_height       bigint NOT NULL,
  reason          text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  resolved_at     timestamptz,
  UNIQUE (scope, from_height, to_height)
);

-- Immutable template revisions: jobs reference (template_id, version), never the mutable template row.
CREATE TABLE template_revisions (
  template_id bigint NOT NULL REFERENCES templates(id),
  version     int NOT NULL,
  spec        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);
INSERT INTO template_revisions(template_id, version, spec) SELECT id, version, spec FROM templates;

-- Budget accounting, separate from job status. committed = spent (if funding was sent) else reserved, minus recovered.
CREATE TABLE budget_reservations (
  job_id         bigint PRIMARY KEY REFERENCES jobs(id),
  template_id    bigint NOT NULL,
  reserved_yocto numeric(40,0) NOT NULL,
  spent_yocto    numeric(40,0) NOT NULL DEFAULT 0,   -- funding confirmed/possibly transferred onchain
  recovered_yocto numeric(40,0) NOT NULL DEFAULT 0,  -- funds confirmed recovered by an operator
  state          text NOT NULL,                      -- reserved | spent | released
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_tpl ON budget_reservations (template_id);
