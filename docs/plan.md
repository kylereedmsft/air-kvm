# AirKVM Plan And Status (March 12, 2026)

## Goal

Maintain a reliable remote-control and browser-automation stack where:
- MCP tools can request DOM, tab list, tab screenshots, and desktop screenshots.
- MCP tools can open new browser tabs on the target extension machine.
- Payload transfers are reliable regardless of size, with firmware backpressure as the flow control.
- Firmware/extension/MCP protocol behavior is stable and documented.

## Current State (Implemented)

### Firmware
- BLE UART-style GATT service is active (`6E400101-...`) with device name `air-kvm-ctrl-cb01`.
- Command router supports pass-through for `dom.snapshot`, `tabs.list`, `screenshot`, and AK frame forwarding.
- UART output is framed binary (`AK`) for control/log/binary payloads.
- Single deterministic UART TX writer path is enforced on ESP32 (queue + TX task).
- BLE RX queue remains the required BLE->UART serialization path.
- Stream ack generation: after forwarding binary chunk to UART, firmware sends ack (`0x04`) frame back on BLE.
- `key.type` supports escape sequences: `\n`, `\t`, `\\`, `{Enter}`, `{Tab}`, `{Escape}`, `{Backspace}`, `{Delete}`, `{Up/Down/Left/Right}`.
- All legacy `transfer.*` command types removed from protocol/parser/router.

### MCP
- Structured tools: `airkvm_send`, `airkvm_list_tabs`, `airkvm_open_tab`, `airkvm_dom_snapshot`, `airkvm_exec_js_tab`, `airkvm_inject_js_tab`, `airkvm_screenshot_tab`, `airkvm_screenshot_desktop`.
- UART parser supports mixed framed stream (`ctrl`, `log`, `bin`, and `bin_error`).
- `sendRequest()`: sends commands and receives responses via HalfPipe transport (AK frame binary chunking).
- `sendControlCommand()`: sends HID/firmware-local commands as CONTROL frames (type `0x02`) directly to UART — not via HalfPipe.
- Stream observability: UART debug logging for stream start/complete/error/timeout events.
- Old dom_snapshot and binary_screenshot collectors removed — stream path is now required.

### Extension
- BLE bridge page is the primary BLE runtime path.
- Service worker handles all browser automation commands.
- Half-pipe transport (HalfPipe class): sends screenshots and DOM snapshots, receives commands — all via AK frame binary chunks with `send(obj)`/`onMessage(cb)` API.
- Binary AK frame routing via `halfpipe.onFrame()` for ack/nack/reset handling.
- `bleWrite()` helper consolidates postEvent/postBinary telemetry boilerplate.
- All legacy inbound transfer code removed (inboundScriptTransfers, old transfer handlers).
- `airkvm_exec_js_tab` remains the CDP-backed path for arbitrary evaluation and diagnostics.
- `airkvm_inject_js_tab` is the silent `chrome.scripting.executeScript` path for UI-test setup/readback where debugger UI must not appear.

### HID E2E
- `scripts/e2e-hid.mjs` now passes end to end.
- The working path uses:
  - `airkvm_window_bounds` logical screen metrics
  - absolute HID (`mouse.move_abs`) via the digitizer-style report
  - `airkvm_inject_js_tab` for fixture inject, layout readback, and validation
- The old popup calibration tooling has been removed.

---

## Transport Stream Architecture

### Design

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

**Key principles:**
- Two independent half-pipes with firmware bridging between them:
- App code never thinks about chunking or payload size.
- One chunk in flight at a time per stream. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.
- Single binary AK frame chunking mode for all directions.

### Wire Protocol

See `docs/protocol.md` for full specification.

### Implementation Phases

#### Phase 1 — Stream layer in MCP and extension ✅
#### Phase 2 — Firmware stream awareness ✅
#### Phase 3 — Migrate dom/screenshot/large-js.exec to stream ✅

- DOM snapshot, screenshot, and js.exec all use half-pipe transport (AK frame binary chunks).
- All commands and responses go through half-pipe — no inline size thresholds.

#### Phase 4 — Legacy cleanup ✅

- Removed all legacy transfer code from extension (~500 lines total)
- Removed all `transfer.*` types from firmware protocol/parser/router
- Removed old MCP collectors for dom_snapshot/screenshot (~590 lines)
- Removed old `StreamSender`/`StreamReceiver`, v1 `binary_frame.js`, collector infrastructure
- Extracted `bleWrite()` helper in bridge.js
- Updated `docs/protocol.md` and `docs/architecture.md`

---

## Half-Pipe Transport Migration (March 11, 2026)

### Problem

