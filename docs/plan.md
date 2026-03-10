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
- Command router supports pass-through for `dom.snapshot`, `tabs.list`, `screenshot`, and `transfer.*` control messages.
- UART output is framed binary (`AK`) for control/log/binary payloads.
- Single deterministic UART TX writer path is enforced on ESP32 (queue + TX task).
- BLE RX queue remains the required BLE->UART serialization path; queue writes now use bounded wait and explicit overflow telemetry.
- HID code exists, but default app build uses `AIRKVM_ENABLE_HID=0`.

### MCP
- Structured tools exist and are live:
  - `airkvm_send`
  - `airkvm_list_tabs`
  - `airkvm_open_tab`
  - `airkvm_dom_snapshot`
  - `airkvm_exec_js_tab`
  - `airkvm_screenshot_tab`
  - `airkvm_screenshot_desktop`
- UART parser supports mixed framed stream (`ctrl`, `log`, `bin`, and `bin_error`).
- Screenshot/DOM/JS-exec collectors use a hand-wired transfer state machine with 10+ message types (`transfer.meta`, `transfer.done`, `transfer.ack`, `transfer.nack`, `transfer.resume`, `transfer.cancel`, `transfer.reset`, etc.).

### Extension
- BLE bridge page is the primary BLE runtime path.
- Service worker handles all browser automation commands and transfer session controls.
- Screenshot path includes capture timeout/stage timeout guards and JPEG downscale/compression logic.
- Default logging is low-noise; verbose mode is toggleable in bridge UI.

## Known Issues

1. **Silent truncation of large commands.** `kMaxBleControlBufferLen = 4096` in firmware drops any BLE control JSON exceeding 4KB. A `js.exec.request` with a long script (schema allows up to 12KB) hits this limit and is silently discarded.

2. **Transfer protocol complexity.** The current 10+ message transfer protocol pushes chunking/flow-control into the application layer, forcing every tool to manually wire up a session state machine. This is duplicated across three collectors in MCP and multiple handlers in the extension.

3. **Code duplication.** `sendCommand`/`waitForFrame` in `uart.js` share ~70% identical code. `postEvent`/`postBinary` in `bridge.js` are ~90% telemetry boilerplate. `binary_frame.js` exists in both MCP and extension with divergent max payload limits (4096 vs 1024) that are undocumented.

---

## Transport Stream Rearchitecture

### Problem

The truncation bug and transfer complexity are symptoms of the same root cause: large payloads shouldn't flow through the firmware's control buffer at all. The transfer protocol tries to solve this but does it at the wrong layer — app code manages sessions instead of a transparent stream layer.

### Design

