# AirKVM Plan And Status (March 10, 2026)

## Goal

Maintain a reliable remote-control and browser-automation stack where:
- MCP tools can request DOM, tab list, tab screenshots, and desktop screenshots.
- MCP tools can open new browser tabs on the target extension machine.
- Payload transfers are reliable regardless of size, with firmware backpressure as the flow control.
- Firmware/extension/MCP protocol behavior is stable and documented.

## Current State (Implemented)

### Firmware
- BLE UART-style GATT service is active (`6E400101-...`) with device name `air-kvm-ctrl-cb01`.
- Command router supports pass-through for `dom.snapshot`, `tabs.list`, `screenshot`, and `stream.*` control messages.
- UART output is framed binary (`AK`) for control/log/binary payloads.
- Single deterministic UART TX writer path is enforced on ESP32 (queue + TX task).
- BLE RX queue remains the required BLE->UART serialization path.
- Stream ack generation: after forwarding binary chunk to UART, firmware sends `stream.ack` back on BLE.
- HID enabled by default (`AIRKVM_ENABLE_HID=1`) with security mode 1.
- `key.type` supports escape sequences: `\n`, `\t`, `\\`, `{Enter}`, `{Tab}`, `{Escape}`, `{Backspace}`, `{Delete}`, `{Up/Down/Left/Right}`.
- All legacy `transfer.*` command types removed from protocol/parser/router.

### MCP
- Structured tools: `airkvm_send`, `airkvm_list_tabs`, `airkvm_open_tab`, `airkvm_dom_snapshot`, `airkvm_exec_js_tab`, `airkvm_screenshot_tab`, `airkvm_screenshot_desktop`.
- UART parser supports mixed framed stream (`ctrl`, `log`, `bin`, and `bin_error`).
- `streamRequest()`: receives chunked binary responses (screenshots, DOM) via StreamReceiver.
- `streamSendCommand()`: sends large js.exec scripts as JSON-based `stream.data` chunks via StreamSender.
- `_collectFrames()`: shared frame-collection loop used by all transport methods (deduped from sendCommand/waitForFrame).
- Stream observability: UART debug logging for stream start/complete/error/timeout events.
- Old dom_snapshot and binary_screenshot collectors removed — stream path is now required.

### Extension
- BLE bridge page is the primary BLE runtime path.
- Service worker handles all browser automation commands.
- StreamSender: sends screenshots and DOM snapshots as AK binary chunk frames.
- StreamReceiver: receives large js.exec commands via `stream.data` JSON chunks dispatched through normal handler system.
- `stream.ack/nack/reset/data` handlers in `kBleCommandHandlers`.
- `bleWrite()` helper consolidates postEvent/postBinary telemetry boilerplate.
- All legacy inbound transfer code removed (inboundScriptTransfers, transfer.meta/chunk/done handlers).

## Known Issues

1. **Firmware Phase 2 not build-verified.** Stream ack generation and transfer type removal not yet compiled on ESP32 (no C++ toolchain available on Windows).

2. **Binary frame payload divergence.** MCP allows 4096-byte payloads; extension caps at 1024. Both are now documented in source.

---

## Transport Stream Architecture

### Design

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

**Key principles:**
- App code never thinks about chunking or payload size.
- One chunk in flight at a time per stream. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.
- Two chunking modes: binary (extension→MCP) and JSON/base64 (MCP→extension).

### Wire Protocol

See `docs/protocol.md` for full specification.

### Implementation Phases — All Complete ✅

#### Phase 1 — Stream layer in MCP and extension ✅
#### Phase 2 — Firmware stream awareness ✅
#### Phase 3 — Migrate all app code to stream layer ✅

- DOM snapshot and screenshot via StreamSender/StreamReceiver (binary chunks)
- js.exec script upload via StreamSender JSON-only mode (`stream.data` chunks)

#### Phase 4 — Full cleanup ✅

- Removed all legacy transfer code from extension (~500 lines total)
- Removed all `transfer.*` types from firmware protocol/parser/router
- Removed old MCP collectors for dom_snapshot/screenshot (~590 lines)
- Deduplicated sendCommand/waitForFrame into `_collectFrames()`
- Extracted `bleWrite()` helper in bridge.js
- Documented binary_frame.js payload divergence
- Updated `docs/protocol.md` and `docs/architecture.md`

---

## Other Completed Work

- **HID enabled by default** — `AIRKVM_ENABLE_HID=1` in firmware with security mode 1.
- **key.type escape handling** — firmware HID controller parses `\n`, `\t`, `\\`, and `{Name}` sequences.
- **Protocol observability** — stream-specific UART debug logging for all stream operations.

## Remaining Work

1. **Build-verify firmware on ESP32** — Phase 2 stream changes and transfer removal need compilation test.
2. **Documentation discipline** — any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in the same PR.
