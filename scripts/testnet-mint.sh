#!/usr/bin/env bash
# Funds wallets with TEST collateral (tNOC). Only the token owner (the deployment
# parent) can mint. Registers each wallet with the token first if needed.
#   NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet \
#   NEARODDS_TOKEN=<token account from deployments/testnet-demo.json> \
#   NEARODDS_MINT="you.testnet:100,friend.testnet:50" \
#     bash scripts/testnet-mint.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?}"; : "${NEARODDS_TOKEN:?}"; : "${NEARODDS_MINT:?}"
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke mint_on_testnet -- --ignored --nocapture
