# Manager Plan

## Agent Workflow
- `MANAGER`: creates/updates plan, assigns one step at a time, verifies completion.
- `WORKER`: executes exactly one approved step and reports concrete diffs/commands.
- `REVIEWER` (new, mandatory before every commit): performs an adversarial review focused on bugs, regressions, unsafe assumptions, missing tests, and cross-platform risks.
- `INVESTIGATOR` (mandatory for unresolved failures): drives root-cause analysis with evidence, not guesses.

### REVIEWER Gate (must pass before commit)
1. Validate behavior changes against current requirements and architecture docs.
2. Hunt for failure modes (timeouts, malformed payloads, race conditions, stale state, edge cases).
3. Check platform compatibility impacts (macOS/Windows/Edge/Node paths).
4. Verify tests exist for new behavior; if missing, block commit until added or risk explicitly documented.
5. Produce findings with severity (`critical/high/medium/low`) and required fixes.
6. `MANAGER` approves commit only after all `critical/high` findings are fixed or explicitly waived.

### INVESTIGATOR Gate (mandatory when failures are unclear)
1. Define concrete hypotheses and required evidence for each.
2. Collect proof using logs, traces, code-path inspection, and reproducible commands.
3. Eliminate alternatives with explicit disproof, not intuition.
4. Report root cause with:
   - where it fails (file/function/stage),
   - why it fails,
   - why competing explanations are wrong.
5. No closure until open questions are reduced to zero or explicitly listed as blocked by missing observability.

## Objective
Stabilize screenshot transfer reliability end-to-end by upgrading from fire-and-forget chunks to resumable transfer sessions (`transfer_id` + ACK/resume/cancel/reset).

## Steps
1. [x] Define protocol additions and message shapes:
   - `transfer.meta` / `transfer.chunk`
   - `transfer.ack` / `transfer.resume`
   - `transfer.cancel` / `transfer.reset`
   - `transfer.done` / `transfer.done.ack`
   - `transfer.error` with `code: "no_such_transfer"` for missing session resume.
2. [x] Implement MCP screenshot collector/session logic:
   - Track active `transfer_id`.
   - Send `transfer.ack` with highest contiguous seq.
   - Send `transfer.resume` on gaps/timeouts.
   - Treat `no_such_transfer` as hard restart (new screenshot request).
3. [x] Implement extension transfer session store in bridge page:
   - Keep encoded payload by `transfer_id` until done/cancel/reset/TTL expiry.
   - Support resume from `from_seq`.
   - Support reset to clear all transfer state.
4. [x] Wire firmware pass-through for new transfer control message types.
5. [x] Add/expand tests in `mcp`, `extension`, and `firmware` for:
   - missing-session resume -> `no_such_transfer`
   - retransmit from gap
   - cancel/reset cleanup
   - done handshake completion.
6. [ ] Run focused checks and live validation, then tune defaults.

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
3. On macOS target machine, pair BLE device named `air-kvm-ctrl-cb01` (or legacy `air-kvm-poc` during transition) in Bluetooth settings.
4. Confirm HID enumeration in macOS:
   - System Settings -> Bluetooth shows connected input device.
5. From host machine, run MCP:
   - `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`
6. Send manual command probes:
   - `{"type":"key.tap","key":"Enter"}`
   - `{"type":"mouse.move_rel","dx":20,"dy":10}`
   - `{"type":"mouse.click","button":"left"}`
7. Confirm target machine receives input events (cursor moves, click fires, Enter key injected).

## Current Priority
1. Fix incomplete screenshot stream completion (meta/chunks seen, MCP timeout).
2. Land transfer reliability protocol with retransmit support.
3. Re-run live `airkvm_screenshot_tab` validation for both `b64` and `b64z`.
