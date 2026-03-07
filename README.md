# air-kvm

POC monorepo for an ESP32-driven remote-control experiment:
- `firmware/`: ESP32 PlatformIO C++ firmware (BLE HID + control protocol stubs)
- `mcp/`: local STDIO MCP server for AI agent integration
- `extension/`: Edge/Chrome MV3 extension for browser state/screenshot capture bridge

## Quick start

Run the full local build/test loop:

```bash
./scripts/ci.sh
```
