# Architecture (POC)

## Deployment topology

- Controller/host machine: runs AI agent + MCP server + UART link to ESP32 firmware.
- Target machine: runs only the browser extension.
- Extension never connects to MCP.
- Extension external transport is BLE only.

## Layers

1. Firmware (`firmware/`, ESP-WROOM-32)
- BLE HID keyboard/mouse (stubbed wiring in current scaffold)
- Serial JSONL command intake from local agent host
- Future: custom BLE GATT state/screenshot bridge

2. Local MCP Server (`mcp/`)
- STDIO JSON-RPC server with MCP-compatible tool endpoints
- Validates AI-issued control commands
- Bridges commands to firmware over UART serial (`AIRKVM_SERIAL_PORT`)

3. Browser Extension (`extension/`)
- Content script emits compact DOM summary + busy/idle events
- Service worker forwards extension events via BLE only
- Future: on-demand screenshot capture + chunk transport

## Data flows

- AI agent -> MCP tool call -> validated command -> firmware transport
- Firmware -> BLE HID -> target machine input injection

## Why this split

- Keeps BLE bandwidth focused on HID control and minimal metadata
- Enables iterative protocol changes without reflashing for every change
- Supports future migration from serial to Wi-Fi transport without changing MCP tool surface