Replace with a **transparent stream layer** below app code but above raw UART/BLE transport. Two independent streams with firmware bridging between them:

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
│   receive chunk on UART → forward on BLE → ack UART when    │
│   BLE delivery confirmed. (And reverse direction.)           │
└──────────────────────────────────────────────────────────────┘
```

**Key principles:**
- App code never thinks about chunking or payload size.
- One chunk in flight at a time per stream. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.

### Wire Protocol

#### Frame format

Reuse existing AK binary frame (no changes to `magic`, `version`, `crc` layout):

```
[AK magic 2B] [version 1B] [frame_type 1B] [transfer_id 4B LE] [seq 4B LE] [payload_len 2B LE] [payload] [crc32 4B LE]
```

#### Frame types

| Type | Value | Purpose |
|------|-------|---------|
| `chunk` | `0x01` | Data chunk (existing transfer chunk type) |
| `control` | `0x02` | Small inline JSON control message (existing, unchanged) |
| `log` | `0x03` | Log text (existing, unchanged) |

#### Chunk frame header additions

- **`is_final`**: 1 = last chunk of the transfer. Receiver knows reassembly is complete without a separate "done" message.
- **`transfer_id`**: random 4-byte tag. Distinguishes transfers so stale acks/chunks after reset are ignored.
- **`seq`**: 0-indexed chunk sequence number.

#### Control messages (streamlined)

Only 3 transport-level control messages remain:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `stream.ack` | receiver → sender (through firmware) | `{ type: "stream.ack", transfer_id, seq }` — confirms chunk received |
| `stream.nack` | receiver → sender (through firmware) | `{ type: "stream.nack", transfer_id, seq, reason }` — chunk corrupted or undeliverable |
| `stream.reset` | MCP → firmware (out-of-band) | `{ type: "stream.reset" }` — hard clear all stream state on all layers |

#### Messages removed

All of these go away:
- `transfer.meta` (first chunk implicitly starts a transfer)
- `transfer.done` / `transfer.done.ack` (`is_final` bit replaces this)
- `transfer.resume` (timeout + retransmit replaces this)
- `transfer.cancel` / `transfer.cancel.ok` (reset replaces this)

#### Small message fast path

Messages that fit within a single chunk (most control commands, tab lists, simple responses) are sent as `frame_type=0x02` (control JSON) — same as today, no chunking overhead. The stream layer only activates chunking when the serialized payload exceeds a threshold (e.g. 512 bytes, well under firmware's buffer limit).

### Failure Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| **Chunk corrupted** | Receiver CRC fails | nack(transfer_id, seq, "crc_mismatch") → sender retransmits. If nack lost → sender timeout → retransmit anyway. |
| **Chunk or ack lost** | Sender timeout (3s) | Retransmit current chunk. Receiver is idempotent on duplicate seq (re-ack, don't double-append). Max 3 retries then error to app. |
| **BLE disconnect mid-transfer** | Firmware `active_conn_count_ == 0` | Firmware nacks UART sender with `downstream_disconnected`. MCP surfaces error. On reconnect, MCP retries. |
| **Extension SW killed (MV3)** | Chunks arrive for unknown transfer_id | New SW ignores them. MCP times out → `stream.reset` → fresh start. transfer_id prevents stale/new confusion. |
| **Firmware reboots** | Both sides lose connection | On reconnect, MCP sends `stream.reset` before new work. |
| **Permanent wedge** | Retries exhausted | MCP sends `stream.reset` → all state cleared. Universal escape hatch, no handshake. |

### Implementation Phases

#### Phase 1 — Stream layer in MCP and extension ✅

Implemented: `mcp/src/stream.js`, `extension/src/stream.js` with full test coverage.

- `StreamSender`: serializes → chunks if >chunkSize → sends one chunk at a time → waits for ack → retries on timeout/nack (3 attempts, 3s) → rejects on failure
- `StreamReceiver`: single `_rx` variable (one transfer at a time) → reassembles → delivers parsed object
- `is_final` encoded in high bit of seq field (bit 31)
- Small messages (<= chunkSize) go inline as control frames, no chunking overhead
- Duplicate chunks during a transfer are idempotent (re-ack, don't double-append)
- `stream.reset` clears all state
- Extension variant uses `Uint8Array` + separate `writeJsonFn`/`writeBinaryFn`; MCP variant uses `Buffer` + single `writeFn`

#### Phase 2 — Firmware stream awareness

Firmware becomes minimally stream-aware:
- Recognizes chunk frames (already does via AK magic).
- When bridging UART→BLE: holds off acking UART until BLE write completes (or nack if BLE down).
- When bridging BLE→UART: emits chunk on UART, acks BLE immediately (UART is reliable/wired).
- On `stream.reset`: clears any pending bridge state.

No reassembly in firmware. No payload inspection. Just chunk-level gate.

#### Phase 3 — Migrate app code to stream layer

- MCP `tooling.js`: replace `createResponseCollector` state machines with `stream.send()` / `stream.onMessage()`.
- Extension `service_worker.js`: replace `pumpTransferSession`, all `handleTransfer*` functions, chunking logic in `sendDomSnapshot`/`sendScreenshot` with `stream.send()`.
- Remove `screenshotTransfers` Map, `inboundScriptTransfers` Map, all session lifecycle machinery.

#### Phase 4 — Cleanup

- Remove dead `transfer.*` types from `firmware/include/protocol.hpp`, `firmware/src/protocol.cpp`, `command_router.cpp`, `mcp/src/protocol.js`.
- Update `docs/protocol.md` and `docs/architecture.md`.
- Deduplicate `sendCommand`/`waitForFrame` in `uart.js`.
- Extract `bleWriteBytes` helper in `bridge.js`.
- Document `binary_frame.js` payload limit divergence (extension 1024 vs MCP 4096).

#### Phase dependencies

```
Phase 1 (stream.js both sides) ─┐
                                 ├─► Phase 3 (migrate app code) ──► Phase 4 (cleanup)
Phase 2 (firmware awareness) ───┘
```

---

## Other Remaining Work

1. **HID path** is not the primary validated mode. Needs dedicated validation if HID milestones are re-prioritized.

2. **`key.type` escaped-string handling** is still missing. Add explicit escape parsing for special characters and named special keys.

3. **Protocol-level observability** — keep tightening diagnostics for transfer stalls under real-world BLE instability.

4. **Documentation discipline** — any transport/protocol change must update `docs/protocol.md`, `docs/architecture.md`, and this file in the same PR.
