#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME_DIR="$SCRIPT_DIR/chrome"
CHROME_BIN="$CHROME_DIR/Chromium/Contents/MacOS/Chromium"

# Download standalone Chromium on first run
if [ ! -x "$CHROME_BIN" ]; then
  echo "Chromium not found in chrome/ folder, download Chromium to run the app."
  exit 1
fi

# Accept optional first argument as DATA_DIR override; default to <appDir>/data
DATA_DIR="${1:-$SCRIPT_DIR/data}"
mkdir -p "$DATA_DIR"

# Build file:// URL for index.html (macOS paths are forward-slash already)
APP_URL="file://$SCRIPT_DIR/index.html"

# Strip leading slash so app.js's `file:///` prefix produces a valid 3-slash URL.
# (Windows drive paths have no leading slash; macOS absolute paths do.)
DATA_DIR_PARAM="${DATA_DIR#/}"
DATA_DIR_PARAM="${DATA_DIR_PARAM// /%20}"

# Find most recent .db file (filenames are timestamped so descending sort = most recent)
LATEST=""
LATEST_PATH=$(ls -1 "$DATA_DIR"/*.db 2>/dev/null | sort -r | head -1 || true)
if [ -n "$LATEST_PATH" ]; then
  LATEST="$(basename "$LATEST_PATH")"
fi

CHROME_ARGS=(
  --allow-file-access-from-files
  --enable-features=FileSystemAccessAPI
  --user-data-dir="$SCRIPT_DIR/chrome/profile"
  --no-first-run
)

if [ -n "$LATEST" ]; then
  "$CHROME_BIN" "${CHROME_ARGS[@]}" "$APP_URL?dataDir=$DATA_DIR_PARAM&db=$LATEST" &
else
  "$CHROME_BIN" "${CHROME_ARGS[@]}" "$APP_URL?dataDir=$DATA_DIR_PARAM" &
fi
