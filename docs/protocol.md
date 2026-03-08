# Protocol (Current, March 2026)

## Overview
- UART transport is a framed binary stream (single abstraction):
  - Transfer chunk frames (`frame_type=0x01`)
  - Control JSON frames (`frame_type=0x02`)
  - Log text frames (`frame_type=0x03`)
- BLE bridge remains command/event JSON for control, plus raw binary chunk writes for screenshot payload.

## Core Commands
```json
{"type":"mouse.move_rel","dx":10,"dy":-4}
{"type":"mouse.move_abs","x":1200,"y":340}
{"type":"mouse.click","button":"left"}
{"type":"key.tap","key":"Enter"}
{"type":"state.request"}
{"type":"state.set","busy":true}
{"type":"fw.version.request"}
{"type":"dom.snapshot.request","request_id":"req-1"}
{"type":"tabs.list.request","request_id":"req-2"}
{"type":"screenshot.request","source":"tab","request_id":"req-3","encoding":"bin"}
{"type":"screenshot.request","source":"desktop","request_id":"req-4","encoding":"bin"}
```

`screenshot.request` optional fields:
- `max_width` (int)
- `max_height` (int)
- `quality` (number)
- `max_chars` (int)
- `tab_id` (int, tab source only)
- `desktop_delay_ms` (int, desktop source; milliseconds to wait after permission before frame capture)
- `encoding` (`bin` only)

## Core Responses (payloads inside framed control/log packets)
```json
{"type":"state","busy":false}
{"type":"fw.version","version":"dev","built_at":"..."}
{"type":"dom.snapshot","request_id":"req-1","summary":{...}}
{"type":"tabs.list","request_id":"req-2","tabs":[...]}
{"type":"dom.snapshot.error","request_id":"req-1","error":"..."}
{"type":"tabs.list.error","request_id":"req-2","error":"..."}
{"ok":true}
```

## Screenshot Transfer Protocol (Binary-Only)

### JSON control plane
Extension starts transfer with:
```json
{"type":"transfer.meta","request_id":"req-3","transfer_id":"tx_12ab34cd","source":"tab","mime":"image/jpeg","encoding":"bin","chunk_size":160,"total_chunks":304,"total_bytes":27312,"total_chars":36416}
```

Extension ends transfer with:
```json
{"type":"transfer.done","request_id":"req-3","transfer_id":"tx_12ab34cd","source":"tab","total_chunks":304}
```

MCP control responses:
```json
{"type":"transfer.ack","request_id":"req-3","transfer_id":"tx_12ab34cd","highest_contiguous_seq":127}
{"type":"transfer.nack","request_id":"req-3","transfer_id":"tx_12ab34cd","seq":42,"reason":"crc_mismatch"}
{"type":"transfer.resume","request_id":"req-3","transfer_id":"tx_12ab34cd","from_seq":128}
{"type":"transfer.done.ack","request_id":"req-3","transfer_id":"tx_12ab34cd"}
{"type":"transfer.reset","request_id":"req-3"}
{"type":"transfer.error","request_id":"req-3","transfer_id":"tx_12ab34cd","code":"no_such_transfer"}
```

### UART framed packet format (firmware -> MCP)
Each UART packet is sent as:

- `magic0` (1 byte): `0x41` (`'A'`)
- `magic1` (1 byte): `0x4B` (`'K'`)
- `version` (1 byte): `0x01`
- `frame_type` (1 byte):
  - `0x01` transfer chunk
  - `0x02` control JSON
  - `0x03` log text
- `transfer_id_or_reserved` (4 bytes, LE, uint32)
  - transfer chunk: numeric transfer id
  - control/log: `0`
- `seq_or_reserved` (4 bytes, LE, uint32)
  - transfer chunk: chunk sequence
  - control/log: `0`
- `payload_len` (2 bytes, LE, uint16)
- `payload` (`payload_len` bytes)
- `crc32` (4 bytes, LE, uint32)

CRC scope:
- CRC32 is computed over bytes from `version` through the end of `payload`.
- `magic` and trailing `crc32` field are excluded.

Receiver behavior:
- Reject frame on bad magic/version/type/length/CRC.
- For transfer chunk decode errors with known `transfer_id` + `seq`, MCP sends `transfer.nack`.
- Extension retransmits the specific `seq` on `transfer.nack`.

## MCP Tool Contract
Available tools:
- `airkvm_send`
- `airkvm_list_tabs`
- `airkvm_dom_snapshot`
- `airkvm_screenshot_tab`
- `airkvm_screenshot_desktop`

Screenshot tools return structured JSON with:
- `request_id`, `source`, `mime`, `total_chunks`, `total_chars`, `encoding`, `base64`

## BLE Manual Testing
GATT profile:
- Service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
- RX (write/writeWithoutResponse): `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
- TX (notify/read): `6E400103-B5A3-F393-E0A9-E50E24DCCB01`

Control messages are JSON UTF-8 payloads; screenshot chunk payloads are raw binary frames.

## BLE Control Continuation (`ctrl.chunk`)

To handle BLE notification payload limits, firmware may split large control JSON payloads into chunk messages for BLE only:

```json
{"type":"ctrl.chunk","chunk_id":42,"seq":0,"total":3,"frag":"{\"type\":\"transfer.meta\"..."}
```

Fields:
- `chunk_id`: uint32 sender-local chunk session id.
- `seq`: zero-based fragment index.
- `total`: total number of fragments in this chunked control message.
- `frag`: escaped JSON substring fragment.

Receiver behavior (extension bridge):
- Buffer fragments by `chunk_id`.
- Reassemble when all `seq` in `[0..total-1]` are present.
- Parse concatenated JSON and forward only the fully reassembled control message.
- Ignore standalone `ctrl.chunk` fragments at handler layer.
