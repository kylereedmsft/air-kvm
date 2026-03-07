# Development

## Prerequisites

- Node.js 20+
- PlatformIO CLI (`pio`)
- ESP32 board support installed in PlatformIO

## Deployment note

- Controller/host machine runs MCP and connects to firmware over UART.
- Target machine runs only the browser extension.
- Extension does not connect to MCP.
- Extension external transport is BLE only.

## Build and test

From repo root:

```bash
./scripts/ci.sh
```

This runs:

1. `mcp`: `node --test`
2. `extension`: `node --test`
3. `firmware`: `pio test -e native`
4. `firmware`: `pio run -e esp32dev`

## Manual runs

MCP server:

```bash
cd mcp
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js
```

Optional MCP env vars:
- `AIRKVM_SERIAL_BAUD` (default `115200`)

Firmware serial monitor:

```bash
cd firmware
pio device monitor
```

BLE manual test reference:
- See `docs/protocol.md` section **BLE Manual Testing** for characteristic UUIDs, valid payloads, and expected responses.

Integrated local smoke test (MCP + firmware command):

```bash
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/poc-smoke.mjs
```

## Next implementation milestones

1. Implement real firmware HID injection using NimBLE HID primitives.
2. Add extension screenshot request/response path.
3. Add integration test harness with fake serial transport.
4. Persist extension event history and expose richer query tools.
