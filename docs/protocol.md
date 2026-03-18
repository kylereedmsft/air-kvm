# Protocol (Current, March 14, 2026)

## 1) Transport Overview

All communication between MCP, firmware, and the extension uses AK binary frames
over two transport segments bridged by the firmware:

1. **MCP ↔ Firmware** over UART (wired)
2. **Extension ↔ Firmware** over BLE UART-style GATT (wireless)

**The only send path is HalfPipe.** No code writes raw frames to hardware directly.
MCP and the extension each hold a `HalfPipe` instance.

Every frame carries a **routing target** in the upper 3 bits of the type byte (see §6.1).
Firmware uses this to decide whether to handle the frame locally or forward it.

- **`target=FW` or `target=HID` + CONTROL frame** → firmware handles locally
  (`state.request`, `fw.version.request`, mouse/keyboard commands, etc.)
- **CHUNK frames** → forwarded to the other transport segment unchanged
  (firmware does not reassemble CHUNKs — insufficient RAM; CHUNK payloads are opaque to firmware)
- **Everything else** → forwarded to the other transport segment unchanged

## 2) BLE GATT Profile

- Service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
- RX characteristic (extension writes): `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
  - properties: `write`, `writeWithoutResponse`
- TX characteristic (firmware notifies): `6E400103-B5A3-F393-E0A9-E50E24DCCB01`
  - properties: `notify`, `read`

Device name: `air-kvm-ctrl-cb01`

## 3) Core Control Commands

```json
{"type":"mouse.move_rel","dx":10,"dy":-4}
{"type":"mouse.move_abs","x":1200,"y":340}
{"type":"mouse.click","button":"left"}
{"type":"key.tap","key":"Enter"}
{"type":"key.type","text":"hello\\n{Enter}"}
{"type":"state.request"}
{"type":"state.set","busy":true}
{"type":"fw.version.request"}
{"type":"dom.snapshot.request","request_id":"req-1"}
{"type":"tabs.list.request","request_id":"req-2"}
{"type":"tab.open.request","request_id":"req-open-1","url":"https://example.com","active":true}
{"type":"js.exec.request","request_id":"req-js-1","script":"return document.title;","timeout_ms":500,"max_result_chars":256}
{"type":"screenshot.request","source":"tab","request_id":"req-3","encoding":"bin"}
{"type":"screenshot.request","source":"desktop","request_id":"req-4","encoding":"bin","desktop_delay_ms":800}
```

### key.type escape sequences

The `text` field supports escape sequences parsed by the firmware HID controller:

| Escape | Key |
|--------|-----|
| `\n` | Enter |
| `\t` | Tab |
| `\\` | Literal backslash |
| `{Enter}` | Enter |
| `{Tab}` | Tab |
| `{Escape}` / `{Esc}` | Escape |
| `{Backspace}` | Backspace |
| `{Delete}` | Delete |
| `{Space}` | Space |
| `{Up}` / `{ArrowUp}` | Arrow Up |
| `{Down}` / `{ArrowDown}` | Arrow Down |
| `{Left}` / `{ArrowLeft}` | Arrow Left |
| `{Right}` / `{ArrowRight}` | Arrow Right |

Unknown escape sequences and named keys are sent literally.

## 4) Core Control Responses

```json
{"type":"state","busy":false}
{"type":"fw.version","version":"dev","built_at":"..."}
{"type":"dom.snapshot","request_id":"req-1","summary":{...}}
{"type":"dom.snapshot.error","request_id":"req-1","error":"..."}
{"type":"tabs.list","request_id":"req-2","tabs":[...]}
{"type":"tabs.list.error","request_id":"req-2","error":"..."}
{"type":"tab.open","request_id":"req-open-1","tab":{...},"ts":1741320000000}
{"type":"tab.open.error","request_id":"req-open-1","error":"tabs_create_failed","ts":1741320000001}
{"type":"js.exec.result","request_id":"req-js-1","tab_id":123,"duration_ms":11,"value_type":"string","value_json":"\"Example\"","truncated":false,"ts":...}
{"type":"js.exec.error","request_id":"req-js-1","tab_id":123,"error_code":"js_exec_runtime_error","error":"...","ts":...}
{"type":"screenshot.error","request_id":"req-3","source":"tab","error":"..."}
{"ok":true}
{"ok":false,"error":"..."}
```

## 5) Half-Pipe Transport Layer

The half-pipe transport provides transparent chunked transport for all messages crossing
the firmware bridge. App code calls `send(obj)` / `onMessage(cb)` without knowing
about chunking, acking, or transport details.

### 5.1 Design Principles

- **Single send path.** All messages go through `HalfPipe`. No code writes raw
  frames to hardware.
- **Two send methods, separated by purpose.** `send(obj, target)` sends CHUNK
  frames (ACK-gated, any size). `sendControl(obj, target)` sends a single CONTROL
  frame (no ACK, ≤255 bytes JSON). The choice of method is orthogonal to the
  routing target.
- **Routing target.** Every frame carries a target in the type byte's upper 3 bits.
  Firmware routes on this field; HalfPipe just encodes it.
- **Serialized TX queue.** Concurrent `send()`/`sendControl()` calls are chained
  on a promise queue — one at a time, never interleaved.
- **No flooding.** One chunk in flight, wait for ack before sending next.
  Firmware never sees more than one chunk.
- **Failure handling.** `send()` rejects on timeout, reset, or cancel. The
  transport clears its state so the next send can proceed. No wedged pipe.
- **Firmware is a dumb bridge.** Forwards AK frames between UART and BLE.
  Rejects oversized payloads with an error.

### 5.2 Half-Pipe Architecture

```
MCP App                                Extension App
  │ send(obj, target)                    │ send(obj, target)
  │ sendControl(obj, target)             │ sendControl(obj, target)
  │ onMessage(cb) / onControl(cb)        │ onMessage(cb) / onControl(cb)
  │ feedBytes(bytes)                     │ feedBytes(bytes)
  ▼                                      ▼
