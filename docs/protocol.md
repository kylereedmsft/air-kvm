# Protocol (Current, March 8, 2026)

## 1) Transport Overview

AirKVM currently uses two transport segments:

1. `MCP <-> Firmware` over UART
- Control and logs are emitted from firmware as framed binary packets.
- Binary screenshot chunk payloads are also framed binary packets.

2. `Extension <-> Firmware` over BLE UART-style GATT
- Control messages are JSON lines (`...\n`) over BLE write/notify.
- Screenshot chunk payloads are sent as raw binary chunk frames.
- Large payload responses (screenshots, DOM snapshot) use the transfer/binary path (`transfer.meta` + binary chunk frames + `transfer.done`).

## 2) BLE GATT Profile

- Service: `6E400101-B5A3-F393-E0A9-E50E24DCCB01`
- RX characteristic (extension writes): `6E400102-B5A3-F393-E0A9-E50E24DCCB01`
  - properties: `write`, `writeWithoutResponse`
- TX characteristic (firmware notifies): `6E400103-B5A3-F393-E0A9-E50E24DCCB01`
  - properties: `notify`, `read`

Device name currently advertised by firmware:
- `air-kvm-ctrl-cb01`

## 3) Core Control Commands

Examples:

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
{"type":"tab.open.request","request_id":"req-open-1","url":"https://example.com","active":true}
{"type":"js.exec.request","request_id":"req-js-1","script":"return document.title;","timeout_ms":500,"max_result_chars":256}
{"type":"screenshot.request","source":"tab","request_id":"req-3","encoding":"bin"}
{"type":"screenshot.request","source":"desktop","request_id":"req-4","encoding":"bin","desktop_delay_ms":800}
```

`tab.open.request` options (validated by extension + MCP tooling):
- `request_id`: non-empty string (required)
- `url`: string length `[1..2048]` and must start with `http://` or `https://` (required)
- `active`: boolean (optional, defaults to `true`)

`js.exec.request` options (validated by extension + MCP tooling):
- `request_id`: string (required)
- `script`: string length `[1..600]` (required)
- `tab_id`: int (optional)
- `timeout_ms`: int `[50..2000]` (optional)
- `max_result_chars`: int `[64..700]` (optional)

`screen​shot.request` options (validated by extension + MCP tooling):
- `source`: `tab | desktop` (required)
- `request_id`: string (optional, generated if omitted)
- `max_width`: int `[160..1920]`
- `max_height`: int `[120..1080]`
- `quality`: number `[0.3..0.9]`
- `max_chars`: int `[20000..200000]`
- `tab_id`: int (tab source)
- `desktop_delay_ms`: int `[0..5000]` (desktop source)
- `encoding`: `bin` (forced by tooling)

## 4) Core Control Responses

Examples:

```json
{"type":"state","busy":false}
{"type":"fw.version","version":"dev","built_at":"..."}
{"type":"dom.snapshot","request_id":"req-1","summary":{...}}
{"type":"dom.snapshot.error","request_id":"req-1","error":"..."}
{"type":"tabs.list","request_id":"req-2","tabs":[...]}
{"type":"tabs.list.error","request_id":"req-2","error":"..."}
{"type":"tab.open","request_id":"req-open-1","tab":{"id":101,"window_id":3,"active":true,"title":"Example","url":"https://example.com"},"ts":1741320000000}
{"type":"tab.open.error","request_id":"req-open-1","error":"tabs_create_failed","ts":1741320000001}
{"type":"js.exec.result","request_id":"req-js-1","tab_id":123,"duration_ms":11,"value_type":"string","value_json":"\"Example\"","truncated":false,"ts":1741320000000}
{"type":"js.exec.error","request_id":"req-js-1","tab_id":123,"duration_ms":5,"error_code":"js_exec_runtime_error","error":"ReferenceError: foo is not defined","ts":1741320000001}
{"type":"screenshot.error","request_id":"req-3","source":"tab","error":"..."}
{"ok":true}
{"ok":false,"error":"..."}
```

Notes:
- Firmware emits `{ "ok": true }` after each accepted command line.
- Extension treats plain `{ "ok": true }` as ACK (not a typed protocol event).

## 5) Screenshot Transfer Protocol (Binary Payload Path)

### 5.1 Transfer lifecycle control frames

Extension -> MCP/firmware starts transfer:

```json
{"type":"transfer.meta","request_id":"req-3","transfer_id":"tx_12ab34cd","source":"tab","mime":"image/jpeg","encoding":"bin","chunk_size":160,"total_chunks":304,"total_bytes":27312}
```

Extension -> MCP/firmware ends transfer:

```json
{"type":"transfer.done","request_id":"req-3","transfer_id":"tx_12ab34cd","source":"tab","total_chunks":304}
```

