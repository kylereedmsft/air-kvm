# Manager Plan

## Agent Workflow
- `MANAGER`: creates/updates plan, assigns one step at a time, verifies completion.
- `WORKER`: executes exactly one approved step and reports concrete diffs/commands.
- `REVIEWER` (new, mandatory before every commit): performs an adversarial review focused on bugs, regressions, unsafe assumptions, missing tests, and cross-platform risks.

### REVIEWER Gate (must pass before commit)
1. Validate behavior changes against current requirements and architecture docs.
2. Hunt for failure modes (timeouts, malformed payloads, race conditions, stale state, edge cases).
3. Check platform compatibility impacts (macOS/Windows/Edge/Node paths).
4. Verify tests exist for new behavior; if missing, block commit until added or risk explicitly documented.
5. Produce findings with severity (`critical/high/medium/low`) and required fixes.
6. `MANAGER` approves commit only after all `critical/high` findings are fixed or explicitly waived.

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

## Remaining work (hardware E2E only)
1. Validate real screenshot retrieval latency/size on target machine for:
   - `airkvm_screenshot_tab` default config
   - `airkvm_screenshot_desktop` default config
   - one tuned request (`max_width`, `max_height`, `quality`, `max_chars`)
2. Validate desktop permission-denied UX and confirm structured MCP error payloads in live flow.
3. Validate oversized screenshot behavior in live flow (`screenshot_too_large`) and confirm no hangs.
4. Measure and record successful end-to-end timings and payload sizes for final default tuning.
