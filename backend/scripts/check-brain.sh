#!/usr/bin/env bash
# Check a brain on its own: no chain, no validator, no ledger — just the models, the tools
# and one decision each. Cheap enough to run before every LLM run.
#
#   backend/scripts/check-brain.sh --pool      which model each villager draws (no key needed)
#   backend/scripts/check-brain.sh --list      what Baseten serves today, against our pool
#   backend/scripts/check-brain.sh             one real decision each, BRAIN from .env
#   BRAIN=openai AGENTS=3 backend/scripts/check-brain.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node backend/scripts/check-brain.mjs "$@"
