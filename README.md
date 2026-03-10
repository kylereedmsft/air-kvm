# air-kvm

POC monorepo for an ESP32-driven remote-control experiment:
- `firmware/`: ESP32 PlatformIO C++ firmware (BLE HID + control protocol stubs)
- `mcp/`: local STDIO MCP server for AI agent integration
- `extension/`: Edge/Chrome MV3 extension for browser state/screenshot capture bridge

## How it works

```
┌─────────────────────────────────────┐     ┌──────────────────────────────────┐
│         CONTROLLER MACHINE          │     │         TARGET MACHINE           │
│                                     │     │                                  │
│  ┌───────────┐    JSON-RPC/STDIO    │     │                                  │
│  │  AI Agent │◄────────────────►    │     │                                  │
│  │ (Copilot) │                 │    │     │    ┌────────────────────────┐    │
│  └───────────┘           ┌─────┴──┐ │     │    │   Edge/Chrome Browser  │    │
│                          │  MCP   │ │     │    │                        │    │
│                          │ Server │ │     │    │  ┌──────────────────┐  │    │
│                          └───┬────┘ │     │    │  │    Extension     │  │    │
│                              │      │     │    │  │  (BLE Bridge +   │  │    │
│                         UART │      │     │    │  │   DOM/Screenshot │  │    │
│                        115200│baud  │     │    │  │   capture)       │  │    │
│                              │      │     │    │  └────────┬─────────┘  │    │
│                          ┌───┴────┐ │     │    └───────────┼────────────┘    │
│                          │ ESP32  │ │     │                │                 │
│                          │Firmware│◄──BLE──────────────────┘                 │
│                          └────────┘ │     │                                  │
│                              │      │     │  HID Keyboard/Mouse appears as   │
│                              │ HID  │     │  a native Bluetooth peripheral   │
│                              └──────┼─────┼──► Keyboard & Mouse input        │
│                                     │     │                                  │
└─────────────────────────────────────┘     └──────────────────────────────────┘

Data paths:
  AI ←JSON-RPC→ MCP ←UART→ ESP32 ←BLE→ Extension    (DOM, tabs, screenshots)
  AI ←JSON-RPC→ MCP ←UART→ ESP32 ←BLE HID→ OS       (keyboard & mouse input)
```

Deployment topology:
- Controller/host machine: AI agent + MCP + firmware UART connection
- Target machine: browser extension only
- Extension external transport: BLE only (never MCP/localhost)

## Quick start

Run the full local build/test loop:

```bash
./scripts/ci.sh
```

## MCP server setup

Install dependencies and start the server:

```bash
cd mcp
npm install
AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js
```

### MCP client configuration

Add the following to your `mcp.json` (or equivalent MCP client config), adjusting `cwd` and `AIRKVM_SERIAL_PORT` for your system:

```json
{
  "mcpServers": {
    "air-kvm": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/path/to/air-kvm/mcp",
      "env": {
        "AIRKVM_SERIAL_PORT": "/dev/cu.usbserial-0001"
      }
    }
  }
}
```

| Environment variable | Description | Default |
|---|---|---|
| `AIRKVM_SERIAL_PORT` | UART device path (`COM3` on Windows, `/dev/cu.usbserial-*` on macOS) | `/dev/cu.usbserial-0001` |
| `AIRKVM_SERIAL_BAUD` | UART baud rate | `115200` |
| `AIRKVM_SERIAL_TIMEOUT_MS` | Command timeout in milliseconds | `3000` |
| `AIRKVM_UART_DEBUG` | Set to `1` to enable debug logging | off |
