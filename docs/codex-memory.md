# Codex Memory Handoff (March 7, 2026)

## Non-Negotiable Architecture Rules
- Extension runs on target machine.
- Extension talks only via BLE (never localhost/MCP).
- MCP runs on controller/host machine and talks to device via UART.

## Current Reality
- Firmware BLE profile is currently custom UART-like (`6E400001-B5A3-F393-E0A9-E50E24DCCA9E`), not HOGP.
- Therefore device does not enumerate as HID on macOS yet.
- MCP busy-state check works over UART (`state.request` -> `state` response confirmed live).

## Session Changes Landed
- Removed extension localhost/MCP HTTP path and related manifest host permissions.
- Added Web Bluetooth transport scaffolding in extension (`navigator.bluetooth` connect/write).
- Added firmware command `fw.version.request` and response includes `version` + `built_at`.
- Added MCP support/validation for `fw.version.request`.
- Added UART debug/timeout knobs in MCP:
  - `AIRKVM_UART_DEBUG=1`
  - `AIRKVM_SERIAL_TIMEOUT_MS=<ms>`
- Added docs planning/status:
  - `docs/plan.md`
  - AGENTS current-reality notes

## In-Progress / Not Complete
- BLE HID (HOGP) is not implemented (main blocker).
- DOM snapshot + tab/desktop screenshot end-to-end retrieval via MCP tools is not complete.
- Some scaffolding for new message types exists, but not yet a finalized tested pipeline.

## Next Work Order (Priority)
1. Implement BLE HID (HOGP) in firmware and validate macOS pairing/enumeration.
2. Finalize DOM/screenshot request-response protocol and bounds (chunking, IDs, timeouts).
3. Implement MCP high-level tools (`airkvm_dom_snapshot`, `airkvm_screenshot_tab`, `airkvm_screenshot_desktop`).
4. Complete extension handlers and permissions UX for tab/desktop capture.
5. Add integration tests and hardware smoke checks.

## Useful Commands
- MCP tests: `cd mcp && node --test`
- Firmware host tests: `cd firmware && pio test -e native`
- MCP live run: `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`
- Live debug probe: `AIRKVM_UART_DEBUG=1 AIRKVM_SERIAL_TIMEOUT_MS=6000 ...`
