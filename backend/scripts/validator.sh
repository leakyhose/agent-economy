#!/usr/bin/env bash
# Start a local validator for the village, with the program loaded at genesis.
#   backend/scripts/validator.sh            # on 8899, where the dashboard looks by default
#   RPC_PORT=8999 backend/scripts/validator.sh
# The ledger lives in a temp dir and is deleted on exit. It grows by roughly 90 MB a minute
# (rocksdb), whatever --limit-ledger-size says early on: keep a few GB free, and stop the
# validator (Ctrl-C) when you are done. A full disk kills every validator on the machine.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC_PORT=${RPC_PORT:-8899}
LEDGER_DIR=$(mktemp -d)
RPC="http://127.0.0.1:${RPC_PORT}"
cleanup() { kill "${VALIDATOR_PID:-}" 2>/dev/null || true; rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT

# The program is loaded at genesis at its declared address (an initial deploy would put it
# at chain-keypair.json's address instead, and a closed program can never be redeployed).
PROGRAM_ID=$(python3 -c "import json;print(json.load(open('chain/target/idl/chain.json'))['address'])")
solana-test-validator --reset --quiet --limit-ledger-size 10000 \
  --bpf-program "$PROGRAM_ID" chain/target/deploy/chain.so \
  --ledger "$LEDGER_DIR" --rpc-port "$RPC_PORT" --bind-address 127.0.0.1 \
  $([ "$RPC_PORT" = 8899 ] || echo "--faucet-port 9901 --gossip-port 9950 --dynamic-port-range 9910-9940") &
VALIDATOR_PID=$!
for _ in $(seq 60); do solana cluster-version --url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
solana airdrop 100 --url "$RPC" --keypair ~/.config/solana/id.json >/dev/null
echo "validator on $RPC, program $PROGRAM_ID loaded. Ctrl-C to stop (deletes the ledger)."
echo "free disk: $(df -h / | tail -1 | awk '{print $4}')"
wait "$VALIDATOR_PID"
