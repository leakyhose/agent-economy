#!/usr/bin/env bash
# Start a local validator for the village, with the program loaded at genesis.
#   backend/scripts/validator.sh            # on 8899, where the dashboard looks by default
#   RPC_PORT=8999 backend/scripts/validator.sh
#   TICKS_PER_SLOT=64 backend/scripts/validator.sh   # Solana's own 400ms slots, if you want them
#
# TICKS_PER_SLOT is the single biggest dial on how long a round takes. Almost all of a
# round's chain time is waiting for confirmations, and a confirmation can't come sooner
# than a slot: 64 ticks is Solana's 400ms, 16 is about a quarter of that. Measured at 100
# agents: 2.35s of chain a round at 64, 1.14s at 16. 16 is the default here, because the
# village is watched live and the market has to be seen answering.
#
# Nothing about the economy changes with it. The backend measures the real slot length at
# startup and writes the bank's terms in slots per round from it, and the rate itself is a
# rate per ROUND (CFG.BANK.RATE_PER_ROUND), so shorter slots no longer make credit cheaper.
# The blockhash cache is retired well inside 150 slots (chain.mjs BLOCKHASH_TTL), which is
# what "Blockhash not found" used to be at short slots.
#
# The cost: about twice the CPU of 64 ticks, and a ledger that grows faster. Set
# TICKS_PER_SLOT=64 for a long unattended run, or on a machine that is already busy.
# The ledger lives in a temp dir and is deleted on exit. It grows by roughly 90 MB a minute
# (rocksdb), whatever --limit-ledger-size says early on: keep a few GB free, and stop the
# validator (Ctrl-C) when you are done. A full disk kills every validator on the machine.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC_PORT=${RPC_PORT:-8899}
TICKS_PER_SLOT=${TICKS_PER_SLOT:-16}
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
  ${TICKS_PER_SLOT:+--ticks-per-slot "$TICKS_PER_SLOT"} \
  $([ "$RPC_PORT" = 8899 ] || echo "--faucet-port 9901 --gossip-port 9950 --dynamic-port-range 9910-9940") &
VALIDATOR_PID=$!
for _ in $(seq 60); do solana cluster-version --url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
solana airdrop 100 --url "$RPC" --keypair ~/.config/solana/id.json >/dev/null
echo "validator on $RPC, program $PROGRAM_ID loaded. Ctrl-C to stop (deletes the ledger)."
echo "free disk: $(df -h / | tail -1 | awk '{print $4}')"
wait "$VALIDATOR_PID"
