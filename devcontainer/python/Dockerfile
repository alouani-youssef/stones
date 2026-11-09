# Dev container for Python projects. This file is the source of truth:
# devcontainer.json is generated from it (`npx claude-stones sync`).
ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.13
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM python:${PYTHON_VERSION}-bookworm

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
  && mkdir -p /workspace && chown dev:dev /workspace

USER dev
RUN python -m venv /home/dev/.venv
ENV VIRTUAL_ENV=/home/dev/.venv
ENV PATH=/home/dev/.venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace
EXPOSE 8000

LABEL devcontainer.metadata='{"customizations":{"vscode":{"extensions":["ms-python.python","charliermarsh.ruff","anthropic.claude-code"]}},"postCreateCommand":"if [ -f pyproject.toml ]; then pip install -e .; elif [ -f requirements.txt ]; then pip install -r requirements.txt; fi"}'
