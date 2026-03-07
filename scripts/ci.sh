#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/mcp"
node --test

cd "$ROOT_DIR/extension"
node --test

if command -v pio >/dev/null 2>&1; then
  cd "$ROOT_DIR/firmware"
  pio test -e native
  pio run -e esp32dev
elif command -v platformio >/dev/null 2>&1; then
  cd "$ROOT_DIR/firmware"
  platformio test -e native
  platformio run -e esp32dev
else
  echo "[warn] PlatformIO CLI not found; running firmware host fallback tests"
  "$ROOT_DIR/scripts/firmware-host-test.sh"
fi
