#!/usr/bin/env bash
# Full-lifecycle smoke test on NEAR testnet, on a THROW-AWAY market:
# deposit -> split -> offer -> partial fills -> cancel -> resale -> resolve ->
# redeem -> withdraw. Writes deployments/testnet.json (verified facts only, after
# every assertion passed). The market ends up RESOLVED: do not point the
# frontend at it (use scripts/testnet-demo.sh for that).
#
#   NEARODDS_TESTNET_PARENT=<account id> bash scripts/testnet-smoke.sh
#
# The parent is the token owner AND the market resolver, and funds the created
# accounts (kept in sync with SMOKE_FUNDING_MILLI / FEE_MARGIN_MILLI in
# contracts/market/tests/testnet_smoke.rs): token 2 + market 3 + alice/bob/carol
# 0.5 each = 6.5 NEAR plus a 1 NEAR fee margin = 7.5 NEAR (checked first; the run
# stops with the exact shortfall). The parent's key is read from
# NEARODDS_TESTNET_PARENT_KEY or ~/.near-credentials/testnet/. Throw-away
# sub-account keys are written (exclusively, mode 600) to that directory BEFORE the
# accounts are created. The run takes about 10-20 minutes because it waits for the
# 10-minute cutoff before resolving. If a transaction's outcome cannot be read the
# run stops as UNCERTAIN and never re-signs it: see docs/testnet.md "Uncertain
# transactions".
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?set NEARODDS_TESTNET_PARENT to a funded testnet account id}"
# The key comes from NEARODDS_TESTNET_PARENT_KEY or, if unset, from
# ~/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json (mode 600). Never from the repo.
if [ -z "${NEARODDS_TESTNET_PARENT_KEY:-}" ] && [ ! -f "$HOME/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json" ]; then
  echo "no NEARODDS_TESTNET_PARENT_KEY and no ~/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json" >&2; exit 1
fi
bash scripts/build-wasm.sh
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke smoke_on_testnet -- --ignored --nocapture
echo "Facts written to deployments/testnet.json"
