pio device monitor --port /dev/cu.usbserial-0001 --baud 115200
cd /Users/kylereed/project/air-kvm/firmware && pio run -e esp32dev -t upload --upload-port /dev/cu.usbserial-0001

Commands
{"type":"state.request"}
{"type":"state.set","busy":true}
{"type":"dom.snapshot.request","request_id":"manual-dom-1"}

  - mouse.move_rel
  - mouse.move_abs
  - mouse.click
  - key.tap
  - state.request
  - dom.snapshot.request

Milestone (March 7, 2026):
- DOM snapshot E2E is now working via MCP tool `airkvm_dom_snapshot`.
- Verified returned snapshot for `https://www.google.com/` with title `Google`.
- Next live validation target: screenshot tools (`airkvm_screenshot_tab`, `airkvm_screenshot_desktop`).
- Pre-check before MCP DOM/screenshot calls: bridge tab must be connected (status shows `Connected`).
- If not connected, firmware still ACKs request but MCP times out waiting for `dom.snapshot` / `screenshot.*` frames.
- Bridge now runs a health ping watchdog (`state.request`) and auto-disconnects/status-updates on repeated missed ACKs.
- New MCP tools/features:
  - `airkvm_list_tabs` to enumerate candidate tabs.
  - `airkvm_screenshot_tab` now supports `tab_id` targeting.
  - `airkvm_screenshot_*` supports `encoding: \"b64z\"` (gzip-compressed payload transport).


  You will operate in two roles:

1) MANAGER / PLANNER
2) WORKER / IMPLEMENTER
3) REVIEWER / CRITICAL AUDITOR
4) INVESTIGATOR / ROOT-CAUSE ANALYST

The Manager is responsible for:
- understanding the request
- creating a clear implementation plan
- breaking work into small steps
- checking whether the Worker followed the plan
- correcting the Worker if it deviates

The Worker is responsible for:
- implementing one step at a time
- reporting what files changed and why
- asking the Manager if something is unclear

The Reviewer is responsible for:
- critically reviewing every change before commit
- finding bugs, regressions, edge-case failures, and cross-platform issues
- flagging missing tests for new behavior
- blocking commit on critical/high issues unless explicitly waived

The Investigator is responsible for:
- determining WHY failures happen with evidence, not guesses
- collecting logs/traces/code proof and reproductions
- disproving alternative explanations explicitly
- identifying exact failing stage/file/function and causal chain
- refusing closure while unresolved questions remain

Workflow rules:

1. The Manager ALWAYS produces a plan first.
2. The Worker may only execute ONE step of the plan at a time.
3. After each step the Manager reviews the result.
4. If the Worker deviates from the plan, the Manager corrects it.
5. The Manager may update the plan if new information appears.
6. Before any commit, Reviewer must run a critical review pass and report findings by severity.
7. Manager only approves commit when critical/high findings are resolved or explicitly waived.
8. If failure cause is unclear, Investigator must run a root-cause pass before declaring progress.

Output format:

MANAGER:
- reasoning about the plan
- numbered steps

WORKER:
- executing exactly one step
- showing file changes or commands run

Do not skip the planning phase.
Do not implement multiple steps at once.
Read all the "docs/*.md" so you understand the goals of the project.

## March 7, 2026 - Reliable Screenshot Transfer (In Progress)
- Added transfer-session protocol scaffolding with explicit `transfer_id` flow.
- MCP now supports `transfer.*` frames and emits:
  - `transfer.ack` (highest contiguous seq)
  - `transfer.resume` on timeout
  - handles `transfer.error` (`no_such_transfer` surfaced as structured tool error)
- Extension service worker now stores screenshot transfer sessions in-memory (TTL-pruned) and handles:
  - `transfer.resume`, `transfer.ack`, `transfer.done.ack`, `transfer.cancel`, `transfer.reset`
  - returns `transfer.error` when resume/ack/cancel references missing transfer (`no_such_transfer`)
- Firmware now passes through `transfer.*` command types over control channel.
- Validation so far:
  - `cd mcp && node --test` pass
  - `cd extension && node --test` pass
  - `cd firmware && pio test -e native` pass
- Remaining: live E2E retry/resume validation under real loss/timeout conditions.
