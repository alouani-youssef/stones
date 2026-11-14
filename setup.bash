#!/usr/bin/env bash
# Runs ai-stones from a clone of this repository:
#   bash setup.bash [init|roadmap|detect|sync] [target-dir] [options]
# Same as `npx ai-stones ...`; see `bash setup.bash --help`.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "ai-stones needs Node.js 22.13 or newer: https://nodejs.org" >&2
  exit 1
fi
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "ai-stones needs Node.js 22.13 or newer (found $(node -v))." >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/bin/stones.mjs" "$@"
