# Development

## Prerequisites

- Node.js 20+
- PlatformIO CLI (`pio`)
- ESP32 board support installed in PlatformIO

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
node src/index.js
```

Firmware serial monitor:

```bash
cd firmware
pio device monitor
```

## Next implementation milestones

1. Implement real firmware HID injection using NimBLE HID primitives.
2. Add serial transport in MCP to write validated commands to device.
3. Add extension screenshot request/response path.
4. Add integration test harness with fake serial transport.
