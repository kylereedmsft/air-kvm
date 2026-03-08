# Manager Plan (Compact)

## Roles
- MANAGER: plan, sequencing, verification.
- WORKER: implement one approved step at a time and report concrete changes.
- REVIEWER: adversarial pre-commit review (bugs/regressions/tests/cross-platform risk).
- INVESTIGATOR: evidence-first root-cause analysis when failures are unclear.

## Working Rules
1. Manager defines step order.
2. Worker executes one step at a time.
3. Reviewer runs before commit; critical/high findings must be fixed or explicitly waived.
4. Investigator is mandatory when cause is uncertain.

## Active Track (Option 2 Cleanup)
Status: In progress

0. [x] Add `airkvm_exec_js_tab` structured MCP/extension/firmware pass-through feature with tests/docs.
0. [x] Add `airkvm_open_tab` structured MCP/extension/firmware pass-through feature with tests/docs.
1. [x] Add docs/code parity guard for screenshot contract bounds.
2. [x] Introduce shared screenshot contract constants (MCP + extension).
3. [x] Consolidate duplicated bridge log formatting helpers.
4. [x] Refactor service worker command handling to dispatch map + shared error wrapper.
5. [x] Add service-worker-specific tests (dispatch + transfer lifecycle + bridge error paths).
6. [x] Run focused live validation sweep after cleanup (open tab -> bytebeat navigation -> play click -> tab screenshot save).

## Backlog (Option 3 Major Consolidation)
Status: Not started

1. [ ] Split `extension/src/service_worker.js` into focused modules:
   - `command_dispatch.js`
   - `capture.js`
   - `transfer_session.js`
   - `bridge_client.js`
   - `tab_targeting.js`
2. [ ] Evaluate removal of legacy protocol branches:
   - MCP `legacy_ctrl` fallback in `mcp/src/uart.js`
   - firmware parse branches for `screenshot.meta` / `screenshot.chunk`
3. [ ] Add guardrail telemetry/assertions before removing legacy branches.
4. [ ] Expand integration tests for transfer lifecycle and reconnect/resume behavior.
