# Repository Guidelines

## Project Structure & Module Organization
This repository is a small monorepo with three implementation targets:
- `firmware/`: ESP32 PlatformIO C++ code (`src/`, `include/`, `test/`, `host_test/`).
- `mcp/`: Node.js STDIO MCP server (`src/`, `test/`).
- `extension/`: Chrome/Edge MV3 extension (`src/`, `test/`, `manifest.json`).

Shared scripts live in `scripts/` (notably `ci.sh`), and supporting docs are in `docs/` (`architecture.md`, `development.md`, `protocol.md`).

Deployment topology:
- Controller/host machine runs MCP + firmware UART link.
- Target machine runs only the extension.
- Extension external transport is BLE only; it does not connect to MCP/localhost.

## Current Reality (March 7, 2026)
- Firmware currently exposes a custom BLE UART-style service (`6E400001-...`), not BLE HID (HOGP).
- Because HOGP is not implemented yet, the device will not enumerate as a keyboard/mouse HID on macOS.
- MCP currently supports command forwarding over UART and can request state/version from firmware.
- Extension currently includes BLE transport scaffolding, but end-to-end DOM/screenshot workflow is still in-progress and not production-ready.
- Source of truth for implementation status and next steps: `docs/plan.md`.

## Build, Test, and Development Commands
Run all checks from repo root:
- `./scripts/ci.sh`: Runs MCP tests, extension tests, firmware native tests, and ESP32 build.

Run components individually:
- `cd mcp && node --test`: Execute MCP unit tests.
- `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`: Run MCP server with live UART transport.
- `cd extension && node --test`: Execute extension unit tests.
- `cd firmware && pio test -e native`: Run firmware protocol tests on host.
- `cd firmware && pio run -e esp32dev`: Build firmware for ESP32.
- `cd firmware && pio device monitor`: Open serial monitor.
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/poc-smoke.mjs`: End-to-end local smoke test (MCP + firmware command).

If `pio` is unavailable, use `./scripts/firmware-host-test.sh` for the host-side firmware sanity test.

Runtime env vars:
- `AIRKVM_SERIAL_PORT`: UART device path used by MCP (`/dev/cu.usbserial-0001` on macOS).
- `AIRKVM_SERIAL_BAUD`: UART baud for MCP (default `115200`).

## Coding Style & Naming Conventions
- JavaScript: ESM modules, 2-space indentation, semicolons, single quotes.
- C++: C++17, 2-space indentation, `kPascalCase` enum values, and `snake_case` for test helper/function names.
- Keep module files focused and small (`protocol.js`, `messages.js`, `protocol.cpp`).
- Prefer descriptive event/type strings (for example `mouse.move_rel`, `busy.changed`).
- Firmware UART output is multiplexed JSONL:
  - `{"ch":"ctrl","msg":{...}}` for protocol payloads/acks.
  - `{"ch":"log","msg":"..."}` for diagnostics.

## Testing Guidelines
- JS tests use Node’s built-in test runner (`node:test`) with files under `*/test/*.test.js`.
- Firmware tests use Unity under `firmware/test/test_*/test_main.cpp`.
- Add tests with every protocol or message-shape change.
- Before opening a PR, run `./scripts/ci.sh` and ensure all targets pass locally.

## Commit & Pull Request Guidelines
- Follow concise, imperative commit subjects (seen in history: `Add docs and CI scripts; ...`, `Scaffold ...`).
- Keep commits scoped to one logical change.
- PRs should include:
  - What changed and why.
  - Affected module(s): `firmware`, `mcp`, `extension`.
  - Test evidence (copy of commands run).
  - Screenshots/log snippets for extension behavior changes when relevant.
