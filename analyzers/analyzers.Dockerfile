# Cognitive-complexity analyzers for hooks/complexity.mjs, in one image:
# eslint-plugin-sonarjs (JS/TS), complexipy (Python) and gocognit (Go).
# Build context is the folder holding hooks/ and analyzers/ (repository root, or .claude/).

FROM golang:1.26-bookworm AS go
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/uudashr/gocognit/cmd/gocognit@v1.3.0

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages complexipy==8.3.0 \
  && apt-get purge -y python3-pip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=go /out/gocognit /usr/local/bin/gocognit

WORKDIR /opt/analyzers
RUN npm init -y >/dev/null \
  && npm install --no-audit --no-fund \
    eslint@10.14.0 eslint-plugin-sonarjs@4.2.2 typescript-eslint@8.72.1 typescript@6.0.3 \
  && npm cache clean --force
COPY hooks/complexity.mjs ./complexity.mjs

USER node
# Kept running so the hook can `docker exec` into it in well under a second.
CMD ["sleep", "infinity"]
