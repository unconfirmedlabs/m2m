#!/usr/bin/env bash
set -euo pipefail
version=1.79.0
archive_sha=be99e1e81c098dd0beb2969d671fb8270ccc0520188ccea60213ae094d32337a
tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/m2m-tools"
archive="$tools_dir/sui-testnet-v$version.tgz"
destination="$tools_dir/sui-$version"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'This installer supports Linux x86_64. Install Sui testnet 1.79.0 for your platform and set SUI_BIN.' >&2
  exit 1
fi
mkdir -p "$destination"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 \
    "https://github.com/MystenLabs/sui/releases/download/testnet-v$version/sui-testnet-v$version-ubuntu-x86_64.tgz" \
    -o "$archive.part"
  mv "$archive.part" "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$destination" ./sui
"$destination/sui" --version
echo "Installed: $destination/sui"
