# HID + Browser BLE Coexistence Plan (Draft)

Date: March 8, 2026
Status: Draft for review (no implementation started)

## Objective

Enable keyboard/mouse control on the target OS via BLE HID while preserving the existing browser automation path (extension Web Bluetooth over UART service) with no regressions.

## Chosen Direction

Primary direction: one BLE peripheral identity exposing two services.

1. Service A: existing custom BLE UART service (`6E400101-...`) for extension/browser workflows.
2. Service B: BLE HID service for OS keyboard/mouse input.

Rationale:
- Keeps existing browser path unchanged.
- Uses standards-compliant HID path for OS input.
- Avoids adding browser dependency on HID service.

## Non-Negotiable Gates

1. Browser workflows remain unchanged and green:
- `tabs.list`
- `tab.open`
- `dom.snapshot`
- `js.exec`
- screenshot transfer lifecycle (`transfer.meta/chunk/done/ack/nack/resume`)

2. HID works while browser traffic is active:
- `mouse.move_rel`
- `mouse.click`
- `key.tap`

3. Reliability gate:
- 60-minute mixed-traffic soak with no deadlocks and no unexplained disconnect loops.

4. Recovery gate:
- Reconnect recovery after BLE disconnect.
- Recovery after target sleep/wake.
- Transfer lifecycle still stable after reconnect.

5. Rollback gate:
- Single-switch rollback to HID-disabled firmware variant.

## Phase Plan

## Phase 0: Instrumentation First (No Behavior Change)

Goal: make coexistence failures diagnosable before enabling HID.

Firmware logging additions:
1. BLE server connect/disconnect events with reason and peer info.
2. Active connection count transitions.
3. Advertising state transitions (start/restart).
4. HID notify success/failure counters.
5. UART TX notify/write failure counters.

Extension logging additions:
1. Structured stage-level failure telemetry for connect path:
- `requestDevice`
- `getPrimaryService`
- `getCharacteristic`
- `startNotifications`
- `writeValueWithoutResponse` / fallback
2. Log `gattserverdisconnected` with last successful activity and health state.
3. Persist latest failure snapshot in `chrome.storage.session`.

Deliverables:
- Logging fields documented in `docs/protocol.md` or `docs/development.md`.
- Focused tests for new logging paths where practical.

## Phase 1: HID Feature-Flag Build

Goal: enable HID without altering existing UART/browser behavior.

1. Add dedicated firmware build variant (example: `esp32dev_hid_uart`) with `AIRKVM_ENABLE_HID=1`.
2. Keep existing default build HID-off until completion criteria are met.
3. Keep UART service UUID and extension filter behavior unchanged.
4. Ensure command router behavior remains deterministic under mixed traffic.

Deliverables:
- Build variant documented.
- No protocol breaking changes.

## Phase 2: Bench Validation Matrix

Goal: de-risk coexistence before canary rollout.

Test lanes:
1. Browser-only regression lane (existing smoke + focused screenshot/transfer tests).
2. HID-only lane (input injection verification).
3. Mixed lane (browser + HID interleaving).
4. Fault lane (disconnect/reconnect, sleep/wake, transfer resume after reconnect).

Required evidence:
1. Command logs with timestamps and request IDs.
2. Disconnect/reconnect counts.
3. Transfer completion stats.
4. HID success/failure stats.

## Phase 3: Canary Rollout

Goal: validate in realistic conditions with bounded blast radius.

1. Enable HID build on limited devices/users.
2. Collect telemetry for a fixed observation window.
3. Promote only if all non-negotiable gates pass.

Rollback:
1. Revert firmware to HID-off build.
2. Keep extension/MCP unchanged.

## Open Design Questions (For Review)

1. Should we support multiple concurrent BLE connections immediately, or first enforce one active connection with explicit policy/logging?
2. Do we need a capability handshake frame (for example `{"type":"capabilities","hid":true}`) to help MCP/operator diagnostics?
3. Should HID commands be throttled/rate-limited to protect screenshot transfer performance under load?
4. Should we expose an emergency input stop command for safety?

## Execution Work Breakdown (Manager-Oriented)

1. INVESTIGATOR: finalize root-cause validation checklist and test instrumentation probes.
2. WORKER: implement Phase 0 logging/instrumentation only.
3. REVIEWER: adversarial review of instrumentation and failure-mode coverage.
4. WORKER: add HID build variant and minimal guardrails (Phase 1).
5. REVIEWER: verify no browser-path regressions in code and tests.
6. WORKER: run Phase 2 matrix and publish evidence bundle.
7. MANAGER: decide canary go/no-go based on gates.

## Success Criteria

1. Browser path reliability is unchanged from HID-off baseline.
2. HID input works consistently when browser automation is idle and under mixed load.
3. Failure events are actionable (diagnosable in one pass from logs).
4. Rollback can be executed in minutes with no extension/MCP changes.

