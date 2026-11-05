#!/usr/bin/env bash
# Deploys the PERSISTENT, OPEN demo market for the frontend, with seeded
# liquidity (YES/NO sell ladders and YES bids from a liquidity-provider
# account). The market is left open for NEARODDS_DEMO_CUTOFF_DAYS (default 7)
# and is never resolved by this script. Writes deployments/testnet-demo.json.
#
#   NEARODDS_TESTNET_PARENT=<account id> NEARODDS_TESTNET_PARENT_KEY=ed25519:... \
#   NEARODDS_DEMO_MINT="alice.testnet:100,bob.testnet:50" \   # optional test-token recipients
#     bash scripts/testnet-demo.sh
#
# Funding: 3+4+2 = 9 NEAR plus a 2 NEAR fee margin (checked first). The parent
# is the token owner and the market resolver; resolve later with
# `resolve_market` signed by the parent after the cutoff.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?set NEARODDS_TESTNET_PARENT to a funded testnet account id}"
# The key comes from NEARODDS_TESTNET_PARENT_KEY or, if unset, from
# ~/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json (mode 600). Never from the repo.
if [ -z "${NEARODDS_TESTNET_PARENT_KEY:-}" ] && [ ! -f "$HOME/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json" ]; then
  echo "no NEARODDS_TESTNET_PARENT_KEY and no ~/.near-credentials/testnet/$NEARODDS_TESTNET_PARENT.json" >&2; exit 1
fi
bash scripts/build-wasm.sh
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke demo_on_testnet -- --ignored --nocapture
echo "Facts written to deployments/testnet-demo.json"
