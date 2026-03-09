# Development

## Prerequisites

- Node.js 20+
- PlatformIO CLI (`pio`)
- ESP32 platform installed in PlatformIO

## Runtime Topology

- Host/controller runs MCP and connects to firmware via UART.
- Target machine runs extension only.
- Extension talks to firmware via BLE only.

## Build and Test

From repo root:

```bash
./scripts/ci.sh
```

This runs:
1. `cd mcp && node --test`
2. `cd extension && node --test`
3. `cd firmware && pio test -e native`
4. `cd firmware && pio run -e esp32dev`

## Firmware Build Variants (HID Off / HID On)

Default variant (HID off, unchanged current path):

```bash
cd firmware
pio run -e esp32dev
```

HID+UART coexistence variant (HID enabled):

```bash
cd firmware
pio run -e esp32dev_hid_uart
```

Flash default HID-off variant:

```bash
cd firmware
pio run -e esp32dev -t upload
```

Flash HID+UART variant:

```bash
cd firmware
pio run -e esp32dev_hid_uart -t upload
```

Rollback guidance:
1. Reflash with default HID-off: `cd firmware && pio run -e esp32dev -t upload`.
2. Power-cycle/reset device and reconnect BLE.
3. If host pairing behavior changed during HID testing, clear the host BLE pairing cache and pair again.

## Manual Commands

Run MCP server:

```bash
cd mcp
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js
```

Run MCP tool harness (single tool call):

```bash
node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"manual-1"}'
node scripts/mcp-tool-call.mjs airkvm_screenshot_tab '{"request_id":"shot-1","max_width":1280,"max_height":720,"quality":0.6}'
```

Optional screenshot autosave (for debugging):

```bash
AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_desktop '{"request_id":"shot-desktop-1","desktop_delay_ms":800}'
```

Run integrated smoke script:

```bash
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/poc-smoke.mjs
```

Firmware monitor:

```bash
cd firmware
pio device monitor
```

## Environment Variables

MCP runtime:
- `AIRKVM_SERIAL_PORT` (default `/dev/cu.usbserial-0001`)
- `AIRKVM_SERIAL_BAUD` (default `115200`)
- `AIRKVM_SERIAL_TIMEOUT_MS` (default `3000`)
- `AIRKVM_UART_DEBUG=1` (enable UART debug logs to stderr)

Tool harness:
- `AIRKVM_TOOL_TIMEOUT_MS` (default `120000`)
- `AIRKVM_SAVE_SCREENSHOTS=1` (optional screenshot file save to `temp/`)

Firmware build/runtime:
- `AIRKVM_ENABLE_HID` compile-time switch (default `0` in current app config)

## BLE Manual Reference

See `docs/protocol.md`:
- BLE service/characteristic UUIDs
- control + binary framing behavior
- screenshot transfer flow (`transfer.*`)

## Current Focus Areas

1. Harden long-running screenshot reliability and observability.
2. Keep docs/protocol synchronized with code after transport changes.
3. Revisit HID-enabled firmware path when input-injection milestones are prioritized.
