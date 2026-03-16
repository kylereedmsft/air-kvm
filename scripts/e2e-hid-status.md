# E2E HID Test — Work In Progress

## What this test does
`scripts/e2e-hid.mjs` exercises the full AirKVM stack end-to-end:
1. Opens a browser tab on the target machine (via MCP → UART → firmware → BLE → extension)
2. Injects a fixture (textarea + 4 buttons) via `exec_js_tab`
3. Gets window position via `airkvm_window_bounds`
4. Gets element rects + toolbar height via `exec_js_tab`
5. Slams mouse to top-left corner (-32000,-32000) then moves relatively to each element
6. Clicks each button (should append "Button N Pressed\n" to textarea)
7. Clicks into textarea, types all printable ASCII (0x20–0x7E)
8. Reads textarea via `exec_js_tab` and validates content

## Current status: FAILING — responses shifted by one

### Symptom
Responses are one position off:
- `inject fixture` gets the `tab.open` response (so `value_json` is undefined)
- `get window bounds` gets the `js.exec.result` for inject (so `bounds` is null)
- `gather rects` gets the bounds response (so layout is null)
- Everything downstream fails because coords are (0,0) + no rects

### Root cause hypothesis
Something is sending an **extra unsolicited message** between `open_tab` completing and `inject fixture`.
The uart.js `_handleMessage` is purely FIFO — the first message received resolves the pending promise,
regardless of `request_id`. So if the extension emits a spurious message after open_tab, it
shifts all subsequent responses by one.

### Leads to investigate
1. `busy.changed` from content script fires when `exec_js_tab` starts/ends — sends `state.set` via
   `sendViaHalfPipe` (service_worker.js line 357). This could be the extra message.
2. Check if content script injection sends a `busy.changed` before open_tab fully resolves.
3. Consider matching responses by `request_id` in `uart.js` instead of FIFO to make this robust.

### How to debug
Run with bridge logs before/after to see what messages flow:
```
node scripts/mcp-tool-call.mjs airkvm_bridge_logs '{}'
node scripts/e2e-hid.mjs > /tmp/e2e-hid-out.txt 2>&1
node scripts/mcp-tool-call.mjs airkvm_bridge_logs '{}'
```

## Bugs fixed in this branch (already working)

### BLE MTU truncation
- Default NimBLE MTU = 44 bytes (41 payload + 3 ATT overhead)
- A full CHUNK frame is 267 bytes — got silently truncated → CRC mismatch → ACK never sent → timeout
- Fix: `NimBLEDevice::setMTU(512)` in `firmware/src/app.cpp`
- **Flashed and confirmed working**

### mouse.move_abs removed
- `MouseMoveAbs` in firmware was always a stub that returned `true` without doing anything
- HID descriptor is relative-only; abs requires a digitizer descriptor
- Removed from: firmware protocol enum/parser/router, MCP protocol, MCP tests
- E2E test uses corner-slam (-32000,-32000) + relative moves from known origin

### key.type max length bumped 128→200
- `firmware/src/hid_controller.cpp` and `mcp/src/protocol.js`

### airkvm_echo tool added
- MCP tool + extension handler for transport round-trip debugging
- `type: echo.request` → extension echoes back `type: echo.response`

### Firmware log frames surfaced in MCP
- `mcp/src/uart.js` now calls `halfpipe.onLog()` and prints `[uart] [fw-log] ...` to stderr always

## Files changed
- `scripts/e2e-hid.mjs` — main test (new file, untracked)
- `mcp/src/protocol.js` — removed mouse_move_abs, added echo tool
- `mcp/src/uart.js` — added onLog handler
- `mcp/test/protocol.test.js` — updated for removed tool
- `mcp/test/server.test.js` — updated tools/list snapshot
- `firmware/src/app.cpp` — NimBLEDevice::setMTU(512)
- `firmware/include/protocol.hpp` — removed MouseMoveAbs from enum
- `firmware/src/protocol.cpp` — removed mouse.move_abs parse branch
- `firmware/src/command_router.cpp` — removed MouseMoveAbs stub
- `firmware/src/hid_controller.cpp` — key.type max 200
- `extension/src/service_worker.js` — added echo.request handler
- `extension/src/ble_bridge.js` — removed temp debug log (was [dbg] feedBytes)

## Next session: fix the shifted-response bug
Options:
1. **Match by request_id** in `uart.js` — queue pending promises keyed by request_id, match on
   `msg.request_id`. This is the robust fix that survives any spurious messages.
2. **Drain spurious messages** — add a small sleep after open_tab, or flush pending messages before
   sending inject.
3. **Investigate busy.changed** — check if content script fires busy.changed during tab load which
   triggers an extra `state.set` message before the test's first exec_js.

Option 1 is cleanest. In `uart.js`, change `_pending` from a single slot to a Map keyed by
`request_id`. In `protocol.js`, every tool's `build()` fn already includes `request_id`. Match on
`msg.request_id` in `_handleMessage`.
