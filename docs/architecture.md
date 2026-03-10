# Architecture (Current, March 10, 2026)

## Deployment Topology

```
┌─────────────────────────────────┐        ┌─────────────────────────────────┐
│       Controller / Host         │        │          Target Machine         │
│                                 │        │                                 │
│  AI Agent  ←→  MCP Server       │  UART  │  Firmware (ESP32)              │
│              (mcp/)             │◄──────►│  BLE GATT bridge               │
│              STDIO JSON-RPC     │  wired │                                 │
│                                 │        │         BLE  │                  │
└─────────────────────────────────┘        │              ▼                  │
                                           │  Browser Extension (extension/) │
                                           │  Chrome/Edge MV3               │
                                           └─────────────────────────────────┘
```

- Controller runs MCP server over STDIO JSON-RPC, connects to firmware via UART.
- Target runs browser extension only. Talks to firmware over BLE (Web Bluetooth).
- Extension does NOT connect to MCP or localhost — firmware bridges everything.

## Layer Responsibilities

### 1. Firmware (`firmware/`, ESP32)

- Owns BLE GATT UART service (`6E400101-...`).
- Routes command lines between BLE and UART (dumb pipe / bridge).
- Emits UART framed packets (`AK` framing): chunk (`0x01`), control (`0x02`), log (`0x03`).
- Generates `stream.ack` back to extension after forwarding binary chunks to UART.
- Never buffers more than one chunk — firmware backpressure is flow control.
- BLE HID (HOGP) enabled by default (`AIRKVM_ENABLE_HID=1`), coexists with UART service.

### 2. MCP Server (`mcp/`)

- Exposes tools: `airkvm_send`, `airkvm_list_tabs`, `airkvm_open_tab`,
  `airkvm_dom_snapshot`, `airkvm_exec_js_tab`, `airkvm_screenshot_tab`,
  `airkvm_screenshot_desktop`.
- Validates and forwards control commands to firmware via UART.
- Parses mixed UART framed stream (control / log / binary).
- **StreamReceiver**: reassembles chunked binary responses (screenshots, DOM) from extension.
- **StreamSender** (JSON-only mode): sends large js.exec scripts as `stream.data` chunks.
- Drives `stream.reset` as universal recovery mechanism.

### 3. Extension (`extension/`)

- `service_worker.js`: handles browser automation (tabs, DOM, js.exec, screenshots).
- **StreamSender**: sends screenshots and DOM snapshots as AK binary chunk frames.
- **StreamReceiver**: receives large commands (js.exec) via `stream.data` JSON chunks.
- `ble_bridge.html` + `ble_bridge.js`: BLE runtime context (Web Bluetooth).
- `bridge.js`: BLE transport helper with `bleWrite()` for write-with-fallback and telemetry.

## Stream Layer

Two independent streams with firmware bridging between them:

```
MCP app code                                    Extension app code
    │  stream.send(obj)                             │  stream.onMessage(obj)
    ▼                                               ▲
┌──────────────┐                               ┌──────────────┐
│ Stream Layer │  (MCP side)                   │ Stream Layer │  (Extension side)
│  chunk/ack   │                               │  reassemble  │
└──────┬───────┘                               └──────▲───────┘
       │ UART                                         │ BLE
┌──────▼──────────────────────────────────────────────┴───────┐
│                        Firmware                              │
│   Ext→MCP: binary chunk on BLE → forward to UART → ack BLE  │
│   MCP→Ext: JSON on UART → forward to BLE (pass-through)     │
└──────────────────────────────────────────────────────────────┘
```

- App code never thinks about chunking or payload size.
- One chunk in flight at a time. Firmware backpressure is the flow control.
- Small payloads bypass chunking entirely (inline JSON fast path).
- 3 control messages: `stream.ack`, `stream.nack`, `stream.reset`.
- JSON chunking via `stream.data` for MCP→Extension (text-only UART).

## Data Paths

1. **DOM / tab list / simple commands**: MCP → UART → firmware pass-through → BLE → extension → browser API → response back through same path as inline JSON.

2. **Screenshot / DOM snapshot** (large, Extension → MCP): Extension StreamSender chunks as AK binary frames → BLE → firmware acks + forwards to UART → MCP StreamReceiver reassembles.

3. **js.exec** (small script ≤4KB): MCP sends inline JSON → firmware → extension executes → result back as inline JSON.

4. **js.exec** (large script >4KB): MCP StreamSender sends `stream.data` JSON chunks → UART → firmware pass-through → BLE → Extension StreamReceiver reassembles → executes → result back as inline JSON.

## Design Constraints

- Single deterministic UART writer path on ESP32 via TX queue/task.
- Cross-platform protocol — no host-specific shell tools in the data path.
- Extension logging defaults to low-noise; verbose mode opt-in in bridge UI.
- MCP UART debug logging gated by `AIRKVM_UART_DEBUG=1` env var.
