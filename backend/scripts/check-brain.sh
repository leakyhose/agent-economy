#!/usr/bin/env bash
# Check a provider on its own: no chain, no validator, no ledger — just the model, the tools
# and one decision each. Cheap enough to run before every LLM run.
#
#   backend/scripts/check-brain.sh             one real decision each, PROVIDER from .env
#   PROVIDER=deepinfra AGENTS=3 backend/scripts/check-brain.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node backend/scripts/check-brain.mjs "$@"
