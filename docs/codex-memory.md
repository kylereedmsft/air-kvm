# Codex Memory Handoff (March 7, 2026)

## Non-Negotiable Architecture Rules
- Extension runs on target machine.
- Extension talks only via BLE (never localhost/MCP).
- MCP runs on controller/host machine and talks to device via UART.

## Current Reality
- Firmware BLE profile is currently custom UART-like (`6E400101-B5A3-F393-E0A9-E50E24DCCB01`), not HOGP.
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
- Confirmed Web Bluetooth permission model for MV3 extension:
  - Do **not** add `"bluetooth"` under `permissions` or `optional_permissions` (unknown permission error).
  - Web Bluetooth in extensions uses runtime user prompt flow via `navigator.bluetooth.requestDevice(...)`.
- Extension action click feedback:
  - Added badge status on click so failures are visible (`...`, `BLE`, `NO`, `ERR`).
  - Previous behavior silently swallowed failures and appeared as “nothing happens”.
  - `NO` specifically means `navigator.bluetooth.requestDevice` is unavailable in the current extension context.
- Edge runtime note: action click currently reports `NO` in Edge because BLE request API is not available in this background context.
- BLE transport host page (primary path):
  - `src/ble_bridge.html` + `src/ble_bridge.js` is the primary BLE context.
  - Service worker forwards BLE post/command traffic via runtime messages to that page (`ble.post`, `ble.command`).
  - Action click opens/activates bridge tab and shows `TAB` badge.
- Extension debug logging:
  - Added verbose logs in service worker (`[airkvm-sw]`), BLE bridge page (`[airkvm-bridge]`), and BLE transport module (`[airkvm-ble]`).
  - Intended to debug live DOM/screenshot command flow across bridge + runtime message hops.
  - Added per-message trace IDs from service worker -> bridge page -> BLE writer.
  - BLE writer now logs payload byte size and write mode (`withResponse` preferred, fallback to `withoutResponse`).
- BLE stream validation:
  - Bridge now sends `state.request` immediately after connect and requires a valid JSON control reply (`state` or `ok`) within timeout.
  - If handshake fails and only binary noise is observed, bridge marks connection as invalid stream instead of reporting connected.
- BLE device selection hardening:
  - Bridge persists preferred BLE device ID in `chrome.storage.local` and attempts reconnect via `navigator.bluetooth.getDevices()` first.
  - Chooser request now filters by both UART service UUID and `namePrefix: "air-kvm"` when manual selection is needed.
- Bridge UX controls for hard reset:
  - Added buttons in `ble_bridge.html`: `Disconnect`, `Forget Saved Device`, and `Reconnect (Chooser)`.
  - `Reconnect (Chooser)` now disconnects active GATT session, clears preferred device ID, and forces fresh selection flow.
  - Invalid handshake path now explicitly disconnects and clears preferred device before marking invalid stream.
- Bridge page now has a built-in log console:
  - Added `#log` panel + `Clear Log` button to `ble_bridge.html`.
  - `ble_bridge.js` mirrors bridge debug events into the page log with timestamps and keeps a capped line history.
  - This allows runtime debugging without opening DevTools.
  - `bridge.js` low-level BLE logs now also flow into the page log (`[ble]` prefix), including RX byte previews and TX write mode.
- BLE cache-bust change:
  - Rolled UART BLE UUID set in firmware + extension to force fresh GATT discovery and avoid stale-handle reconnects.
  - New UUIDs:
    - service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
    - RX: `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
    - TX: `6E400103-B5A3-F393-E0A9-E50E24DCCB01`
- Device disambiguation hardening:
  - Firmware BLE advertised name changed to `air-kvm-ctrl-cb01`.
  - Extension chooser filter now requires exact `name: "air-kvm-ctrl-cb01"` with UART service UUID.
  - Goal is to avoid connecting to similarly named non-control peripherals.
- Critical BLE TX bug found/fixed:
  - `NimBLECharacteristic::setValue(payload)` with `const char*` was sending pointer bytes (4-byte binary values) instead of JSON text.
  - This exactly matched observed notification payloads like `19 07 40 3f` / `70 04 40 3f`.
  - Fixed by using explicit byte+length overload:
    - `setValue(reinterpret_cast<const uint8_t*>(payload), strlen(payload))`
  - Applied in `transport_mux.cpp` and boot payload initialization in `app.cpp`.
- Review-driven hardening updates:
  - Bridge connect flow is now guarded against re-entry (`connectInFlight`) to prevent overlapping handshake loops.
  - Disconnect now clears `bleDevice` in addition to characteristic handles/buffers.
  - Bridge now forwards ack-only control frames (for example `{ "ok": true }`) to service worker instead of dropping non-`type` payloads.
  - Firmware boot identity string now matches control device naming (`air-kvm-ctrl-cb01`).
- Chooser visibility hotfix:
  - Strict exact-name filter could hide valid devices during transition.
  - Bridge chooser now matches by service UUID with fallback filters for both names (`air-kvm-ctrl-cb01`, `air-kvm-poc`) and service-only.
- Bridge diagnostics now include deeper BLE stream introspection:
  - Logs connected device info immediately after GATT connect (before handshake success/failure).
  - Logs raw notification hex bytes (`rx notify`) from TX characteristic.
  - On handshake timeout, attempts `readValue()` snapshot on TX characteristic and logs bytes/hex/text.
  - Logs full GATT service/characteristic inventory (`gatt services`) and selected service/RX/TX UUID+properties on connect.

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
