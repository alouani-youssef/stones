# Dev container for Go projects. This file is the source of truth:
# devcontainer.json is generated from it (`npx ai-stones sync`).
ARG NODE_VERSION=22
ARG GO_VERSION=1.25
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM golang:${GO_VERSION}-bookworm

ARG CLAUDE_CODE_VERSION=latest

# Node runs the stones hooks and Claude Code.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# git, jq for the status line, bubblewrap + socat for the Claude Code sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq bubblewrap socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && useradd --create-home --shell /bin/bash dev \
  && mkdir -p /workspace /go/pkg && chown -R dev:dev /workspace /go

USER dev
ENV GOPATH=/go
ENV GOTOOLCHAIN=local
WORKDIR /workspace
EXPOSE 8080

LABEL devcontainer.metadata='{"customizations":{"vscode":{"extensions":["golang.go","anthropic.claude-code"]}},"postCreateCommand":"if [ -f go.mod ]; then go mod download; fi"}'
