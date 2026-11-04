#!/usr/bin/env bash
# Verifies the tools the build and the Sandbox tests need, and says how to fix
# anything missing. Exits non-zero if a REQUIRED tool is missing.
cd "$(dirname "$0")/.."
fail=0
need() { # <label> <command to test> <how to fix>
  if eval "$2" >/dev/null 2>&1; then echo "ok       $1"; else echo "MISSING  $1  ->  $3"; fail=1; fi
}
need "rustc (rust-toolchain.toml)" "rustc --version" "install rustup, then run: rustup show"
need "wasm32-unknown-unknown target" "rustup target list --installed | grep -q wasm32-unknown-unknown" "rustup target add wasm32-unknown-unknown"
need "C compiler / build-essential" "cc --version" "sudo apt-get install -y build-essential"
need "OpenSSL dev files (pkg-config, or OPENSSL_* vars / .cargo/config.toml)" "pkg-config --exists openssl || { [ -n \"\$OPENSSL_LIB_DIR\" ] && [ -n \"\$OPENSSL_INCLUDE_DIR\" ]; } || grep -qs OPENSSL_LIB_DIR .cargo/config.toml" "sudo apt-get install -y pkg-config libssl-dev   (see docs/demo.md for the no-pkg-config alternative)"
if cargo near --version >/dev/null 2>&1; then echo "ok       cargo-near (preferred Wasm builder)";
else echo "optional cargo-near not found -> scripts/build-wasm.sh falls back to plain cargo (cargo install cargo-near --locked --no-default-features)"; fi
echo "note     first Sandbox run downloads the near-sandbox binary (network needed)"
exit $fail