## Agent Task List (Execution-Ready)

## Sprint A: Instrumentation Baseline (No Behavior Change)

Task A1
- Owner: INVESTIGATOR
- Goal: Define exact failure signatures and log fields needed to disambiguate root causes.
- Inputs: current firmware/extension logging behavior.
- Outputs:
1. `docs` note with required event fields and sample log lines.
2. Ranked failure signatures (disconnect ownership contention vs service discovery vs write/notify failure).
- Done when:
1. Manager can map every known failure class to at least one unambiguous signal.

Task A2
- Owner: WORKER
- Goal: Add firmware BLE lifecycle and per-path TX result telemetry only.
- Scope: `firmware/src`, `firmware/include`, tests/docs as needed.
- Outputs:
1. Connect/disconnect reason logging.
2. Active connection count and advertising-state logs.
3. HID notify success/failure counters.
4. UART notify/write failure counters.
- Done when:
1. Firmware build passes.
2. Existing firmware tests pass.
3. No protocol behavior change is introduced.

Task A3
- Owner: WORKER
- Goal: Add extension bridge stage-failure telemetry only.
- Scope: `extension/src/bridge.js`, `extension/src/ble_bridge.js`, extension tests/docs as needed.
- Outputs:
1. Structured connect-stage failure logging (`requestDevice`, service/char lookup, notifications, write modes).
2. Disconnect context logging (last activity + health state).
3. Session-persisted latest failure snapshot.
- Done when:
1. Extension tests pass.
2. Existing browser workflows are unchanged.

Task A4
- Owner: REVIEWER
- Goal: Adversarial review of A2/A3 for regression risk and diagnostic sufficiency.
- Outputs:
1. Severity-ranked findings with file/line refs.
2. Gaps list if any root-cause classes remain ambiguous.
- Done when:
1. No unresolved critical/high findings.

## Sprint B: HID Feature-Flag Variant

Task B1
- Owner: WORKER
- Goal: Add HID-enabled firmware build variant while keeping default HID-off.
- Scope: `firmware/platformio.ini` + minimal firmware wiring/docs.
- Outputs:
1. New build target (example `esp32dev_hid_uart`) with `AIRKVM_ENABLE_HID=1`.
2. Updated docs for build/flash steps and rollback.
- Done when:
1. Both default and HID variants build.
2. Default behavior remains unchanged.

Task B2
- Owner: REVIEWER
- Goal: Verify variant isolation and no browser-path regression in code changes.
- Outputs:
1. Findings report.
2. Explicit confirmation that UART/browser path is unchanged for default build.
- Done when:
1. No unresolved critical/high findings.

## Sprint C: Validation Matrix

Task C1
- Owner: WORKER
- Goal: Execute browser-only regression lane on HID-off and HID-on builds.
- Required commands:
1. `./scripts/ci.sh` (or component-equivalent plus live smoke where required)
2. Existing live browser smoke (`open_tab`, `exec_js`, `screenshot_tab`)
- Outputs:
1. Pass/fail matrix with logs and timestamps.
- Done when:
1. HID-on browser results match HID-off baseline.

Task C2
- Owner: WORKER
- Goal: Execute HID-only lane and mixed-traffic lane.
- Outputs:
1. HID command success metrics.
2. Mixed-lane reliability metrics (disconnect count, timeout count, transfer completion).
- Done when:
1. 60-minute mixed soak meets non-negotiable gates.

Task C3
- Owner: INVESTIGATOR
- Goal: Analyze any failures from C1/C2 and provide root-cause confidence.
- Outputs:
1. Evidence-backed RCA report.
2. Fix recommendations ranked by impact/risk.
- Done when:
1. Manager has clear go/no-go recommendation.

Task C4
- Owner: REVIEWER
- Goal: Final pre-canary review across evidence bundle.
- Outputs:
1. Launch-risk assessment.
2. Explicit waived vs unresolved risks list.
- Done when:
1. No unresolved critical/high launch blockers.

## Sprint D: Canary And Rollback Readiness

Task D1
- Owner: MANAGER
- Goal: Approve canary only if all gates are green.
- Inputs: A/B/C evidence and reviewer reports.
- Outputs:
1. Go/no-go decision record.
2. Canary scope and observation window.

Task D2
- Owner: WORKER
- Goal: Execute canary and monitor telemetry.
- Outputs:
1. Daily status snapshot (disconnects, timeouts, workflow pass rates, HID success rate).

Task D3
- Owner: MANAGER
- Goal: Promote or rollback.
- Decision rule:
1. Promote only with stable metrics and no severe unresolved issues.
2. Rollback immediately via HID-off firmware variant if gates fail.
