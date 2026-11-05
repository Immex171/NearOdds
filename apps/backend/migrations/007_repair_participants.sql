-- Upgrade repair (idempotent): discover participants from the events already persisted by earlier indexer versions.
-- Accounts named by account_id / owner_id / maker_id / taker_id in chain_events that are missing from market_participants are added
-- with their EARLIEST recorded height and left PENDING hydration (hydrated_at NULL). Existing rows (and their hydration state),
-- balances, fills, volume, receipt dedupe and checkpoints are untouched. Re-running inserts nothing.
INSERT INTO market_participants(market_ref, account_id, first_seen_height)
SELECT market_ref, acct, MIN(block_height)
FROM (
  SELECT e.market_ref, e.block_height, e.data ->> k.key AS acct
  FROM chain_events e CROSS JOIN (VALUES ('account_id'), ('owner_id'), ('maker_id'), ('taker_id')) AS k(key)
) t
WHERE acct IS NOT NULL
GROUP BY market_ref, acct
ON CONFLICT (market_ref, account_id) DO NOTHING;
