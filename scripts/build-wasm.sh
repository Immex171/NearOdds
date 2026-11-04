#!/usr/bin/env bash
# Builds the three Wasm artifacts used by the Sandbox tests and by deployment:
#   target/wasm/market.wasm                    production market contract
#   target/wasm/market_failure_injection.wasm  TEST-ONLY (callback gas too small) - never deploy
#   target/wasm/test_collateral.wasm           test-only NEP-141 fixture
#
# Uses `cargo near build non-reproducible-wasm` when cargo-near is installed,
# otherwise falls back to a plain cargo build for wasm32-unknown-unknown with
# -C target-cpu=mvp (see docs/demo.md for what was used to produce the results).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$PWD/target/wasm"
mkdir -p "$OUT"

build_with_cargo_near() { # <crate dir> <crate wasm name> <out name> [extra cargo-near args...]
  local dir=$1 wasm=$2 out=$3; shift 3
  local tmp; tmp=$(mktemp -d)
  (cd "contracts/$dir" && cargo near build non-reproducible-wasm --no-abi --out-dir "$tmp" "$@")
  cp "$tmp/$wasm.wasm" "$OUT/$out.wasm"
  rm -rf "$tmp"
}

build_with_cargo() { # <package> <crate wasm name> <out name> <target dir> [extra cargo args...]
  local pkg=$1 wasm=$2 out=$3 tdir=$4; shift 4
  RUSTFLAGS="-C target-cpu=mvp" cargo build --release --locked \
    --target wasm32-unknown-unknown --target-dir "$tdir" -p "$pkg" "$@"
  cp "$tdir/wasm32-unknown-unknown/release/$wasm.wasm" "$OUT/$out.wasm"
}

if cargo near --version >/dev/null 2>&1 && [ "${NEARODDS_NO_CARGO_NEAR:-0}" != "1" ]; then
  echo ">> building with cargo-near"
  build_with_cargo_near market nearodds_market market
  build_with_cargo_near market nearodds_market market_failure_injection --features test-failure-injection
  build_with_cargo_near test-collateral test_collateral test_collateral
else
  echo ">> cargo-near not found: building with plain cargo (target-cpu=mvp)"
  build_with_cargo nearodds-market nearodds_market market target/wasm-build/market
  build_with_cargo nearodds-market nearodds_market market_failure_injection target/wasm-build/inject \
    --features test-failure-injection
  build_with_cargo test-collateral test_collateral test_collateral target/wasm-build/token
fi
ls -l "$OUT"
