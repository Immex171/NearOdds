CREATE TABLE auth_nonces (
  nonce      text PRIMARY KEY,                    -- hex of 32 random bytes
  account_id text NOT NULL,
  message    text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL,
  public_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE watchlist (
  account_id text NOT NULL,
  market_ref text NOT NULL REFERENCES markets(market_ref),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, market_ref)
);

CREATE TABLE resolution_proposals (
  id            bigserial PRIMARY KEY,
  market_ref    text NOT NULL REFERENCES markets(market_ref),
  outcome       text NOT NULL CHECK (outcome IN ('Yes','No')),
  evidence_ref  text NOT NULL,                    -- <= 512 bytes, goes on chain
  evidence_note text,
  observation_start_ns numeric(40,0),
  observation_end_ns   numeric(40,0),
  retrieved_at  timestamptz NOT NULL,
  proposed_by   text NOT NULL,                    -- admin account or provider id
  provider      text,
  decision      text NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | submitted
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  job_id        bigint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- At most one live (pending/approved/submitted) proposal per market.
CREATE UNIQUE INDEX resolution_one_live ON resolution_proposals (market_ref) WHERE decision IN ('pending','approved','submitted');

CREATE TABLE faucet_claims (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL,
  amount      numeric(40,0) NOT NULL,
  request_key text NOT NULL UNIQUE,               -- account + client idempotency key
  job_id      bigint,
  state       text NOT NULL DEFAULT 'queued',     -- queued | minted | failed
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faucet_acct ON faucet_claims (account_id);
CREATE TABLE native_spend (
  id        bigserial PRIMARY KEY,
  purpose   text NOT NULL,
  yocto     numeric(40,0) NOT NULL,
  ref       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Resolution conditions are tracked separately: cutoff passed, observation complete, evidence available.
CREATE TABLE resolution_watch (
  market_ref           text PRIMARY KEY REFERENCES markets(market_ref),
  policy               text NOT NULL DEFAULT 'reviewed',   -- reviewed | automatic
  provider             text,
  cutoff_passed        boolean NOT NULL DEFAULT false,
  observation_complete boolean NOT NULL DEFAULT false,
  evidence_state       text NOT NULL DEFAULT 'missing',    -- missing | proposed | approved | ambiguous | provider_error | submitted
  note                 text,
  last_checked_at      timestamptz
);
