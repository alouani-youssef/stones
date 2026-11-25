#!/usr/bin/env bash
# Runs this project's GitHub Actions workflows locally with act, through the
# workflows tool, which shows the plan and asks before starting containers:
#
#   .claude/scripts/ci-local.sh [run] [options]   run the pull-request workflows (default)
#   .claude/scripts/ci-local.sh list              workflows, jobs and their events
#   .claude/scripts/ci-local.sh status            does the current code have a passing run?
#
# Options are passed to `node .claude/tools/workflows.mjs run`, e.g.
# --workflow ci.yml --job test. `list` and `run` need act and a running Docker
# engine; `status` only reads the recorded run.
set -euo pipefail

# The project root is the folder that holds .claude/, two levels above this
# script; it may be a subfolder of a larger repository.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

sub=run
case "${1:-}" in
  list | run | status) sub="$1"; shift ;;
esac

if [ "$sub" != status ]; then
  if ! command -v act >/dev/null 2>&1; then
    echo "ci-local: act is not installed (brew install act, or gh extension install nektos/gh-act)" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "ci-local: Docker is not running (start Docker Desktop, Colima or another engine)" >&2
    exit 1
  fi
fi

exec node .claude/tools/workflows.mjs "$sub" "$@"
