# Protocol (Current, March 10, 2026)

## 1) Transport Overview

AirKVM uses two independent transport segments bridged by the firmware:

1. **MCP ↔ Firmware** over UART (wired)
   - Firmware emits framed binary packets (`AK` frames) for control, log, and binary chunk payloads.
   - MCP sends JSON text lines to UART; firmware reads and forwards to BLE.
   - For large MCP→Extension payloads (e.g. js.exec scripts), the stream layer
     sends `stream.data` JSON messages with base64-encoded chunks.

2. **Extension ↔ Firmware** over BLE UART-style GATT (wireless)
   - Control messages are JSON lines over BLE write/notify.
   - Large Extension→MCP payloads (screenshots, DOM snapshots) are sent as
     AK binary chunk frames through the stream layer.
   - Firmware acks binary chunks back to the extension after forwarding to UART.

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

## 5) Stream Layer

The stream layer provides transparent chunked transport for payloads that exceed
the firmware's buffer limits. App code calls `sender.send(obj)` / `receiver.onMessage(cb)`
without knowing about chunking.

### 5.1 Design Principles

- One chunk in flight per stream direction. Firmware backpressure is the flow control.
- Firmware acks the sender only after confirmed delivery to the other side.
- The firmware never buffers more than one chunk — can't overrun.
- Small payloads (≤ chunk threshold) bypass chunking entirely as inline JSON.

### 5.2 Stream Control Messages

| Message | Direction | Format |
|---------|-----------|--------|
| `stream.ack` | receiver → sender | `{ "type": "stream.ack", "transfer_id": "tx_XXXXXXXX", "seq": N }` |
| `stream.nack` | receiver → sender | `{ "type": "stream.nack", "transfer_id": "tx_XXXXXXXX", "seq": N, "reason": "..." }` |
| `stream.reset` | MCP → all | `{ "type": "stream.reset" }` — hard clear all stream state |
| `stream.data` | MCP → extension | `{ "type": "stream.data", "transfer_id": "tx_XXXXXXXX", "seq": N, "is_final": bool, "data_b64": "..." }` |

### 5.3 Binary Chunk Path (Extension → MCP)

Used for screenshots and DOM snapshots. Extension sends AK binary chunk frames
(`frame_type=0x01`) via BLE. Firmware forwards to UART and acks back to extension.
MCP StreamReceiver reassembles chunks and delivers the complete object.

- `is_final` encoded in high bit of seq field (bit 31): `0x80000000`
- `transfer_id`: random 4-byte tag to distinguish transfers
- Duplicate chunks are idempotent (re-ack, don't double-append)
- Timeout: 3s per chunk, 3 retries, then error to app

### 5.4 JSON Chunk Path (MCP → Extension)

Used for large js.exec scripts (>4KB). MCP StreamSender sends `stream.data` JSON
messages via UART. Firmware passes through as normal JSON. Extension StreamReceiver
reassembles from base64-decoded chunks.

- Chunk size: 384 bytes raw → ~512 bytes base64 → ~620 bytes total JSON (under UART buffer)
- Extension acks each chunk; firmware does not generate acks for JSON pass-through

### 5.5 Failure Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Chunk corrupted | CRC fails | nack → sender retransmits. If nack lost → timeout → retransmit |
| Chunk or ack lost | Sender timeout (3s) | Retransmit current chunk. Max 3 retries then error |
| BLE disconnect | Firmware detects | nack with `downstream_disconnected`. On reconnect, MCP retries |
| Extension SW killed | Chunks for unknown transfer_id | Ignored. MCP times out → `stream.reset` → fresh start |
| Firmware reboots | Both sides lose connection | On reconnect, MCP sends `stream.reset` |
| Permanent wedge | Retries exhausted | MCP sends `stream.reset` → all state cleared |

## 6) AK Binary Frame Format

Used for UART framed stream and BLE binary chunk payloads.

```
[magic0 1B: 0x41 'A'] [magic1 1B: 0x4B 'K'] [version 1B: 0x01]
[frame_type 1B] [transfer_id 4B LE] [seq 4B LE]
[payload_len 2B LE] [payload] [crc32 4B LE]
```

Frame types:
| Type | Value | Purpose |
|------|-------|---------|
| chunk | `0x01` | Data chunk payload |
| control | `0x02` | Inline JSON control message |
| log | `0x03` | Log text |

CRC scope: from `version` through end of `payload` (excludes magic and crc field).

Payload limits:
- MCP binary_frame.js: 4096 bytes (accommodates full UART line buffer)
- Extension binary_frame.js: 1024 bytes (stays within firmware's `kMaxBinaryFrameLen` of 1400 after header overhead)

Transfer ID encoding:
- Control plane: string `tx_<hex8>` (e.g. `tx_12ab34cd`)
- Binary frame: uint32 LE numeric value

## 7) MCP Tool Contract

Tools exposed by MCP:

| Tool | Sends | Response via |
|------|-------|-------------|
| `airkvm_send` | raw command | simple ack |
| `airkvm_list_tabs` | `tabs.list.request` | collector |
| `airkvm_open_tab` | `tab.open.request` | collector |
| `airkvm_dom_snapshot` | `dom.snapshot.request` | stream (streamRequest) |
| `airkvm_exec_js_tab` | `js.exec.request` | collector (inline) or streamSendCommand (large scripts) |
| `airkvm_screenshot_tab` | `screenshot.request` | stream (streamRequest) |
| `airkvm_screenshot_desktop` | `screenshot.request` | stream (streamRequest) |

## 8) HID Support

BLE HID (HOGP) is enabled by default (`AIRKVM_ENABLE_HID=1`). The firmware
advertises both the UART control service and HID service simultaneously.

Security mode defaults to 1 (BLE security with authentication). The
`esp32dev_hid_uart_compat` build environment disables security (mode 0) for
devices that don't support pairing.
