#!/usr/bin/env bash
# Resolves a market as its configured resolver, after the cutoff. One-way and final.
#   NEARODDS_TESTNET_PARENT=nearodds-deploy.testnet \
#   NEARODDS_MARKET=<market account> NEARODDS_OUTCOME=Yes \
#   NEARODDS_EVIDENCE="https://source.example/report" \
#     bash scripts/testnet-resolve.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${NEARODDS_TESTNET_PARENT:?}"; : "${NEARODDS_MARKET:?}"; : "${NEARODDS_OUTCOME:?}"; : "${NEARODDS_EVIDENCE:?}"
NEARODDS_SKIP_WASM_BUILD=1 cargo test -p nearodds-market --test testnet_smoke resolve_on_testnet -- --ignored --nocapture
