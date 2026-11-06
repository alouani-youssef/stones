#!/usr/bin/env bash
# Runs the claude-stones setup from a clone of this repository:
#   bash setup.bash [init|roadmap|detect] [target-dir] [options]
# Same as `npx claude-stones ...`; see `bash setup.bash --help`.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "claude-stones needs Node.js 18.17 or newer: https://nodejs.org" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "claude-stones needs Node.js 18.17 or newer (found $(node -v))." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/bin/stones.mjs" "$@"
