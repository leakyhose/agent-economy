#!/usr/bin/env bash
# Verify the SETTLERS mint against the village's books, on a validator of its own.
# Never touches port 8899: the dashboard's validator keeps running.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The Solana tools are not always on a non-interactive PATH.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC_PORT=8999
LEDGER_DIR=$(mktemp -d)
RPC="http://127.0.0.1:${RPC_PORT}"

cleanup() { kill "${VALIDATOR_PID:-}" 2>/dev/null || true; rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT

PROGRAM_ID=$(python3 -c "import json;print(json.load(open('chain/target/idl/chain.json'))['address'])")

echo "starting a validator on ${RPC_PORT} (the dashboard's stays on 8899)"
# The program is loaded at genesis at its declared address: chain-keypair.json is a
# different address, and an initial deploy would put it there instead.
solana-test-validator --reset --quiet \
  --bpf-program "$PROGRAM_ID" chain/target/deploy/chain.so \
  --ledger "$LEDGER_DIR" \
  --rpc-port "$RPC_PORT" \
  --faucet-port 9901 \
  --bind-address 127.0.0.1 \
  --gossip-port 9950 \
  --dynamic-port-range 9910-9940 &
VALIDATOR_PID=$!

for _ in $(seq 60); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done

solana airdrop 100 --url "$RPC" --keypair ~/.config/solana/id.json >/dev/null
echo "program $PROGRAM_ID loaded"

RPC="$RPC" AGENTS=3 node backend/scripts/check-settlers.mjs
