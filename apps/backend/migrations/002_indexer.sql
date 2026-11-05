CREATE TABLE indexer_checkpoints (
  name        text PRIMARY KEY,
  height      bigint NOT NULL,
  block_hash  text,
  block_ts_ns numeric(40,0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per parsed EVENT_JSON log. Dedup key = (receipt_id, log_index).
CREATE TABLE chain_events (
  id          bigserial PRIMARY KEY,
  market_ref  text NOT NULL REFERENCES markets(market_ref),
  receipt_id  text NOT NULL,
  log_index   int NOT NULL,
  block_height bigint NOT NULL,
  block_ts_ns numeric(40,0) NOT NULL,
  event       text NOT NULL,
  data        jsonb NOT NULL,
  tx_hash     text,
  UNIQUE (receipt_id, log_index)
);
CREATE INDEX chain_events_market ON chain_events (market_ref, id);

CREATE TABLE offers (
  market_ref   text NOT NULL REFERENCES markets(market_ref),
  offer_id     numeric(40,0) NOT NULL,
  owner_id     text NOT NULL,
  outcome      text NOT NULL,
  side         text NOT NULL,
  price        numeric(40,0) NOT NULL,
  quantity     numeric(40,0) NOT NULL,
  remaining    numeric(40,0) NOT NULL,
  expires_at_ns numeric(40,0),
  created_ns   numeric(40,0) NOT NULL,
  state        text NOT NULL,                     -- open | filled | cancelled | released
  reserved_collateral numeric(40,0) NOT NULL DEFAULT 0,
  reserved_shares numeric(40,0) NOT NULL DEFAULT 0,
  closed_receipt text,
  updated_height bigint NOT NULL,
  PRIMARY KEY (market_ref, offer_id)
);
CREATE INDEX offers_book ON offers (market_ref, outcome, side, price) WHERE state = 'open';
CREATE INDEX offers_owner ON offers (market_ref, owner_id);

-- Confirmed fills; volume = SUM(collateral_amount) here, counted once per (receipt, log).
CREATE TABLE fills (
  id          bigserial PRIMARY KEY,
  market_ref  text NOT NULL REFERENCES markets(market_ref),
  receipt_id  text NOT NULL,
  log_index   int NOT NULL,
  offer_id    numeric(40,0) NOT NULL,
  maker_id    text NOT NULL,
  taker_id    text NOT NULL,
  outcome     text NOT NULL,
  maker_side  text NOT NULL,
  price       numeric(40,0) NOT NULL,
  quantity    numeric(40,0) NOT NULL,
  collateral_amount numeric(40,0) NOT NULL,
  block_height bigint NOT NULL,
  ts_ns       numeric(40,0) NOT NULL,
  UNIQUE (receipt_id, log_index)
);
CREATE INDEX fills_market_ts ON fills (market_ref, ts_ns);

-- Event-derived account balances (reconciled against views).
CREATE TABLE account_state (
  market_ref  text NOT NULL REFERENCES markets(market_ref),
  account_id  text NOT NULL,
  registered  boolean NOT NULL DEFAULT false,
  available_collateral numeric(40,0) NOT NULL DEFAULT 0,
  reserved_collateral  numeric(40,0) NOT NULL DEFAULT 0,
  yes numeric(40,0) NOT NULL DEFAULT 0,
  no  numeric(40,0) NOT NULL DEFAULT 0,
  reserved_yes numeric(40,0) NOT NULL DEFAULT 0,
  reserved_no  numeric(40,0) NOT NULL DEFAULT 0,
  pending_withdrawal_amount numeric(40,0) NOT NULL DEFAULT 0,
  redeemed    boolean NOT NULL DEFAULT false,
  last_reconciled_height bigint,
  drift       jsonb,
  updated_height bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (market_ref, account_id)
);

CREATE TABLE withdrawals (
  market_ref   text NOT NULL REFERENCES markets(market_ref),
  withdrawal_id numeric(40,0) NOT NULL,
  account_id   text NOT NULL,
  receiver_id  text,
  amount       numeric(40,0) NOT NULL,
  status       text NOT NULL,                    -- Pending | Completed | FailedRestored
  requested_ns numeric(40,0) NOT NULL,
  settled_ns   numeric(40,0),
  PRIMARY KEY (market_ref, withdrawal_id)
);
CREATE INDEX withdrawals_acct ON withdrawals (market_ref, account_id);

CREATE TABLE activity (
  id          bigserial PRIMARY KEY,
  market_ref  text NOT NULL REFERENCES markets(market_ref),
  account_id  text NOT NULL,
  kind        text NOT NULL,
  amount      numeric(40,0),
  detail      jsonb NOT NULL DEFAULT '{}',
  receipt_id  text NOT NULL,
  log_index   int NOT NULL,
  ts_ns       numeric(40,0) NOT NULL,
  UNIQUE (receipt_id, log_index, account_id, kind)
);
CREATE INDEX activity_acct ON activity (account_id, id DESC);
CREATE INDEX activity_market ON activity (market_ref, id DESC);

-- SSE fan-out: workers/indexer insert; API polls by id and pushes.
CREATE TABLE stream_events (
  id          bigserial PRIMARY KEY,
  market_ref  text,
  account_id  text,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
