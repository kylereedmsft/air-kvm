# HID + Browser Coexistence Canary Rollout

## Goal

Roll out HID-enabled firmware safely while preserving browser BLE workflows.

## Entry Criteria

1. `docs/final-validation-checklist.md` completed with no blocker failures.
2. Baseline firmware validated on target hardware (`esp32dev_hid_uart` or `esp32dev_hid_uart_compat`).
3. Recovery path ready (known-good pre-HID firmware artifact available).

## Canary Stages

1. Stage 0: Single-operator canary (1 device, 1 day)
- Run browser lane `10`, HID lane `10`, mixed lane `20` once at session start.
- Repeat mixed lane `20` after several hours.
- Manual reconnect check: 3 cycles.

2. Stage 1: Small canary (2-3 devices, 2 days)
- Per device per day: mixed lane `20` at least twice.
- At least one sleep/wake cycle per device per day.

3. Stage 2: Broad canary (all test devices, 2-3 days)
- Per device per day: mixed lane `20` once.
- Spot-check browser lane `10` and HID lane `10`.

## Go/No-Go Gates

GO only if all are true:

1. No `transport_error` in persistent MCP mode.
2. No `tabs_list_send_failed`.
3. No observed HID loss while browser lane remains healthy.
4. No unrecoverable reconnect failures after sleep/wake.

NO-GO if any are true:

1. Reproducible lane failure on 2+ independent runs.
2. Any blocker listed in `docs/final-validation-checklist.md`.
3. New regression in browser screenshot/DOM/tab flows.

## Rollback

1. Stop HID canary immediately.
2. Reflash known-good non-canary firmware.
3. Re-run browser lane `10` to confirm recovery.
4. Capture logs and environment details; open fix sprint with exact repro.

## Evidence to Capture

1. Firmware build used and flash timestamp.
2. Lane outputs (`browser`, `hid`, `mixed`) with pass/fail counts.
3. Reconnect/sleep notes per stage.
4. Final decision per stage: `GO` or `NO-GO`.
