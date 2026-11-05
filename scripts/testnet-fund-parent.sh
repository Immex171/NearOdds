#!/usr/bin/env bash
# Moves the NEAR from faucet-created helper accounts into the deployment parent.
#   NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet \
#   NEARODDS_FUND_FROM="nearodds-fund-a.testnet,nearodds-fund-b.testnet" \
#     bash scripts/testnet-fund-parent.sh
# Keys are read from ~/.near-credentials/testnet/<id>.json and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?}"
: "${NEARODDS_FUND_FROM:?}"
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke consolidate_funds_on_testnet -- --ignored --nocapture
