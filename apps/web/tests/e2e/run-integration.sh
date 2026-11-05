#!/usr/bin/env bash
# Builds the frontend with the test-wallet seam into .next-e2e, serves it on :3100, runs the browser checks against the
# fixture backend/chain, and stops the server. Needs Google Chrome (CHROME_PATH to override).
set -euo pipefail
cd "$(dirname "$0")/../.."
export NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_E2E_WALLET=1 NEXT_PUBLIC_API_URL=http://localhost:4100 NEXT_PUBLIC_RPC_URL=http://localhost:4200 NEXT_PUBLIC_NETWORK=testnet
[ "${SKIP_BUILD:-0}" = "1" ] || ./node_modules/.bin/next build >/dev/null
./node_modules/.bin/next start -p 3100 >/tmp/nearodds-e2e-web.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -sf http://localhost:3100 >/dev/null && break; sleep 0.5; done
WEB_ORIGIN=http://localhost:3100 node tests/e2e/integration.mjs