┌──────────────┐                    ┌──────────────┐
│  MCP Stream  │                    │  Ext Stream  │
│  (half-pipe) │                    │  (half-pipe) │
└──────┬───────┘                    └──────┬───────┘
       │ UART                              │ BLE
       └────────────┐      ┌───────────────┘
                 ┌──▼──────▼──┐
                 │  Firmware   │
                 │  (bridge)   │
                 └─────────────┘
```

`feedBytes(bytes)` replaces duplicated stream-parsing loops — callers pass raw
bytes from their transport; HalfPipe owns all frame boundary detection.

All chunks use AK binary frame format (see §6). No JSON `stream.data` envelopes,
no base64 encoding overhead.

### 5.3 Stream Control

All stream control is binary AK frames — no JSON in the stream protocol.

| Frame type | Direction | Purpose |
|------------|-----------|---------|
| `0x04` ack | receiver → sender | Chunk received. transfer_id + seq in header identify what's acked. |
| `0x05` nack | receiver → sender | Chunk rejected. Same header fields. |
| `0x06` reset | either → all | Hard clear all stream state on both sides. |

Ack/nack/reset frames have zero payload (`len=0`). The AK header carries all
the routing info. Firmware forwards these like any other frame — no parsing needed.

### 5.3.1 Reset Guarantees

Reset (`0x06`) is the escape hatch. It MUST always get through, regardless of
firmware state. Firmware requirements:

1. **Always accept reset** — even mid-transfer, even if buffers are full, even
   if BLE is disconnected. Never drop or ignore a reset frame.
2. **Never queue behind data** — if chunks are pending in the TX queue, reset
   jumps ahead or flushes the queue first.
3. **Bidirectional** — UART reset clears local state and forwards to BLE (if
   connected). BLE reset clears local state and forwards to UART.
4. **Idempotent** — multiple resets in a row are harmless.

This must be tested explicitly: verify reset is handled when firmware is idle,
mid-transfer, with full TX queue, and with BLE disconnected.

### 5.4 Chunked Transfer Flow

1. Sender serializes `obj` to JSON bytes.
2. If bytes fit in one chunk (≤ 255): send single AK frame with `len < 255`.
3. If bytes exceed 255: split into 255-byte chunks, send sequentially.
   - Each chunk waits for ack (`0x04`) before sending next.
   - Last chunk has `len < 255` (or `len == 0` terminator if exact multiple of 255).
4. Receiver reassembles chunks in seq order, parses JSON, delivers via `onMessage`.

### 5.5 Failure Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Chunk lost or corrupted | Sender timeout (3s) | Retransmit. Max 3 retries then reject |
| BLE disconnect | Firmware detects | nack. On reconnect, retry |
| Extension killed | Acks stop arriving | Sender timeout → reset (`0x06`) → fresh start |
| Firmware reboots | Connection lost | On reconnect, reset (`0x06`) |
| Permanent wedge | Retries exhausted | reset (`0x06`) → clear state → reject send |

## 6) AK Binary Frame Format

### 6.1 Frame

All transport segments (UART and BLE) use the same binary frame format.

```
Offset  Size  Field
  0     2B    Magic (0x41 0x4B = "AK")
  2     1B    Type byte  [ T T T | F F F F F ]
                           target   frame type
  3     2B    Transfer ID (LE) — random tag per transfer
  5     2B    Seq (LE) — chunk sequence number, starts at 0
  7     1B    Len — payload byte count (0–255)
  8     0-255B  Payload
  8+Len 4B    CRC32 (LE)
