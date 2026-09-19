#!/usr/bin/env bash
# Build, test, and deploy the registry program against a local validator.
#
#   programs/registry/build.sh            # build + test + deploy
#   programs/registry/build.sh test       # build + cargo test only
#   programs/registry/build.sh deploy     # build + deploy only
#   programs/registry/build.sh idl        # regenerate idl/registry.json
#
# Two builds come out of this, on purpose:
#
#   target/deploy/registry.so      SBPF v0 — what LiteSVM executes in `cargo test`
#   target/deploy-v3/registry.so   SBPF v3 — what the validator accepts, since
#                                  SIMD-0500 (active on recent agave) refuses to
#                                  deploy v0/v1/v2 programs
#
# keys/registry-keypair.json fixes the program id so the TypeScript client and
# every explorer link stay stable across rebuilds. It is a localnet demo key and
# is deliberately in the repo; it is not an upgrade authority.

set -euo pipefail

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPC="${AW_RPC:-http://127.0.0.1:8899}"
MODE="${1:-all}"

cd "$HERE"

if [[ "$MODE" == "idl" ]]; then
  # `anchor idl build` insists on an Anchor workspace, and this crate is
  # deliberately standalone so programs/world and programs/org can move on their
  # own schedule. Give Anchor the workspace it wants, in a scratch directory.
  WS="$(mktemp -d)"
  trap 'rm -rf "$WS"' EXIT
  mkdir -p "$WS/programs/registry"
  cp -R src Cargo.toml "$WS/programs/registry/"
  # Drop the standalone `[workspace]` marker so the copy can be a member.
  sed -i '' '/^\[workspace\]$/d' "$WS/programs/registry/Cargo.toml" 2>/dev/null \
    || sed -i '/^\[workspace\]$/d' "$WS/programs/registry/Cargo.toml"
  printf '[workspace]\nmembers = ["programs/*"]\nresolver = "2"\n' > "$WS/Cargo.toml"
  {
    echo '[toolchain]'
    echo '[features]'
    echo 'resolution = true'
    echo 'skip-lint = true'
    echo '[programs.localnet]'
    echo "registry = \"$(solana-keygen pubkey keys/registry-keypair.json)\""
    echo '[provider]'
    echo 'cluster = "localnet"'
    echo 'wallet = "~/.config/solana/id.json"'
    echo '[scripts]'
    echo 'test = "cargo test"'
  } > "$WS/Anchor.toml"
  mkdir -p idl
  (cd "$WS" && anchor idl build -o "$HERE/idl/registry.json")
  echo "wrote idl/registry.json"
  echo "if the discriminators changed, update IX_DISCRIMINATOR in"
  echo "packages/solana/src/registry.ts — the demo verifies the two agree."
  exit 0
fi

echo "==> building SBPF v0 (for LiteSVM tests)"
cargo build-sbf

if [[ "$MODE" == "all" || "$MODE" == "test" ]]; then
  echo "==> cargo test"
  cargo test
fi

if [[ "$MODE" == "all" || "$MODE" == "deploy" ]]; then
  echo "==> building SBPF v3 (for on-chain deployment)"
  cargo build-sbf --arch v3 --sbf-out-dir target/deploy-v3

  if ! solana cluster-version -u "$RPC" >/dev/null 2>&1; then
    echo "no validator at $RPC. Start one with:" >&2
    echo "  solana-test-validator --limit-ledger-size 50000000" >&2
    exit 1
  fi

  echo "==> deploying to $RPC"
  solana program deploy \
    -u "$RPC" \
    --program-id keys/registry-keypair.json \
    target/deploy-v3/registry.so
fi

echo "done. program id: $(solana-keygen pubkey keys/registry-keypair.json)"
