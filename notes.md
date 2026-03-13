# Notes (Current)

## Useful Commands
- Full checks:
  - `./scripts/ci.sh`
- MCP tests:
  - `cd mcp && node --test`
- Extension tests:
  - `cd extension && node --test`
- Extension build (load from `extension/dist/` in Chrome/Edge):
  - `cd extension && npm run build`
- Firmware host tests:
  - `cd firmware && pio test -e native`
- Firmware build:
  - `cd firmware && pio run -e esp32dev`
- Firmware flash:
  - `cd firmware && pio run -e esp32dev -t upload --upload-port /dev/cu.usbserial-0001`
- Firmware monitor:
  - `cd firmware && pio device monitor --port /dev/cu.usbserial-0001 --baud 115200`

## MCP Live / Harness
- Run MCP server:
  - `cd mcp && AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node src/index.js`
- One-off MCP tool call harness:
  - `node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"dom-1"}'`
  - `node scripts/mcp-tool-call.mjs airkvm_list_tabs '{"request_id":"tabs-1"}'`
  - `AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_tab '{"request_id":"shot-tab-1","max_width":1280,"max_height":720,"quality":0.6}'`
  - `AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_desktop '{"request_id":"shot-desktop-1","max_width":1280,"max_height":720,"quality":0.6,"desktop_delay_ms":800}'`

## Runtime Env Vars
- `AIRKVM_SERIAL_PORT`
- `AIRKVM_SERIAL_BAUD`
- `AIRKVM_SERIAL_TIMEOUT_MS`
- `AIRKVM_UART_DEBUG=1`
- `AIRKVM_TOOL_TIMEOUT_MS`
- `AIRKVM_SAVE_SCREENSHOTS=1`

## Protocol Quick Reference
- BLE service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
- BLE RX char: `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
- BLE TX char: `6E400103-B5A3-F393-E0A9-E50E24DCCB01`
- Active screenshot path: AK frame chunking with ack (`0x04`) frames for flow control.

## Human Reviews
- The AK frame header needs a "target" concept
  - HID vs Extension
  - Could just use a bit on the kind?

### MCP
- [x] index.js
- [x] protocol.js
- [ ] uart.js -- currently in bad shape

### Shared
- [x] screenshot_contract.js