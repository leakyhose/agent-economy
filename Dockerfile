# The hosted site: one container that serves the island and the dashboard, runs the village,
# and starts a Solana validator of its own for each run (server.mjs, MANAGED_VALIDATOR).
#   docker build -t settlers . && docker run -p 8787:8787 settlers
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 python3 procps \
 && rm -rf /var/lib/apt/lists/*

# The validator and its CLI. Agave 3 and later refuse to start without io_uring, which this
# kind of host does not allow a container (the panic is `assertion failed: io_uring_supported()`);
# 2.2 is the newest release line that runs here. It ships the classic SPL Token program and
# loads SBPF v0 only, which is why the program is shipped prebuilt in that format (below) and
# why purse transactions ask for a bigger compute budget (backend/src/chain.mjs).
ENV HOME=/root
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v2.2.20/install)"
ENV PATH="/root/.local/share/solana/install/active_release/bin:${PATH}"
# The keeper's keypair (chain.mjs reads ~/.config/solana/id.json). It only ever signs on the
# container's own throwaway validator.
RUN solana-keygen new --no-bip39-passphrase --silent -o /root/.config/solana/id.json

WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/
RUN npm --prefix backend ci --omit=dev --no-audit --no-fund
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci --no-audit --no-fund
COPY . .
# chain/target is a build output and is not in the repo: the program and its IDL are shipped
# prebuilt in chain/prebuilt. Rebuild them after any change to lib.rs:
#   cd chain/programs/chain && cargo build-sbf --arch v0 --sbf-out-dir ../../prebuilt
#   cp chain/target/idl/chain.json chain/prebuilt/chain.json
RUN npm --prefix web run build \
 && mkdir -p chain/target/deploy chain/target/idl \
 && cp chain/prebuilt/chain.so chain/target/deploy/chain.so \
 && cp chain/prebuilt/chain.json chain/target/idl/chain.json

# No API key lives here: a visitor pastes one for their own run, or plays the free scripted
# village. 400ms slots keep the validator to a fraction of a core; a run stops itself.
ENV HOSTED=1 MANAGED_VALIDATOR=1 MAX_ROUNDS=100 KEEP_RUNS=3 OPEN_BROWSER=0 AGENTS=30 PROVIDER=stub TICKS_PER_SLOT=64 NODE_ENV=production
EXPOSE 8787
CMD ["node", "backend/src/server.mjs"]
