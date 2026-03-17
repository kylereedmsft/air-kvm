# E2E HID Status

## Scope
`scripts/e2e-hid.mjs` exercises the full AirKVM path:
1. MCP tool call
2. UART to firmware
3. Firmware BLE bridge
4. Extension service worker automation
5. HID mouse/keyboard injection back through firmware
6. Browser-side validation in the target tab

The current blocker is no longer transport correctness. It is HID targeting accuracy on macOS.

## Current status
Transport and routing are working.

The current state is:
- relative-mode HID is not reliable enough for open-loop page targeting
- absolute mouse HID descriptor was ignored by the host
- absolute digitizer-style HID descriptor is honored by the host
- popup-local absolute calibration works very well
- transferring that calibration to the real browser tab is still the blocker

## What is fixed

### Request matching bug: fixed
The original shifted-response problem is fixed in `mcp/src/uart.js`.

Current behavior:
- MCP no longer resolves the pending request with the first extension message that arrives
- responses are matched by `request_id` or explicit tool-level matcher
- unmatched extension chatter is ignored instead of shifting all later responses

Evidence:
- `scripts/poc-smoke.mjs` passes
- `scripts/e2e-integration.mjs` passes
- live MCP UART logs no longer show the old one-off response skew

Relevant files:
- `mcp/src/uart.js`
- `mcp/test/uart_transport.test.js`

### Extension busy-state routing bug: fixed
The extension was incorrectly routing firmware-local `state.set` messages onto the MCP-bound HalfPipe message path.

That is now fixed:
- `busy.changed` in `extension/src/service_worker.js` uses `sendControlViaHalfPipe(..., 'fw')`
- `extension/src/ble_bridge.js` routes that as `hp.sendControl(..., kTarget.FW)`

Result:
- stray `state.set` messages no longer appear at MCP during live HID runs
- this confirmed the AK/HalfPipe routing bug was real, but it is no longer the HID blocker

Relevant files:
- `extension/src/service_worker.js`
- `extension/src/ble_bridge.js`

### Bridge log timeout override: fixed
`airkvm_bridge_logs` can legitimately take longer than the old fixed timeout.

Current behavior:
- MCP now supports tool timeout as a function of args
- `airkvm_bridge_logs` accepts `timeout_ms`

Relevant files:
- `mcp/src/server.js`
- `mcp/src/protocol.js`

### MCP UART file logging: fixed
MCP can now log UART traffic while it owns the serial port.

Use:
```bash
AIRKVM_UART_LOG_PATH=/Users/kylereed/project/air-kvm/temp/e2e-hid-uart.log node scripts/e2e-hid.mjs
```

Relevant files:
- `mcp/src/uart.js`
- `mcp/src/index.js`

## Important protocol note
HalfPipe is the only transport.

More precisely:
- HalfPipe emits AK frames
- AK frames carry explicit frame type and target
- routing semantics already exist inside AK/HalfPipe
- do not add alternate transports or side protocols

Correct usage:
- browser automation traffic: `hp.send(...)`
- firmware-local commands: `hp.sendControl(..., kTarget.FW)`

Examples of firmware-local commands:
- `state.set`
- `state.request`
- `fw.version.request`
- HID commands from MCP

## HID-specific findings

### `exec_js_tab` during HID is unsafe
Once HID interaction starts, do not use `exec_js_tab` mid-flow on macOS/Chromium.

Why:
- CDP activity shows the debugger infobar
- that shifts page content vertically
- measured rects become invalid for HID targeting

This is documented in `scripts/e2e-hid.mjs`.

### Browser chrome clicks are unsafe
Clicks in the browser titlebar / omnibox area are not a valid focus strategy.

Observed problems:
- typing can land in the address bar
- on macOS, bad corner/titlebar clicks can move windows
- browser chrome coordinates are not reliable for page-content targeting

