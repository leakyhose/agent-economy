#!/usr/bin/env bash
# Put the program and a village on devnet, where anyone can look them up.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC=https://api.devnet.solana.com
KEY=~/.config/solana/id.json
PROGRAM_ID=$(python3 -c "import json;print(json.load(open('chain/target/idl/chain.json'))['address'])")
ADDR=$(solana-keygen pubkey "$KEY")
NEEDED=2.3

BAL=$(solana balance --url "$RPC" --keypair "$KEY" | awk '{print $1}')
echo "wallet  $ADDR"
echo "balance $BAL SOL   (deploying needs about $NEEDED)"

if ! awk -v b="$BAL" -v n="$NEEDED" 'BEGIN{exit !(b+0 >= n+0)}'; then
  cat <<MSG

Not enough devnet SOL, and the command-line faucet is refusing requests.

Get some, then run this again:
  - https://faucet.solana.com  — paste $ADDR (needs a GitHub login; 0.5-5 SOL a day)
  - or retry the CLI later, the public faucet comes and goes:
      solana airdrop 2 --url $RPC

MSG
  exit 1
fi

if solana program show "$PROGRAM_ID" --url "$RPC" >/dev/null 2>&1; then
  echo "program already on devnet, upgrading it"
else
  echo "deploying the program (214K, about 1.11 SOL of rent)"
fi
solana program deploy chain/target/deploy/chain.so \
  --program-id chain/target/deploy/chain-keypair.json \
  --url "$RPC" --keypair "$KEY"

echo
RPC="$RPC" node backend/scripts/devnet-demo.mjs
