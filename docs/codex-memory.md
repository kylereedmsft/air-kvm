# Codex Memory (Compact)

## Current Truth
- Topology:
  - Host/controller runs MCP and connects to firmware over UART.
  - Target machine runs extension only.
  - Extension talks to firmware via BLE only (no localhost/MCP direct path).
- Active transport/protocol path:
  - BLE UART-style GATT service (`6E400101-B5A3-F393-E0A9-E50E24DCCB01`).
  - Firmware UART output uses framed `AK` packets:
    - `0x01` binary transfer chunk
    - `0x02` control JSON
    - `0x03` log text
- Current BLE device name: `air-kvm-ctrl-cb01`.
- Current MCP tools:
  - `airkvm_send`
  - `airkvm_list_tabs`
  - `airkvm_open_tab`
  - `airkvm_dom_snapshot`
  - `airkvm_exec_js_tab`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`

## Key Decisions
- Determinism / fail-fast:
  - ESP32 TX queue creation failure is fatal (`abort()`), no degraded fallback path.
  - ESP32 UART TX uses one deterministic queue/task writer path.
- Screenshot transfer path:
  - Binary transfer is authoritative (`encoding: "bin"`).
  - Lifecycle uses `transfer.meta` -> binary chunks -> `transfer.done` -> `transfer.done.ack`.
  - MCP drives flow control with `transfer.ack`, `transfer.nack`, `transfer.resume`.
  - Extension enforces one active screenshot transfer session.
- BLE control continuation:
  - Oversized BLE control payloads use `ctrl.chunk`; extension reassembles before dispatch.

## Logging Defaults
- Bridge page logging defaults to low-noise mode.
- Verbose mode toggle exists in bridge UI and controls raw BLE trace visibility.
- Default command log behavior:
  - suppress `SW->BLE` command entries unless verbose
  - suppress ACK-noise (`transfer.ack`, plain `{ok:true}`) unless verbose
  - classify plain `{ok:true}` as `type: "ack"` when shown

## User Preferences (Operational)
- Cross-platform first (Node-based paths; avoid OS-specific command dependencies in core flow).
- Commit frequently.
- Keep `codex-memory` updated when important behavior/process decisions change.

## Known Risks / Gaps
- Service-worker tests are now present for `js.exec` and `tab.open`, but transfer-lifecycle fault coverage is still incomplete.
- HID path exists in firmware code but is not the primary validated runtime path (`AIRKVM_ENABLE_HID=0` in default app build).
- Deterministic HID click targeting depends on host cursor travel reliability and browser-window coordinate mapping.

## Recent Live Validation
- `airkvm_open_tab` successfully opened `https://kylereedmsft.github.io/`.
- `airkvm_exec_js_tab` was used to navigate to the bytebeat page and click Play (button state changed to Stop).
- `airkvm_screenshot_tab` succeeded with `AIRKVM_SAVE_SCREENSHOTS=1` and saved a JPEG into `temp/`.

## Latest Memory (HID + Browser Coexistence)
- Root cause discovered for missed HID clicks:
  - Firmware `mouse.move_rel` was clamping each command to HID axis limits (`-127..127`) with no chunking, so large moves did not reach intended coordinates.
- Current implementation direction:
  - Keep relative HID mode for compatibility.
  - Chunk large `mouse.move_rel` commands into multiple HID reports in firmware.
  - Do **not** rely on heuristic firmware `mouse.move_abs` as a correctness primitive.
- New HID typing command added:
  - `{"type":"key.type","text":"Bluetooth"}`
  - Validation and firmware support are aligned to `[A-Za-z0-9 ]` with max length `128`.
  - Firmware now returns `{"ok":false,"error":"command_rejected"}` on HID injection failure instead of always reporting success.
  - TODO: add an escape syntax for special keys inside `key.type` strings (for example Enter/Tab/modifiers), while keeping plain text fast-path.
- Mouse targeting wrap-up TODO:
  - Current relative-coordinate targeting is still not accurate enough for deterministic cross-window OS automation.
  - Next sprint should implement true HID absolute pointer support (`mouse.move_abs`) with calibration for desktop bounds and multi-monitor mapping.
- Screenshot metadata path now includes sizing context in `transfer.meta`:
  - `source_width`, `source_height`, `encoded_width`, `encoded_height`, `encoded_quality`, `encode_attempts`.
- New E2E harness for exact Google mixed test:
  - `scripts/e2e-google-hid-search.mjs`
  - Flow: open Google -> screenshot -> resolve search box + window metrics -> HID click -> HID type -> Enter.
- Operational note:
  - Use approved command paths for UART access; non-approved execution shapes can trigger serial `Operation not permitted` failures in this environment.

## Pointers
- Protocol authority: `docs/protocol.md`
- Current architecture summary: `docs/architecture.md`
- Current execution plan/backlog: `manager_plan.md` + `docs/plan.md`