The old transport had multiple code paths with per-tool routing and size thresholds. Payloads
exceeding BLE MTU silently broke. The stream protocol used expensive JSON for acks
and data envelopes. All of this has been replaced by the half-pipe design below.

### Design

See `docs/protocol.md` §5–§6 for full spec. Summary:

- **App API**: `send(obj)` / `onMessage(cb)`. App knows nothing about transport.
- **All frames are binary AK v2**: 12-byte header, max 255-byte payload, 267 bytes max.
- **Frame types**: chunk (`0x01`), control (`0x02`), log (`0x03`), ack (`0x04`),
  nack (`0x05`), reset (`0x06`). No JSON in stream protocol.
- **One stream at a time**. One chunk in flight. Ack-gated.
- **`send()` rejects** on timeout/reset/cancel, clears state for next send.
- **`len < 255`** signals final chunk. Exact multiples send `len=0` terminator.
- **Reset always gets through** — never queued behind data, works from any state.

### Phase 5 — AK frame codec ✅

Implemented `binary_frame.js` (shared for MCP/extension) with format:
- `encodeFrame(type, transferId, seq, payload)` → Uint8Array/Buffer
- `decodeFrame(bytes)` → `{type, transferId, seq, payload}` or null
- CRC32 encode/verify, all six frame types supported
- v1 codec removed

**Files**: `mcp/src/binary_frame.js`, `extension/src/binary_frame.js`

### Phase 6 — MCP half-pipe transport ✅

MCP-side HalfPipe implemented:
- `send(obj)` → JSON serialize → chunk into AK frames → write to UART →
  wait for ack per chunk → resolve when complete
- `onMessage(cb)` → receive AK frames → reassemble → parse JSON → deliver
- One-send-at-a-time, timeout rejection, reset clears state

**Files**: `mcp/src/halfpipe.js`, `mcp/src/uart.js`

### Phase 7 — MCP server uses half-pipe ✅

- All transport routing replaced with `transport.send(command)` + `transport.onMessage()` + `request_id` matching
- Removed `sendCommand`, `streamSendCommand`, `streamRequest`, `createResponseCollector`, `kJsExecInlineMaxBytes`
- Removed old `StreamSender`/`StreamReceiver` imports

**Files**: `mcp/src/server.js`

### Phase 8 — Extension half-pipe transport ✅

Extension-side HalfPipe implemented — same `send(obj)`/`onMessage(cb)` API:
- `send(obj)` → JSON serialize → chunk → AK frames → BLE bridge write → ack-gated → resolve
- `onMessage(cb)` → receive AK frames from BLE bridge → reassemble → deliver

**Files**: `extension/src/halfpipe.js`, `extension/src/bridge.js`

### Phase 9 — Extension service worker uses half-pipe ✅

- All command handlers use `transport.send()` / `transport.onMessage()` → dispatch to handlers
- Removed `postEventViaBridge`/`StreamSender`/`StreamReceiver`/`kBleCommandHandlers`
- Removed old `stream.ack/nack/reset/data` JSON handlers

**Files**: `extension/src/service_worker.js`

### Phase 10 — Firmware: AK bridge ✅

- UART reader: detect AK magic (`0x41 0x4B`) on serial input, switch to binary
  frame parsing (read by header length). Fall back to text line for non-AK input.
- Forward AK frames bidirectionally: UART→BLE, BLE→UART.
- All six frame types forwarded identically (firmware doesn't interpret payloads).
- BLE size guard: reject frames exceeding max notify size with nack.
- Reset priority: never queued behind data in TX queue.
- Remove old JSON-based `stream.ack/nack/reset` command types from parser.
- Remove old v1 binary frame handling.

**Files**: `firmware/src/transport_mux.cpp`, `firmware/src/app.cpp`,
`firmware/src/command_router.cpp`, `firmware/include/*.hpp`

**Validation**: `cd firmware && pio test -e native` — all pass. Test cases:
frame forwarding both directions, BLE size guard rejection, reset priority
(mid-transfer, full queue, BLE disconnected).

### Phase 11 — Cleanup + E2E ✅

- Update `docs/architecture.md` for any remaining stale references
- `cd mcp && node --test && cd ../extension && node --test` — all pass
- Smoke test with live hardware

---

## Other Completed Work

- **HID always enabled** — unconditional in firmware; `AIRKVM_ENABLE_HID` and `AIRKVM_HID_SECURITY_MODE` flags removed.
- **key.type escape handling** — firmware HID controller parses `\n`, `\t`, `\\`, and `{Name}` sequences.
- **Protocol observability** — stream-specific UART debug logging for all stream operations.
- **Extension dist build** — `npm run build` in `extension/` copies shared files into `extension/dist/` for Chrome loading; wired into CI.
- **Documentation discipline** — any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in the same PR.
