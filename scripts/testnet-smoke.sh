#!/usr/bin/env bash
# Deploys fresh sub-accounts of a FUNDED testnet parent account, runs the
# deposit -> split -> offer -> partial fills -> cancel -> resale -> merge ->
# withdraw smoke test, and writes deployments/testnet.json.
#
#   NEARODDS_TESTNET_PARENT=<account id> NEARODDS_TESTNET_PARENT_KEY=ed25519:... \
#     bash scripts/testnet-smoke.sh
#
# The parent needs about 20 NEAR (accounts are funded from it). The key is read
# from the environment only; it is never written to disk by this script.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?set NEARODDS_TESTNET_PARENT to a funded testnet account id}"
: "${NEARODDS_TESTNET_PARENT_KEY:?set NEARODDS_TESTNET_PARENT_KEY to its ed25519 full-access secret key}"
bash scripts/build-wasm.sh
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke smoke_on_testnet -- --ignored --nocapture
echo "Facts written to deployments/testnet.json"
