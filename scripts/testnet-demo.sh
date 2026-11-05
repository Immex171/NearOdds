#!/usr/bin/env bash
# Deploys the PERSISTENT, OPEN demo market for the frontend, with seeded
# liquidity (YES/NO sell ladders and YES bids from a liquidity-provider
# account). The market question is "Will it rain in Lagos on <date>?", where
# <date> is NEARODDS_DEMO_OBSERVATION_DATE (YYYY-MM-DD, default 2026-11-12).
# Trading stops at 00:00 WAT (UTC+1) on that date, i.e. 23:00 UTC the day before;
# the observed day ends 24 hours later. The script never resolves the market.
# Writes deployments/testnet-demo.json.
#
#   NEARODDS_TESTNET_PARENT=<account id> \
#   NEARODDS_DEMO_OBSERVATION_DATE=2026-11-12 \               # optional
#   NEARODDS_DEMO_MINT="alice.testnet:100,bob.testnet:50" \   # optional test-token recipients
#     bash scripts/testnet-demo.sh
#
# Funding (kept in sync with DEMO_FUNDING_MILLI / FEE_MARGIN_MILLI in
# contracts/market/tests/testnet_smoke.rs, checked first): token 2 + market 3 +
# liquidity provider 1.5 + probe 0.6 = 7.1 NEAR plus a 1 NEAR fee margin = 8.1 NEAR.
# The parent is the token owner and the market resolver. The key comes from
# NEARODDS_TESTNET_PARENT_KEY or ~/.near-credentials/testnet/ (checked below).
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
