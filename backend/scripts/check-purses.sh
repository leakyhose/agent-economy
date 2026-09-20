#!/usr/bin/env bash
# Verify that agents hold and pay each other in real SETTLERS, on a validator of its own.
# Never touches port 8899: the dashboard's validator keeps running.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The Solana tools are not always on a non-interactive PATH.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# rpc_port + 1 is the websocket port, so 8997 keeps clear of check-settlers.sh on 8999.
RPC_PORT=8997
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
  --faucet-port 9801 \
  --bind-address 127.0.0.1 \
  --gossip-port 9850 \
  --dynamic-port-range 9810-9840 &
VALIDATOR_PID=$!

for _ in $(seq 60); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done

# RPC answering is not the same as blocks being produced. Without this the first burst
# of transactions races the validator's startup and dies on "Unable to obtain a new
# blockhash", which looks like a bug in the program and is not one.
LAST=0
for _ in $(seq 60); do
  NOW=$(solana slot --url "$RPC" 2>/dev/null || echo 0)
  if [ "${NOW:-0}" -gt 8 ] && [ "${NOW:-0}" -gt "$LAST" ]; then break; fi
  LAST=${NOW:-0}
  sleep 1
done

solana airdrop 100 --url "$RPC" --keypair ~/.config/solana/id.json >/dev/null
echo "program $PROGRAM_ID loaded"

RPC="$RPC" node backend/scripts/check-purses.mjs
