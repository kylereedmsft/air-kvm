# E2E HID Status

## Current state
`scripts/e2e-hid.mjs` now passes end to end.

Latest live result:
- `27/27` passed
- textarea focus works
- printable ASCII typing works
- all 4 button clicks register
- final click log shows the expected textarea + button sequence

## What changed

### Transport and routing
These are no longer the blocker:
- MCP request/response matching is fixed
- extension busy-state routing is fixed
- `scripts/poc-smoke.mjs` passes
- `scripts/e2e-integration.mjs` passes

### Absolute HID path
The working HID path is:
- digitizer-style absolute HID report
- browser-reported logical screen metrics from `airkvm_window_bounds`
- direct `screen -> abs` mapping using logical `screen.width` / `screen.height`

Important browser values on this machine:
- `devicePixelRatio = 2`
- `screen.width = 1512`
- `screen.height = 982`

Interpretation:
- absolute HID must map against the browser-reported logical screen size
- using the physical `3024 × 1964` size directly was wrong

### Silent browser automation path
The key fix for the final HID flakiness was removing CDP from the HID test path.

Current split:
- `airkvm_exec_js_tab`
  - CDP-backed
  - can show debugger UI / banner
  - use for arbitrary eval and diagnostics
- `airkvm_inject_js_tab`
  - `chrome.scripting.executeScript` backed
  - silent path for fixture setup/readback
  - used by `scripts/e2e-hid.mjs`

### `window_bounds`
`airkvm_window_bounds` now provides the screen metrics needed for HID targeting:
- `device_pixel_ratio`
- logical `screen.width`
- logical `screen.height`
- `viewport.inner_width`
- `viewport.inner_height`
- `viewport.outer_width`
- `viewport.outer_height`
- `viewport.screen_x`
- `viewport.screen_y`

The HID test also now uses the windows API path directly for bounds, not the old CDP `Browser.getWindowForTarget` fast path.

## HID test behavior
`scripts/e2e-hid.mjs` now:
- opens a real tab
- injects a deterministic textarea + 4 button fixture via `airkvm_inject_js_tab`
- reads element rects via `airkvm_inject_js_tab`
- uses `airkvm_window_bounds` + logical screen metrics to compute absolute HID targets
- double-clicks the textarea before typing
  - first click raises/focuses the window
  - second click places the caret
- types printable ASCII
- clicks all 4 buttons
- validates textarea content and button log via `airkvm_inject_js_tab`

The fixture keeps typing and button logging separate:
- textarea: typed ASCII payload
- log area: `Button N Pressed`

This avoids the earlier false signal where button handlers mutated the same textarea used for typing assertions.

## Safety fixes
Before the final passing run, two guardrails were added:
- `scripts/e2e-hid.mjs` aborts if fixture injection or layout readback fails
- it no longer continues into HID typing/clicking after setup failure

That prevents the old failure mode where a bad setup caused HID typing to land in the shell or another unfocused target.

## Cleanup
The old popup calibration tooling was useful for debugging but is no longer part of the active solution.

Removed:
- calibration popup assets
- calibration MCP tools
- calibration helper scripts

The working solution is the direct logical-screen model plus silent injection.
