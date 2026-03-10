# Architecture (Current)

## Deployment Topology

- Controller/host machine:
  - Runs MCP server (`mcp/`) over STDIO JSON-RPC.
  - Connects to firmware over UART serial.
- Target machine:
  - Runs browser extension (`extension/`) only.
  - Talks to firmware over BLE (Web Bluetooth bridge page).
- Extension does not connect to MCP directly.

## Layer Responsibilities

1. Firmware (`firmware/`, ESP32)
- Owns BLE GATT UART service (`6E400101-...`).
- Routes command lines between BLE and UART.
- Emits UART framed packets (`AK` framing):
  - transfer binary (`type=0x01`)
  - control JSON (`type=0x02`)
  - log text (`type=0x03`)
- Sends BLE control notifications directly.
- HID support exists in code, but default build has `AIRKVM_ENABLE_HID=0`.

2. MCP Server (`mcp/`)
- Exposes tools:
  - `airkvm_send`
  - `airkvm_list_tabs`
  - `airkvm_open_tab`
  - `airkvm_dom_snapshot`
  - `airkvm_exec_js_tab`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`
- Validates and forwards control commands to firmware.
- Parses mixed UART framed stream (control/log/bin).
- Reassembles screenshot binary transfers and returns base64 payloads.
- Drives transfer flow control (`transfer.ack`, `transfer.nack`, `transfer.resume`, `transfer.done.ack`).

3. Extension (`extension/`)
- `service_worker.js` handles browser automation actions:
  - `tabs.list.request`
  - `tab.open.request`
  - `dom.snapshot.request`
  - `js.exec.request`
  - `screenshot.request` (tab/desktop)
- `ble_bridge.html` + `ble_bridge.js` is the primary BLE runtime context.
  - Connects via Web Bluetooth.
  - Forwards control and binary data between service worker and firmware.
- `bridge.js` is BLE transport helper (write/read/notify and parsing).

## Data Paths

1. DOM / tab list
- MCP tool call -> UART command -> firmware passthrough -> BLE -> extension service worker -> browser API -> response back through same path.

2. Screenshot
- MCP sends `screenshot.request`.
- Extension captures + JPEG-compresses image.
- Extension sends `transfer.meta` then binary chunk frames.
- MCP collector reconstructs image, handles ACK/NACK/resume, then sends `transfer.done.ack`.

## Design Constraints

- Single deterministic UART writer path on ESP32 via TX queue/task.
- Cross-platform behavior is implemented in Node/extension logic (no host-specific shell tools required for protocol flow).
- Extension logging defaults to low-noise mode; verbose mode is opt-in in bridge UI.
