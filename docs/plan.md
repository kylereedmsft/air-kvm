# AirKVM Plan And Status (March 7, 2026)

## Goal
Ship a working remote-control stack where:
- ESP32 appears as BLE HID (HOGP) to macOS target machine.
- Browser extension runs on target machine and exchanges automation context over BLE.
- MCP runs on controller/host machine and drives device commands over UART.
- DOM snapshot + tab screenshot + desktop screenshot are retrievable reliably.

## What Is Done

### Firmware
- UART JSONL command parsing and ACK/event framing are implemented.
- `state.request` and `state.set` are implemented.
- `fw.version.request` is implemented.
- Build metadata (`version`, `built_at`) is now emitted in firmware control payloads.
- BLE custom UART-style GATT service (`6E400001-...`) is implemented.

### MCP
- STDIO MCP server is implemented with tool `airkvm_send`.
- UART transport is implemented with command timeout handling.
- Busy-state request over UART is working end-to-end (`state.request` -> `state` response observed).
- Protocol validation supports: mouse/key/state/version commands.

### Extension
- Content script emits DOM summary and busy/idle events.
- Service worker can connect with Web Bluetooth and send JSONL events over BLE write characteristic.
- BLE permissions/scaffolding added in MV3 manifest.

### Docs
- Architecture/development/protocol docs exist and were updated for current topology.
- AGENTS now includes explicit current-reality notes.

## What Is Not Done / Broken Relative To Target

1. BLE HID (HOGP) is not implemented.
- This is the blocker for “device appears as HID on macOS”.
- Current firmware BLE profile is custom UART, not HID.

2. Extension screenshot pipeline is incomplete for production.
- No validated, tested end-to-end tab/desktop screenshot retrieval contract consumed by MCP.
- Desktop capture UX/permission flow and error handling are not hardened.

3. No MCP tools yet for high-level data retrieval.
- Only `airkvm_send` exists.
- Missing dedicated tools for:
  - `airkvm_dom_snapshot`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`

4. No durable request/response correlation layer.
- Need robust request IDs, chunk reassembly, retries, timeout/error semantics across BLE<->UART hops.

5. Integration tests are incomplete.
- There is no full integration harness proving:
  - extension command receipt over BLE
  - screenshot chunk transfer/reassembly
  - MCP retrieval semantics

## TODO Plan (Proposed Execution Order)

1. Implement BLE HID (HOGP) on firmware first.
- Add HID service (`0x1812`) + report map for keyboard/mouse.
- Validate macOS pairing and HID enumeration.
- Keep custom UART-like service in parallel only if needed for control channel.

2. Finalize BLE command protocol for browser data.
- Define canonical command/response messages:
  - `dom.snapshot.request` -> `dom.snapshot`
  - `screenshot.request` (`source=tab|desktop`) -> `screenshot.meta` + `screenshot.chunk*` + terminal status
- Freeze field names and limits in `docs/protocol.md`.

3. Complete extension handlers for DOM + screenshot.
- Handle inbound BLE requests deterministically.
- Implement tab/desktop capture with strict permission/error behavior.
- Chunk and send payloads with bounded message size.

4. Add MCP high-level tools.
- Add `airkvm_dom_snapshot`.
- Add `airkvm_screenshot_tab`.
- Add `airkvm_screenshot_desktop`.
- Tools should hide low-level command details and return structured JSON.

5. Implement response collection/reassembly in MCP.
- Correlate by `request_id`.
- Reassemble screenshot chunks, validate sequence/completeness, expose base64 and metadata.
- Enforce clear timeout/error categories.

6. Add integration tests + smoke tests.
- Host-side fake serial tests for chunking/reassembly.
- End-to-end smoke scripts for real hardware path.
- Include regression cases for timeout, missing chunk, permission denied.

7. Documentation hardening.
- Update setup docs for macOS HID pairing and extension permissions.
- Add operator runbook for troubleshooting serial/BLE/HID path.

## Immediate Next Milestone For Review
- Milestone A: “macOS sees HID device and keyboard/mouse injection works”.
- Acceptance:
  - Device advertises HOGP.
  - macOS pairs successfully.
  - Verified key tap + mouse move from MCP command path.

## Notes
- Current branch contains active in-progress edits across firmware, mcp, and extension; not all are integrated into a coherent release yet.
- This plan is intended to be the canonical checklist before claiming full DOM + screenshot support.
