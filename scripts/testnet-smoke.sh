#!/usr/bin/env bash
# Full-lifecycle smoke test on NEAR testnet, on a THROW-AWAY market:
# deposit -> split -> offer -> partial fills -> cancel -> resale -> resolve ->
# redeem -> withdraw. Writes deployments/testnet.json (verified facts only, after
# every assertion passed). The market ends up RESOLVED: do not point the
# frontend at it (use scripts/testnet-demo.sh for that).
#
#   NEARODDS_TESTNET_PARENT=<account id> NEARODDS_TESTNET_PARENT_KEY=ed25519:... \
#     bash scripts/testnet-smoke.sh
#
# The parent is the token owner AND the market resolver, and funds the created
# accounts: 3+4+1+1+1 = 10 NEAR plus a 2 NEAR fee margin (the harness checks this
# first and stops with a clear message). The key is read from the environment
# only and is never written to disk. The run takes about 10-15 minutes because
# it waits for the 10-minute cutoff before resolving.
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
