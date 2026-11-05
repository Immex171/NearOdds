-- Project-owned market-making bot. Chain views authorise spending; these tables hold intent, commitments and history.
CREATE TABLE trading_bots (
  id              bigserial PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  account_id      text NOT NULL,
  network         text NOT NULL,
  credentials_env text NOT NULL DEFAULT 'BOT_CREDENTIALS_FILE',   -- NAME of the env var holding the credentials file path
  mode            text NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','execute')),
  desired_state   text NOT NULL DEFAULT 'disabled' CHECK (desired_state IN ('disabled','running','paused','stopped')),
  state           text NOT NULL DEFAULT 'disabled',               -- derived operating state (persisted for status/monitoring)
  state_reason    text,
  config_version  int NOT NULL DEFAULT 1,
  config          jsonb NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trading_bot_configs (
  bot_id     bigint NOT NULL REFERENCES trading_bots(id),
  version    int NOT NULL,
  config     jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, version)
);

-- Every chain-affecting intention. op_key is stable and doubles as the tx_journal op key.
CREATE TABLE bot_operations (
  id             bigserial PRIMARY KEY,
  bot_id         bigint NOT NULL REFERENCES trading_bots(id),
  market_ref     text NOT NULL REFERENCES markets(market_ref),
  config_version int NOT NULL,
  kind           text NOT NULL,        -- register_token | register_market | deposit | split | create_offer | cancel_offer
  slot           text,                 -- YES_BUY | YES_SELL | NO_BUY | NO_SELL
  generation     int,
  op_key         text NOT NULL UNIQUE,
  params         jsonb NOT NULL,
  state          text NOT NULL,        -- proposed | submitted | uncertain | confirmed | failed | cancelled
  commit_collateral numeric(40,0) NOT NULL DEFAULT 0,   -- capacity reserved while the op is pending
  commit_yes     numeric(40,0) NOT NULL DEFAULT 0,
  commit_no      numeric(40,0) NOT NULL DEFAULT 0,
  commit_native  numeric(40,0) NOT NULL DEFAULT 0,
  tx_hash        text,
  result         jsonb,
  offer_id       numeric(40,0),        -- confirmed contract-local offer id
  reason         text,
  failure        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_ops_pending ON bot_operations (bot_id, market_ref) WHERE state IN ('proposed','submitted','uncertain');
CREATE INDEX bot_ops_recent ON bot_operations (bot_id, created_at);

-- Offers the bot owns (created by it, or adopted from chain). Offer ids are contract-local: keyed by market_ref.
CREATE TABLE bot_quotes (
  bot_id      bigint NOT NULL REFERENCES trading_bots(id),
  market_ref  text NOT NULL REFERENCES markets(market_ref),
  offer_id    numeric(40,0) NOT NULL,
  slot        text NOT NULL,
  price       numeric(40,0) NOT NULL,
  quantity    numeric(40,0) NOT NULL,
  remaining   numeric(40,0) NOT NULL,
  expires_at_ns numeric(40,0),
  config_version int,
  op_id       bigint REFERENCES bot_operations(id),
  origin      text NOT NULL,           -- created | adopted
  state       text NOT NULL,           -- active | filled | cancelled | gone_unconfirmed
  close_reason text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  PRIMARY KEY (bot_id, market_ref, offer_id)
);

CREATE TABLE bot_decisions (
  id          bigserial PRIMARY KEY,
  bot_id      bigint NOT NULL REFERENCES trading_bots(id),
  market_ref  text NOT NULL,
  config_version int NOT NULL,
  mode        text NOT NULL,
  outcome     text NOT NULL,           -- noop | acted | skipped | wind_down | paper | error
  actions     jsonb NOT NULL DEFAULT '[]',
  reasons     jsonb NOT NULL DEFAULT '[]',
  op_ids      jsonb NOT NULL DEFAULT '[]',
  block_height bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_decisions_idx ON bot_decisions (bot_id, id DESC);

CREATE TABLE bot_market_status (
  bot_id      bigint NOT NULL REFERENCES trading_bots(id),
  market_ref  text NOT NULL,
  last_cycle_at timestamptz,
  last_chain_read_at timestamptz,
  block_height bigint,
  snapshot    jsonb,
  needs_funding boolean NOT NULL DEFAULT false,
  last_decision_id bigint,
  PRIMARY KEY (bot_id, market_ref)
);

-- Native NEAR actually spent (registration deposits + burnt gas), recovered from the tx journal after crashes.
CREATE TABLE bot_native_spend (
  op_id  bigint PRIMARY KEY REFERENCES bot_operations(id),
  bot_id bigint NOT NULL REFERENCES trading_bots(id),
  yocto  numeric(40,0) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
