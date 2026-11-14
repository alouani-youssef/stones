# Dev container for Node + pnpm projects. This file is the source of truth:
# devcontainer.json is generated from it (`npx ai-stones sync`).
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm

ARG CLAUDE_CODE_VERSION=latest

# git, jq for the status line, bubblewrap + socat for the Claude Code sandbox.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq bubblewrap socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace
ENV PNPM_HOME=/home/node/.local/share/pnpm
EXPOSE 3000

LABEL devcontainer.metadata='{"customizations":{"vscode":{"extensions":["dbaeumer.vscode-eslint","esbenp.prettier-vscode","anthropic.claude-code"]}},"postCreateCommand":"pnpm install"}'
