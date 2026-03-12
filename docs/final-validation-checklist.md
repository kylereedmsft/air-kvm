# Final Validation Checklist (HID + Browser Coexistence)

Use this checklist to close out HID/browser coexistence validation on a flashed device.

## Preconditions

1. Firmware flashed:
```bash
cd firmware
pio run -e esp32dev -t upload
```
2. Extension loaded/reloaded on target machine.
3. Target OS has paired/bonded HID device at least once.
4. No UART monitor process running during MCP tests (`pio device monitor`, `screen`, etc.).

## Test Mode Requirement

Run validation against one long-lived MCP server process (real topology), not rapid one-shot respawn loops.

Use the persistent-session lane runner:
```bash
cd /Users/kylereed/project/air-kvm
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs mixed 20
```

## Closeout Matrix

Track each row with pass/fail counts and notes.

1. Browser-only lane (10 iterations)
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs browser 10`
- Tool sequence inside lane:
  `airkvm_list_tabs` -> `airkvm_open_tab` (`https://example.com/`) ->
  `airkvm_exec_js_tab` (`document.title`) -> `airkvm_screenshot_tab`

2. HID-only lane (10 iterations)
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs hid 10`

3. Mixed lane (20 iterations, strict order)
- `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs mixed 20`

4. Reconnect lane (5 cycles)
- Disconnect browser BLE session and reconnect.
- Verify HID remains paired/usable.
- Run one mixed-lane iteration after each reconnect:
  `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs mixed 1`

5. Sleep/wake lane (3 cycles)
- Put target machine to sleep and wake.
- Confirm HID reconnect and browser reconnect.
- Run one mixed-lane iteration after wake:
  `AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-session-lane.mjs mixed 1`

## Failure Criteria

Treat any of the following as a blocker:

1. `tabs.list.error` with `tabs_list_send_failed`.
2. `transport_error` or UART open failures in real single-process MCP mode.
3. Missing HID event behavior while command forwarding reports success.
4. Browser BLE path regressions after HID pairing/reconnect.

## Evidence Capture

Record:

1. Date/time and firmware build.
2. Command lines used.
3. Pass/fail totals for each lane.
4. First failure log snippet (if any) with timestamp.
5. Final disposition: `GO` (ship baseline) or `NO-GO` (open fix sprint).

## Ship Gate

Baseline is shippable when all lanes pass without blocker failures and at least 20 mixed-lane iterations complete cleanly.
