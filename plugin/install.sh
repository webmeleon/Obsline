#!/usr/bin/env bash
set -euo pipefail

VAULT="${1:-}"
if [[ -z "$VAULT" ]]; then
  echo "Usage: ./install.sh /path/to/obsidian/vault"
  echo "Example: ./install.sh ~/Documents/Obsidian/MyVault"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$VAULT/.obsidian/plugins/obsline"

mkdir -p "$DEST"
cp "$DIR/main.js" "$DIR/manifest.json" "$DIR/styles.css" "$DEST/"

echo "✓ Installed to $DEST"
echo "  → Restart Obsidian and enable 'Obsline – Outline Sync' under Settings → Community plugins."
