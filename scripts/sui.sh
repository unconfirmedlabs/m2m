#!/usr/bin/env bash
set -euo pipefail
binary="${SUI_BIN:-${XDG_CACHE_HOME:-$HOME/.cache}/m2m-tools/sui-1.79.0/sui}"
if [[ ! -x "$binary" ]]; then
  echo 'Install the pinned toolchain with bash scripts/install-sui.sh, or set SUI_BIN.' >&2
  exit 1
fi
exec "$binary" "$@"
