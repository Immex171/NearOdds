-- Native spend: separate burnt gas (always real, also for FAILED transactions) from attached deposits kept / refunded.
ALTER TABLE bot_native_spend ADD COLUMN burnt_yocto numeric(40,0) NOT NULL DEFAULT 0;
ALTER TABLE bot_native_spend ADD COLUMN deposit_yocto numeric(40,0) NOT NULL DEFAULT 0;     -- attached deposit that stayed spent (successful registrations)
ALTER TABLE bot_native_spend ADD COLUMN refunded_yocto numeric(40,0) NOT NULL DEFAULT 0;    -- attached deposit returned by a failed transaction (not spending)
ALTER TABLE bot_native_spend ADD COLUMN op_outcome text NOT NULL DEFAULT 'confirmed';
UPDATE bot_native_spend SET burnt_yocto = yocto;

-- Every account seen in ANY event of a market (historical or not), independent of the snapshot boundary.
CREATE TABLE market_participants (
  market_ref      text NOT NULL REFERENCES markets(market_ref),
  account_id      text NOT NULL,
  first_seen_height bigint NOT NULL,
  hydrated_at     timestamptz,                 -- set when the balance snapshot was read from contract views
  PRIMARY KEY (market_ref, account_id)
);
INSERT INTO market_participants(market_ref, account_id, first_seen_height, hydrated_at)
  SELECT market_ref, account_id, 0, now() FROM account_state ON CONFLICT DO NOTHING;
