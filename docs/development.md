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
2. `cd extension && node --test && npm run build`
3. `cd firmware && pio test -e native`
4. `cd firmware && pio run -e esp32dev`

## Firmware Build

Build:

```bash
cd firmware
pio run -e esp32dev
```

Flash to device:

```bash
cd firmware
pio run -e esp32dev -t upload
```

Rollback guidance:
1. Reflash: `cd firmware && pio run -e esp32dev -t upload`.
2. Power-cycle/reset device and reconnect BLE.
3. If host pairing behavior changed, clear the host BLE pairing cache and pair again.

## Loading the Extension in Chrome/Edge

Load `extension/dist/` as an unpacked extension (Chrome → Extensions → Load unpacked).
Build it first:

```bash
cd extension && npm run build
```

`dist/` is rebuilt by `./scripts/ci.sh` automatically.

## Manual Commands

Run MCP server:

```bash
cd mcp
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js
```

Run MCP tool harness (single tool call):

```bash
node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"manual-1"}'
node scripts/mcp-tool-call.mjs airkvm_accessibility_snapshot '{"request_id":"ax-1"}'
node scripts/mcp-tool-call.mjs airkvm_screenshot_tab '{"request_id":"shot-1","max_width":1280,"max_height":720,"quality":0.6}'
```

Optional screenshot autosave (for debugging):

```bash
AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_desktop '{"request_id":"shot-desktop-1","desktop_delay_ms":800}'
```

Run MCP↔firmware integration script:

```bash
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/mcp-fw-integration.mjs
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
- `AIRKVM_UART_LOG_PATH=/tmp/airkvm-uart.log` (append UART logs to a file while MCP owns the serial port)

Tool harness:
- `AIRKVM_TOOL_TIMEOUT_MS` (default `120000`)
- `AIRKVM_SAVE_SCREENSHOTS=1` (optional screenshot file save to `temp/`)

Firmware build/runtime:
- No compile-time feature flags — HID and BLE security are unconditionally enabled.

## BLE Manual Reference

See `docs/protocol.md`:
- BLE service/characteristic UUIDs
- control + binary framing behavior
- screenshot transfer flow (AK frame chunking with ack/nack/reset frames)

## Current Focus Areas

1. Harden long-running screenshot reliability and observability.
2. Keep docs/protocol synchronized with code after transport changes.
