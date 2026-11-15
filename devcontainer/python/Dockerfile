# Dev container for Python projects. This file is the source of truth:
# devcontainer.json is generated from it (`npx ai-stones sync`).
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

# postCreateCommand also installs dev dependencies (PEP 735 `dev` group, a
# `dev` extra, requirements-dev.txt) so lint, typecheck and test gates run.
LABEL devcontainer.metadata='{"customizations":{"vscode":{"extensions":["ms-python.python","charliermarsh.ruff","anthropic.claude-code"]}},"postCreateCommand":"pip install -q --upgrade pip; if [ -f pyproject.toml ]; then pip install -e . && { pip install --group dev 2>/dev/null || pip install -e .[dev] 2>/dev/null || true; }; elif [ -f requirements.txt ]; then pip install -r requirements.txt; fi; for f in requirements-dev.txt dev-requirements.txt; do if [ -f $f ]; then pip install -r $f; fi; done"}'