### Browser event `screenX/screenY` are only useful inside page content
The temporary cursor test showed:
- inside page content, browser mouse event coordinates are plausible and useful
- over browser chrome/frame, they are not reliable for desktop-global calibration

So page-content acquisition is the key threshold:
- once the cursor is over page content, browser feedback becomes useful
- before that, browser coordinates are not trustworthy

## Calibration tools added

New extension/MCP tools:
- `airkvm_open_window`
- `airkvm_open_calibration_window`
- `airkvm_calibration_status`

New calibration assets:
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `scripts/calibration-home.mjs`
- `scripts/calibration-probe.mjs`
- `scripts/calibration-abs-home.mjs`
- `scripts/calibration-abs-probe.mjs`

Current calibration popup behavior:
- controlled popup window opened by the extension
- live red cursor marker in page content
- four corner targets
- centered `DONE` button
- repeated pointer event reporting
- `DONE` click reporting with actual click coordinates
- popup closes itself after a successful `DONE` click

Service worker calibration state now includes:
- latest pointer event
- `event_count`
- popup layout
- `done_clicked`
- `done_click_event`
- popup window/tab ids

Relevant files:
- `extension/src/service_worker.js`
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `mcp/src/protocol.js`
- `firmware/src/hid_controller.cpp`
- `scripts/e2e-hid.mjs`

## Absolute HID findings

### Absolute mouse descriptor: failed
The first absolute HID experiment used a Generic Desktop mouse-style absolute report.

Observed result:
- firmware accepted `mouse.move_abs`
- host/browser ignored it
- calibration popup saw no pointer movement

Conclusion:
- this descriptor shape is not usable for absolute positioning on this machine

### Digitizer-style absolute descriptor: works
The firmware was changed to expose a digitizer/pen-style absolute report alongside the existing relative path.

Observed result:
- after forgetting and re-pairing the HID device, absolute moves started affecting the browser
- midpoint and bounded probes produced browser-visible pointer events

Conclusion:
- the host honors the digitizer-style absolute report
- absolute mode is viable in principle in this stack

### Popup-local boundary calibration: works
The best current calibration strategy is:
- open a large extension popup
- scan in from left/right/top/bottom until the popup first sees the cursor
- use those four entry hits to build a local popup mapping

This works well enough that the popup test can now:
- hit all four popup corner targets open-loop
- hit the popup `DONE` button center open-loop

One successful live run:
- coarse bounds:
  - left `x=1024` -> `client_x=16`
  - right `x=30719` -> `client_x=1386`
  - top `y=3072` -> `client_y=26`
  - bottom `y=29695` -> `client_y=823`
- open-loop corner hits:
  - `corner_tl` -> `49,49`
  - `corner_tr` -> `1351,49`
  - `corner_bl` -> `49,809`
  - `corner_br` -> `1351,809`
- open-loop `DONE`:
  - target `700,518`
  - landed `700,518`
  - offset `0,0`

Interpretation:
- popup-local absolute calibration is currently the strongest working result
- coarse edge entry is sufficient; exact edge refinement is not required

### Naive full-screen mapping from resolution: failed
The machine resolution was provided as `3024 × 1964`.

A direct screen model was then tested:
- `hid_x ≈ screen_x * 32767 / 3024`
- `hid_y ≈ screen_y * 32767 / 1964`

Observed popup result:
- expected `DONE` screen position missed badly
- popup logged `calibration done screen error: (-366, -283)`
- the move landed at popup `client = 334,216` instead of `DONE`

Interpretation:
- the host is not mapping the digitizer absolute range as a simple full-desktop linear `3024×1964 -> 0..32767`
- popup-local calibration is stronger than a naive whole-screen model

### Real-tab transfer is still the blocker
`scripts/e2e-hid.mjs` now includes:
- absolute popup calibration
- popup `DONE` click/close
- reuse of the learned calibration for real-tab button and textarea targets

What works in the real tab:
- textarea focus
- `key.type`
- final textarea contains printable ASCII

