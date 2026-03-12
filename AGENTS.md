# Repository Guidelines

## Project Structure & Module Organization
This repository is a small monorepo with three implementation targets:
- `firmware/`: ESP32 PlatformIO C++ code (`src/`, `include/`, `test/`, `host_test/`).
- `mcp/`: Node.js STDIO MCP server (`src/`, `test/`).
- `extension/`: Chrome/Edge MV3 extension (`src/`, `test/`, `manifest.json`).

Shared scripts live in `scripts/`, and supporting docs are in `docs/` (`architecture.md`, `development.md`, `protocol.md`).

Deployment topology:
- Controller/host machine runs MCP + firmware UART link.
- Target machine runs only the extension.
- Extension external transport is BLE only; it does not connect to MCP/localhost.

## Current Reality (March 8, 2026)
- Firmware currently exposes a custom BLE UART-style service (`6E400101-...`) as the active data path.
- MCP supports high-level tools for tabs, DOM snapshot, tab screenshot, and desktop screenshot over UART/BLE relay.
- Extension BLE bridge + service worker path is active for DOM/screenshot workflows.
- Source of truth for implementation status and next steps: `docs/plan.md`.

## Build, Test, and Development Commands
Run all checks from repo root:
- `./scripts/ci.sh`: Runs MCP tests, extension tests, firmware native tests, and ESP32 build.

Scripts in `scripts/`:
- `./scripts/ci.sh`: Full project CI checks.
- `./scripts/firmware-host-test.sh`: Firmware host-side sanity path when `pio` is unavailable.
- `node scripts/poc-smoke.mjs`: End-to-end smoke test (MCP + firmware command path).
- `node scripts/mcp-tool-call.mjs <tool_name> [json_args]`: MCP harness for one-off tool calls against a live server/firmware path.

Run components individually:
- `cd mcp && node --test`: Execute MCP unit tests.
- `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`: Run MCP server with live UART transport.
- `cd extension && node --test`: Execute extension unit tests.
- `cd firmware && pio test -e native`: Run firmware protocol tests on host.
- `cd firmware && pio run -e esp32dev`: Build firmware for ESP32.
- `cd firmware && pio device monitor`: Open serial monitor.
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/poc-smoke.mjs`: End-to-end local smoke test (MCP + firmware command).
- `AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_tab '{"request_id":"shot-1","max_width":1280,"max_height":720,"quality":0.6}'`: Run MCP screenshot harness and save image to `temp/`.
- `node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"dom-1"}'`: Run MCP DOM snapshot harness call.

If `pio` is unavailable, use `./scripts/firmware-host-test.sh` for host-side firmware sanity testing.

Runtime env vars:
- `AIRKVM_SERIAL_PORT`: UART device path used by MCP (`/dev/cu.usbserial-0001` on macOS).
- `AIRKVM_SERIAL_BAUD`: UART baud for MCP (default `115200`).
- `AIRKVM_SERIAL_TIMEOUT_MS`: MCP command timeout in milliseconds (default `3000`).
- `AIRKVM_UART_DEBUG=1`: Enable MCP UART debug logs.
- `AIRKVM_TOOL_TIMEOUT_MS`: Timeout for `scripts/mcp-tool-call.mjs` (default `120000`).
- `AIRKVM_SAVE_SCREENSHOTS=1`: When set, screenshot tool responses are saved to `temp/` and returned with `saved_path`/`saved_bytes`.

## Coding Style & Naming Conventions
- JavaScript: ESM modules, 2-space indentation, semicolons, single quotes.
- C++: C++17, 2-space indentation, `PascalCase` for `enum class` members (no `k` prefix — they are already scoped), `kPascalCase` for non-enum constants, and `snake_case` for test helper/function names.
- Keep module files focused and small (`protocol.js`, `messages.js`, `protocol.cpp`).
- Prefer descriptive event/type strings (for example `mouse.move_rel`, `busy.changed`).
- Firmware UART output is framed binary (`AK`) with frame types:
  - `0x01` chunk payload
  - `0x02` control JSON payload
  - `0x03` log text payload
  - `0x04` ack (chunk acknowledged)
  - `0x05` nack (chunk rejected)
  - `0x06` reset (clear stream state)

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
