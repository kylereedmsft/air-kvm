# Manager Plan

## Objective
Implement Milestone A from `docs/plan.md`: ESP32 advertises BLE HID (HOGP) and command path can inject keyboard/mouse input.

## Steps
1. [x] Read `docs/*.md` and extract goals/current blockers.
2. [x] Verify firmware dependency surface for HID APIs.
3. [x] Add HID controller setup/report map and integrate into app boot.
4. [x] Route command handlers (`mouse.move_rel`, `mouse.click`, `key.tap`) to HID report sends.
5. [x] Run `pio test -e native` and `pio run -e esp32dev`.
6. [x] Document remaining live macOS validation steps.

## Notes
- Keep existing custom BLE UART service available while introducing HID, per current transition plan.
- Verification run (March 7, 2026): `pio test -e native` passed (8/8), `pio run -e esp32dev` succeeded.
- MCP progress (March 7, 2026):
  - Replaced UART transport shell dependency with cross-platform `serialport`.
  - Added MCP tools: `airkvm_dom_snapshot`, `airkvm_screenshot_tab`, `airkvm_screenshot_desktop`.
  - Implemented request_id-based DOM/screenshot response collection and screenshot chunk reassembly.
  - Added transport, tooling, and server-level tests (`mcp` now at 21 passing tests).

## Live macOS validation checklist
1. Flash latest firmware:
   - `cd firmware && pio run -e esp32dev -t upload`
2. Open monitor and confirm boot line includes `version` and `built_at`:
   - `cd firmware && pio device monitor --port /dev/cu.usbserial-0001`
3. On macOS target machine, pair BLE device named `air-kvm-poc` in Bluetooth settings.
4. Confirm HID enumeration in macOS:
   - System Settings -> Bluetooth shows connected input device.
5. From host machine, run MCP:
   - `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`
6. Send manual command probes:
   - `{"type":"key.tap","key":"Enter"}`
   - `{"type":"mouse.move_rel","dx":20,"dy":10}`
   - `{"type":"mouse.click","button":"left"}`
7. Confirm target machine receives input events (cursor moves, click fires, Enter key injected).
