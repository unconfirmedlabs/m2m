#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
network_dir="${1:-.m2m/localnet}"
mkdir -p "$network_dir"
chmod 700 "$network_dir"
if [[ ! -f "$network_dir/genesis.blob" ]]; then
  bash scripts/sui.sh genesis --working-dir "$network_dir" --with-faucet --committee-size 1
  python3 - "$network_dir/fullnode.yaml" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
p.write_text(p.read_text().replace('json-rpc-address: "0.0.0.0:9000"','json-rpc-address: "127.0.0.1:9000"'))
PY
fi
exec bash scripts/sui.sh start --network.config "$network_dir" --with-faucet=127.0.0.1:9123