MCP -> extension flow control / completion:

```json
{"type":"transfer.ack","request_id":"req-3","transfer_id":"tx_12ab34cd","highest_contiguous_seq":127}
{"type":"transfer.nack","request_id":"req-3","transfer_id":"tx_12ab34cd","seq":42,"reason":"crc_mismatch"}
{"type":"transfer.resume","request_id":"req-3","transfer_id":"tx_12ab34cd","from_seq":128}
{"type":"transfer.done.ack","request_id":"req-3","transfer_id":"tx_12ab34cd"}
```

Session control/error:

```json
{"type":"transfer.cancel","request_id":"req-3","transfer_id":"tx_12ab34cd"}
{"type":"transfer.cancel.ok","request_id":"req-3","transfer_id":"tx_12ab34cd"}
{"type":"transfer.reset","request_id":"req-3"}
{"type":"transfer.reset.ok","request_id":"req-3"}
{"type":"transfer.error","request_id":"req-3","transfer_id":"tx_12ab34cd","code":"no_such_transfer"}
```

### 5.2 Binary chunk frame format (`AK`)

Used for screenshot chunk payloads and for UART framed stream.

Packet layout:
- `magic0` (1 byte): `0x41` (`A`)
- `magic1` (1 byte): `0x4B` (`K`)
- `version` (1 byte): `0x01`
- `frame_type` (1 byte):
  - `0x01` transfer chunk
  - `0x02` control JSON
  - `0x03` log text
- `transfer_id_or_reserved` (4 bytes, LE uint32)
- `seq_or_reserved` (4 bytes, LE uint32)
- `payload_len` (2 bytes, LE uint16)
- `payload` (`payload_len` bytes)
- `crc32` (4 bytes, LE uint32)

CRC scope:
- From `version` through end of `payload`.
- Excludes magic bytes and trailing crc field.

Current limits:
- max payload length per frame: `4096` bytes (`mcp/src/binary_frame.js`)
- screenshot chunk payload produced by extension: `160` bytes

Transfer ID encoding:
- Control plane: string `tx_<hex8>` (for example `tx_12ab34cd`)
- Binary frame: uint32 LE numeric ID derived from that hex value.

## 6) MCP Tool Contract

Tools exposed by MCP:
- `airkvm_send`
- `airkvm_list_tabs`
- `airkvm_open_tab`
- `airkvm_dom_snapshot`
- `airkvm_exec_js_tab`
- `airkvm_screenshot_tab`
- `airkvm_screenshot_desktop`

`airkvm_open_tab` sends:
- `{ "type": "tab.open.request", "request_id", "url", "active?" }`

`airkvm_open_tab` success result shape:
- `type` (`tab.open`)
- `request_id`
- `tab`:
  - `id`
  - `window_id`
  - `active`
  - `title`
  - `url`
- `ts`

`airkvm_open_tab` error result shape:
- `type` (`tab.open.error`)
- `request_id`
- `error`
- `ts`

`airkvm_exec_js_tab` sends:
- `{ "type": "js.exec.request", "request_id", "script", "tab_id?", "timeout_ms?", "max_result_chars?" }`

`airkvm_exec_js_tab` success result shape:
- `type` (`js.exec.result`)
- `request_id`
- `tab_id`
- `duration_ms`
- `value_type`
- `value_json` (JSON string, bounded by `max_result_chars`)
- `truncated`
- `ts`

`airkvm_exec_js_tab` error result shape:
- `type` (`js.exec.error`)
- `request_id`
- `tab_id`
- `duration_ms`
- `error_code`
- `error`
- `ts`

Screenshot tool result shape:
- `request_id`
- `source`
- `mime`
- `total_chunks`
- `total_chars`
- `encoding` (`bin`)
- `base64`
- Optional (when `AIRKVM_SAVE_SCREENSHOTS=1`):
  - `saved_path`
  - `saved_bytes`

## 8) Timeout / Recovery Behavior (MCP collector)

- Pre-meta wait: up to 6 timeout extensions of 5s each (`screenshot_meta_timeout` if exceeded).
- Post-meta transfer timeout: retries with `transfer.resume` up to 3 times, then `screenshot_transfer_timeout`.
- Gap detection: MCP sends immediate `transfer.nack` with `reason: "missing_chunk"` when out-of-order gaps are detected.
- CRC / frame decode issues for binary chunks emit `transfer.nack` with specific `seq` where possible.

## 9) Reality Notes

- BLE HID (HOGP) support exists behind compile flag in firmware, but default build is BLE UART profile (`AIRKVM_ENABLE_HID=0`).
- Current production path for browser automation data is BLE UART + framed UART relay, not BLE HID.
