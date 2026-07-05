#!/usr/bin/env bash
# One-command startup for SimplifAI (macOS/Linux)
set -euo pipefail
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 scripts/start_dev.py "$@"
fi

if command -v python >/dev/null 2>&1; then
  exec python scripts/start_dev.py "$@"
fi

echo "Python not found. Install Python 3.12+ and try again." >&2
exit 1
