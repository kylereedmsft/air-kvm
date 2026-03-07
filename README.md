# air-kvm

POC monorepo for an ESP32-driven remote-control experiment:
- `firmware/`: ESP32 PlatformIO C++ firmware (BLE HID + control protocol stubs)
- `mcp/`: local STDIO MCP server for AI agent integration
- `extension/`: Edge/Chrome MV3 extension for browser state/screenshot capture bridge

Deployment topology:
- Controller/host machine: AI agent + MCP + firmware UART connection
- Target machine: browser extension only
- Extension external transport: BLE only (never MCP/localhost)

## Quick start

Run the full local build/test loop:

```bash
./scripts/ci.sh
```
