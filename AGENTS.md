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

## Current Reality (March 12, 2026)
- Firmware exposes a custom BLE UART-style service (`6E400101-...`) as the active data path; BLE HID is always enabled (no compile-time flags).
- MCP supports high-level tools for tabs, DOM snapshot, tab screenshot, and desktop screenshot over UART/BLE relay.
- Extension BLE bridge + service worker path is active for DOM/screenshot workflows.
- Extension must be loaded from `extension/dist/` (built by `npm run build`) — not `extension/src/` directly.
- Source of truth for implementation status and next steps: `docs/plan.md`.

## Build, Test, and Development Commands
Run all checks from repo root:
- `./scripts/ci.sh`: Runs MCP tests, extension tests, extension dist build, firmware native tests, and ESP32 build.

Scripts in `scripts/`:
- `./scripts/ci.sh`: Full project CI checks.
- `./scripts/firmware-host-test.sh`: Firmware host-side sanity path when `pio` is unavailable.
- `node scripts/mcp-fw-integration.mjs`: MCP↔firmware integration test over the live command path.
- `node scripts/mcp-tool-call.mjs <tool_name> [json_args]`: MCP harness for one-off tool calls against a live server/firmware path.

Run components individually:
- `cd mcp && node --test`: Execute MCP unit tests.
- `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`: Run MCP server with live UART transport.
- `cd extension && node --test`: Execute extension unit tests.
- `cd extension && npm run build`: Build `extension/dist/` for loading as an unpacked Chrome/Edge extension.
- `cd firmware && pio test -e native`: Run firmware protocol tests on host.
- `cd firmware && pio run -e esp32dev`: Build firmware for ESP32.
- `cd firmware && pio device monitor`: Open serial monitor.
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-fw-integration.mjs`: End-to-end local MCP↔firmware integration test.
- `AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_tab '{"request_id":"shot-1","max_width":1280,"max_height":720,"quality":0.6}'`: Run MCP screenshot harness and save image to `temp/`.
- `node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"dom-1"}'`: Run MCP DOM snapshot harness call.
- `node scripts/mcp-tool-call.mjs airkvm_accessibility_snapshot '{"request_id":"ax-1"}'`: Run MCP accessibility snapshot harness call.

If `pio` is unavailable, use `./scripts/firmware-host-test.sh` for host-side firmware sanity testing.

Runtime env vars:
- `AIRKVM_SERIAL_PORT`: UART device path used by MCP (`/dev/cu.usbserial-0001` on macOS).
- `AIRKVM_SERIAL_BAUD`: UART baud for MCP (default `115200`).
- `AIRKVM_SERIAL_TIMEOUT_MS`: MCP command timeout in milliseconds (default `3000`).
- `AIRKVM_UART_DEBUG=1`: Enable MCP UART debug logs.
- `AIRKVM_TOOL_TIMEOUT_MS`: Timeout for `scripts/mcp-tool-call.mjs` (default `120000`).
- `AIRKVM_SAVE_SCREENSHOTS=1`: When set, screenshot tool responses are saved to `temp/` and returned with `saved_path`/`saved_bytes`.

## Protocol Rules — DO NOT VIOLATE

These are hard constraints. Violating them introduces subtle bugs that are difficult to trace.

### The One Rule

**ALL messages to firmware — from either the extension or MCP — MUST go through HalfPipe.**

No exceptions. No raw JSON. No direct BLE writes.

### How HalfPipe works

- Caller: `halfpipe.send(obj)` / `halfpipe.sendControl(obj, target)` / `halfpipe.onMessage(cb)` / `halfpipe.onControl(cb)`
- `halfpipe.send(obj)` serializes `obj` to JSON, splits into ≤255-byte chunks, wraps each as an AK CHUNK frame (`0x01`), sends one at a time, waits for ACK before next chunk.
- `halfpipe.sendControl(obj, target)` sends a single CONTROL frame (`0x02`) — no chunking, no ACK wait. Payload must fit in ≤255 bytes.
- These are the only valid ways to encode protocol messages into AK frames. They are not parallel protocols or optional convenience wrappers.
- Firmware is a **dumb bridge**: forwards CHUNK/ACK/NACK/RESET between UART↔BLE unchanged. It never parses CHUNK payloads.
- MCP HalfPipe: `writeFn` → `encodeFrame` → UART write.
- Extension HalfPipe (`ble_bridge.js` `hp`): `writeFn` → `postBinary` → BLE write.

### Extension → Firmware (BLE)

- **Use `hp.send(msg)` in `ble_bridge.js`** for browser-automation messages (dom snapshot, screenshot, etc.). These are CHUNK frames; firmware forwards them to UART; MCP's HalfPipe reassembles.
- **Use `hp.sendControl(msg, target)` in `ble_bridge.js`** for firmware-local commands (`state.request`, `state.set`, `fw.version.request`). These arrive as CONTROL frames; firmware handles them locally without forwarding.
- Firmware **does not reassemble CHUNKs** received over BLE (insufficient RAM). Firmware-local commands must arrive as CONTROL frames.
- **Never write raw JSON to BLE.** Firmware's BLE RX parser expects AK frames and silently drops raw JSON.
- **Do not collapse these into a single “send via HalfPipe” rule.** `HalfPipe` is always required, but the mode matters:
  `hp.send(...)` is for MCP-bound browser automation traffic; `hp.sendControl(..., kTarget.FW)` is for firmware-local commands only.
- **Why this matters:** AK frames already contain explicit routing semantics on the wire: frame type plus target. The protocol already knows where traffic should go. If you invent another path, you are bypassing those AK routing semantics and creating a parallel protocol by accident.
- **Known footgun:** content-script `busy.changed` events become firmware `state.set` commands. They must stay on HalfPipe but must use the CONTROL path to `kTarget.FW`, never the MCP-bound `hp.send(...)` path.

### Firmware → Extension (BLE)

- Firmware sends CONTROL frames (`0x02`) for boot message and state responses via BLE TX notify.
- Extension path: BLE notify → `ble_bridge.js` `onCommand` callback → `hp.feedBytes()` → `halfpipe.onControl(cb)` or `halfpipe.onMessage(cb)`.

### MCP → Firmware (UART)

- **HID / firmware-local commands** (`airkvm_send` tool): encoded as CONTROL frames (`0x02`) via `sendControlCommand`.
- **All other tools** (browser automation): sent via `halfpipe.send()` as CHUNK frames. Firmware forwards them to BLE. Extension HalfPipe reassembles.

### What the firmware handles locally (CONTROL frames, any transport)

`mouse.move_rel`, `mouse.move_abs`, `mouse.click`, `key.tap`, `key.type`, `state.request`, `state.set`, `fw.version.request`. Everything else is forwarded to the other transport segment as-is.

### Full reference

See `docs/protocol.md` §5 for the complete half-pipe transport specification.

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
