-- Core registry, templates, durable jobs and transaction journal.
CREATE TABLE markets (
  market_ref        text PRIMARY KEY,                       -- stable public id, e.g. m_<hash>
  network           text NOT NULL,
  contract_id       text NOT NULL,
  internal_market_id text NOT NULL,
  token_id          text NOT NULL,
  question          text NOT NULL,
  rules             text NOT NULL,
  resolution_source text NOT NULL,
  cutoff_ns         numeric(40,0) NOT NULL,
  resolver_id       text NOT NULL,
  category          text,
  tag               text,
  template_id       bigint,
  occurrence_key    text,
  observation_start_ns numeric(40,0),
  observation_end_ns   numeric(40,0),
  token_meta        jsonb NOT NULL,
  config            jsonb NOT NULL,
  contract_status   text NOT NULL DEFAULT 'Open',          -- cached get_market().status
  resolution        jsonb,
  outstanding_yes   numeric(40,0) NOT NULL DEFAULT 0,
  outstanding_no    numeric(40,0) NOT NULL DEFAULT 0,
  market_backing    numeric(40,0) NOT NULL DEFAULT 0,
  source            text NOT NULL,                         -- 'imported-demo' | 'keeper'
  history_start_height bigint,                             -- first block we have events from
  history_complete  boolean NOT NULL DEFAULT false,
  indexed_through   bigint,                                -- catch-up progress; NULL = indexed from the live checkpoint onward
  reconcile         jsonb,
  verified_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network, contract_id, internal_market_id)
);
CREATE UNIQUE INDEX markets_contract_uq ON markets (network, contract_id);

CREATE TABLE deployment_records (
  id               bigserial PRIMARY KEY,
  market_ref       text UNIQUE REFERENCES markets(market_ref),
  job_id           bigint UNIQUE,
  contract_id      text NOT NULL,
  deployer_id      text NOT NULL,
  init_args        jsonb NOT NULL,
  artifact_id      text NOT NULL,
  artifact_version text NOT NULL,
  artifact_sha256  text NOT NULL,
  code_hash_base58 text,
  source_version   text NOT NULL,
  accounts         jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'published',
  tx_hashes        jsonb NOT NULL DEFAULT '{}',
  verification     jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id              bigserial PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  version         int NOT NULL DEFAULT 1,
  enabled         boolean NOT NULL DEFAULT false,
  category        text,
  tag             text,
  spec            jsonb NOT NULL,                -- validated TemplateSpec (see keeper/template.ts)
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_scheduled_for timestamptz                 -- last occurrence the scheduler enqueued
);

CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,                     -- create_market | resolve_market | mint_tnoc
  dedupe_key   text NOT NULL UNIQUE,              -- e.g. tpl:<slug>:v1:2026-11-12
  state        text NOT NULL,                     -- see keeper/jobs.ts
  payload      jsonb NOT NULL DEFAULT '{}',
  step         text,
  owner        text,                              -- worker id holding the lease
  lease_until  timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  run_after    timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_runnable ON jobs (state, run_after);

-- Keys. Secret material lives in the keystore directory (0600, O_EXCL create); the DB only references it.
CREATE TABLE key_refs (
  account_id   text NOT NULL,
  public_key   text NOT NULL,
  secret_ref   text NOT NULL,                     -- keystore file name
  purpose      text NOT NULL,
  job_id       bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, public_key),
  UNIQUE (secret_ref)
);

-- One row per signer account+key; the row lock serialises nonce allocation across workers.
CREATE TABLE signer_nonces (
  signer_id    text NOT NULL,
  public_key   text NOT NULL,
  last_nonce   numeric(40,0) NOT NULL DEFAULT 0,
  PRIMARY KEY (signer_id, public_key)
);

-- Every signed transaction is persisted BEFORE it is broadcast. Re-sending uses the same bytes/hash.
CREATE TABLE tx_journal (
  id           bigserial PRIMARY KEY,
  job_id       bigint REFERENCES jobs(id),
  op_key       text NOT NULL UNIQUE,              -- logical operation id: one signed tx per op, ever
  signer_id    text NOT NULL,
  public_key   text NOT NULL,
  receiver_id  text NOT NULL,
  description  text NOT NULL,
  nonce        numeric(40,0) NOT NULL,
  block_hash   text NOT NULL,
  tx_hash      text NOT NULL UNIQUE,
  signed_tx_b64 text NOT NULL,
  state        text NOT NULL,                     -- prepared | broadcast | uncertain | succeeded | failed
  outcome      jsonb,
  failure      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tx_journal_state ON tx_journal (state);

CREATE TABLE worker_heartbeats (
  worker_id  text PRIMARY KEY,
  role       text NOT NULL,
  info       jsonb NOT NULL DEFAULT '{}',
  beat_at    timestamptz NOT NULL DEFAULT now()
);