What still fails:
- all 4 button-click assertions

This means:
- absolute targeting is good enough to acquire the page and focus the textarea
- it is still not good enough, or not yet projected correctly, for the smaller button targets in the real tab

## What calibration can do today

### Closed-loop targeting: works
Using browser feedback after each move, the calibration flow can:
- acquire browser content
- touch all four corner targets
- update gain from observed move results
- converge into the `DONE` button and click it

This is now reliable enough to prove:
- HID commands are reaching the browser
- browser-content acquisition is possible
- local correction works

### Relative open-loop transfer: still fails
The earlier relative-mode four-corner calibration proved:
- closed-loop correction can work on the popup
- frozen open-loop transfer still misses badly

That remains true, but the project has now moved past relative mode as the main path.

## Leading hypothesis
The current leading hypothesis is:
- absolute popup calibration is good
- the remaining error is in projecting real-tab document/client coordinates into the same screen-space model that the popup calibration learned

Why this fits the evidence:
- popup-local open-loop targeting can be exact
- the same general calibration does not yet activate the real-tab buttons
- textarea focus is forgiving enough to still work
- a naive full-screen `3024×1964` mapping is measurably wrong
- real-tab geometry is still likely suffering from browser chrome/content-origin uncertainty

Earlier relative-mode evidence about acceleration/nonlinearity is still useful background, but the newest absolute-mode data points more strongly at a geometry/projection mismatch than at pure HID nonlinearity.

## Current state of `scripts/e2e-hid.mjs`

What is true now:
- request/response routing is no longer the blocker
- the test now includes popup-based absolute calibration
- the popup calibration result is being fed into real-tab targeting
- the remaining failure is still the real-tab button clicks

Safety rule now enforced:
- do not click during calibration unless the latest popup-reported cursor position is confirmed inside the intended target
- if the cursor appears to start inside the popup, abort calibration instead of continuing
- this prevents bad calibration runs from clicking the desktop and moving windows

## Recommended next steps

### 1. Instrument real-tab click landing
Before changing the math again, keep collecting direct evidence about what the real clicks are hitting:
- clicked element id
- clicked text
- last click position if possible

### 2. Improve real-tab screen projection
The next real technical problem is:
- translating real-tab DOM/client coordinates into the same screen-space model learned from the popup

That likely means:
- comparing popup-reported `screenX/screenY` against expected screen positions
- tightening browser chrome/content-origin handling
- avoiding stale assumptions from `window_bounds + toolbarHeight`

### 3. Keep popup calibration coarse and safe
The popup work is already good enough:
- coarse boundary entry works
- exact edge refinement is unnecessary
- safety gates should remain in place so bad calibration runs abort instead of clicking the desktop

### 3. If continuing with calibration, test gain vs move magnitude explicitly
`scripts/calibration-probe.mjs` exists for this purpose.

The next valuable experiment would be:
- gather effective gain for multiple move sizes and directions
- see whether large-move behavior diverges enough to model acceleration explicitly

### 4. Absolute positioning now looks more attractive
Based on the current evidence, absolute positioning is a stronger next avenue than continuing to force global open-loop relative motion.

Why:
- relative HID movement is workable in closed loop, but not transferring reliably in open loop
- path history and move magnitude are affecting the result too much
- a stable absolute coordinate model would remove most of the accumulated-path error

The tradeoff:
- absolute HID is more invasive to implement correctly
- it likely requires a different HID descriptor / device model than the current relative mouse path
- calibration still matters, but it becomes a one-time screen mapping problem instead of a continuously drifting relative-control problem

## Files most relevant right now
- `scripts/e2e-hid.mjs`
- `scripts/calibration-home.mjs`
- `scripts/calibration-probe.mjs`
- `extension/src/calibration.html`
- `extension/src/calibration.js`
- `extension/src/service_worker.js`
- `mcp/src/uart.js`
- `mcp/src/protocol.js`
