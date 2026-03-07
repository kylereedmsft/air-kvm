#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

c++ -std=c++17 -I"$ROOT_DIR/firmware/include" \
  "$ROOT_DIR/firmware/src/protocol.cpp" \
  "$ROOT_DIR/firmware/host_test/main.cpp" \
  -o "$ROOT_DIR/firmware/host_test/host_test_bin"

"$ROOT_DIR/firmware/host_test/host_test_bin"