```

**12 bytes overhead. Max frame size: 267 bytes.**

#### Type byte encoding

The type byte encodes two orthogonal fields:

- **Upper 3 bits (target):** routing destination
- **Lower 5 bits (frame type):** payload shape

| Target name | Value | Description |
|-------------|-------|-------------|
| `MCP`       | `1`   | Route to MCP |
| `FW`        | `2`   | Handle locally in firmware |
| `EXTENSION` | `3`   | Route to browser extension |
| `HID`       | `4`   | Handle by HID subsystem in firmware |

Any other value (including `0`) is invalid and will be NACKed.

Frame types (lower 5 bits):

| Type | Value | Payload | Purpose |
|------|-------|---------|---------|
| chunk | `0x01` | 0–255 bytes | Stream data chunk |
| control | `0x02` | JSON text, single frame only (≤255 bytes) | App-layer control message |
| log | `0x03` | text | Diagnostic log (firmware → host only) |
| ack | `0x04` | none | Chunk acknowledged (transfer_id + seq in header) |
| nack | `0x05` | none | Chunk rejected (transfer_id + seq in header) |
| reset | `0x06` | none | Hard clear all stream state |

**CONTROL frames are single-frame only.** The JSON payload must fit in ≤255 bytes.
There is no multi-frame reassembly for CONTROL; recipients process each frame as a
complete, self-contained message. Use CHUNK frames for larger payloads.

CRC scope: bytes 2 through end of payload (type + transfer_id + seq + len + payload).
Excludes magic and CRC field itself.

### 6.2 End-of-transfer signaling

The `len` field doubles as the end-of-transfer indicator:

- `len < 255` → this is the **final chunk** of the transfer
- `len == 255` → more chunks expected
- If the total payload is an exact multiple of 255 bytes, the sender appends a
  **zero-length terminator** frame (`len == 0`) to signal completion

No separate "final" bit flag is needed.

### 6.3 Transfer limits

| Limit | Value | Derivation |
|-------|-------|------------|
| Max payload per chunk | 255 bytes | 1-byte len field |
| Max chunks per transfer | 65,535 | 2-byte seq field |
| Max transfer size | ~16 MB | 255 × 65,535 |
| Max frame on wire | 267 bytes | 12 + 255 |

### 6.4 Transfer ID

2-byte LE unsigned integer in the frame header. Random value per transfer.
No string encoding — binary everywhere.

### 6.5 Frame v1 (historical)

v1 frames are no longer used and all v1 code has been removed.

## 7) MCP Tool Contract

All tools send through `HalfPipe`. The `target` field on each tool definition
determines the routing target and which HalfPipe method is used.

- `target=fw` or `target=hid` → `halfpipe.sendControl()` (CONTROL frame, firmware handles locally)
- `target=extension` → `halfpipe.send()` (CHUNK frames, forwarded to extension over BLE)

| Tool | Sends | Target | Frame type |
|------|-------|--------|-----------|
| `airkvm_send` | raw command passthrough | `fw` | CONTROL |
| `airkvm_mouse_move_rel` | `mouse.move_rel` | `hid` | CONTROL |
| `airkvm_mouse_move_abs` | `mouse.move_abs` | `hid` | CONTROL |
| `airkvm_mouse_scroll` | `mouse.scroll` | `hid` | CONTROL |
| `airkvm_mouse_click` | `mouse.click` | `hid` | CONTROL |
| `airkvm_key_tap` | `key.tap` | `hid` | CONTROL |
| `airkvm_key_type` | `key.type` | `hid` | CONTROL |
| `airkvm_state_request` | `state.request` | `fw` | CONTROL |
| `airkvm_state_set` | `state.set` | `fw` | CONTROL |
| `airkvm_fw_version_request` | `fw.version.request` | `fw` | CONTROL |
| `airkvm_transfer_reset` | reset | `fw` | RESET |
| `airkvm_list_tabs` | `tabs.list.request` | `extension` | CHUNK |
| `airkvm_window_bounds` | `window.bounds.request` | `extension` | CHUNK |
| `airkvm_open_tab` | `tab.open.request` | `extension` | CHUNK |
| `airkvm_dom_snapshot` | `dom.snapshot.request` | `extension` | CHUNK |
| `airkvm_accessibility_snapshot` | `ax.snapshot.request` | `extension` | CHUNK |
| `airkvm_exec_js_tab` | `js.exec.request` | `extension` | CHUNK |
| `airkvm_inject_js_tab` | `js.inject.request` | `extension` | CHUNK |
| `airkvm_screenshot_tab` | `screenshot.request` | `extension` | CHUNK |
| `airkvm_screenshot_desktop` | `screenshot.request` | `extension` | CHUNK |

Notes:
- `mouse.move_abs` / `airkvm_mouse_move_abs` use HID logical coordinates in the 15-bit unsigned range `0..32767`. They are not screen pixels.
- `mouse.scroll` / `airkvm_mouse_scroll` currently expose vertical wheel scrolling only. Negative `dy` scrolls down; positive `dy` scrolls up.
- `airkvm_accessibility_snapshot` is the CDP-backed structured accessibility read path and returns filtered nodes with roles, names, and rects.
- `airkvm_exec_js_tab` is the CDP-backed path and may trigger debugger UI.
- `airkvm_inject_js_tab` is the silent extension scripting path for deterministic DOM setup/readback.

## 8) HID Support

BLE HID (HOGP) is always enabled. The firmware advertises both the UART control
service and HID service simultaneously. BLE security (authenticated pairing) is
always on.

For absolute mouse injection:
- `mouse.move_abs` uses HID logical units, not CSS pixels or desktop pixels
- the current absolute report exposes a `0..32767` range on both axes
- callers must map browser/screen coordinates into that logical HID range themselves
