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
- Routes AK binary frames bidirectionally between BLE and UART (dumb pipe / bridge).
- Emits UART framed packets (`AK` framing): chunk (`0x01`), control (`0x02`), log (`0x03`).
- Generates ack (`0x04`) frames back to extension after forwarding binary chunks to UART.
- Never buffers more than one chunk — firmware backpressure is flow control.
- BLE HID (HOGP) always enabled, coexists with UART service. BLE security (authenticated pairing) always on.

### 2. MCP Server (`mcp/`)

- Exposes tools: `airkvm_send`, `airkvm_list_tabs`, `airkvm_open_tab`,
  `airkvm_dom_snapshot`, `airkvm_exec_js_tab`, `airkvm_screenshot_tab`,
  `airkvm_screenshot_desktop`.
- Validates and forwards control commands to firmware via UART.
- Parses mixed UART framed stream (control / log / binary).
- **Half-pipe transport** (HalfPipe class): unified `send(obj)`/`onMessage(cb)` API for all message types, with automatic chunking via AK frame v2 binary frames.
- Drives reset (`0x06`) as universal recovery mechanism.

### 3. Extension (`extension/`)

- `service_worker.js`: handles browser automation (tabs, DOM, js.exec, screenshots).
- **Half-pipe transport** (HalfPipe class): sends screenshots and DOM snapshots, receives commands (js.exec) — all via AK frame v2 binary chunks with `send(obj)`/`onMessage(cb)` API.
- `ble_bridge.html` + `ble_bridge.js`: BLE runtime context (Web Bluetooth).
- `bridge.js`: BLE transport helper with `bleWrite()` for write-with-fallback and telemetry.

## Half-Pipe Transport Layer

Two independent half-pipes with firmware bridging between them:

```
MCP app code                                    Extension app code
    │  send(obj)                                   │  onMessage(obj)
    ▼                                               ▲
┌──────────────┐                               ┌──────────────┐
│  Half-Pipe   │  (MCP side)                   │  Half-Pipe   │  (Extension side)
│  chunk/ack   │                               │  reassemble  │
└──────┬───────┘                               └──────▲───────┘
       │ UART                                         │ BLE
┌──────▼──────────────────────────────────────────────┴───────┐
│                        Firmware                              │
│   Ext→MCP: binary chunk on BLE → forward to UART → ack BLE  │
│   MCP→Ext: AK frame on UART → forward to BLE                │
└──────────────────────────────────────────────────────────────┘
```

- App code never thinks about chunking or payload size.
- One chunk in flight at a time. Firmware backpressure is the flow control.
- Small payloads bypass chunking entirely (inline JSON fast path).
- 3 binary control frame types: ack (`0x04`), nack (`0x05`), reset (`0x06`). No JSON in stream protocol.

## Data Paths

1. **DOM / tab list / simple commands**: MCP → UART → firmware pass-through → BLE → extension → browser API → response back through same path as inline JSON.

2. **Screenshot / DOM snapshot** (large, Extension → MCP): Extension half-pipe chunks as AK frame v2 binary → BLE → firmware acks + forwards to UART → MCP half-pipe reassembles.

3. **js.exec** (small script): MCP sends inline control frame → firmware → extension executes → result back via half-pipe.

4. **js.exec** (large script): MCP half-pipe sends AK frame v2 binary chunks → UART → firmware pass-through → BLE → Extension half-pipe reassembles → executes → result back via half-pipe.

## Design Constraints

- Single deterministic UART writer path on ESP32 via TX queue/task.
- Cross-platform protocol — no host-specific shell tools in the data path.
- Extension logging defaults to low-noise; verbose mode opt-in in bridge UI.
- MCP UART debug logging gated by `AIRKVM_UART_DEBUG=1` env var.
