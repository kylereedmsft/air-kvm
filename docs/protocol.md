# Protocol (POC v0)

## Agent <-> Firmware (Serial JSONL)

Each message is one JSON object terminated by `\n`.

### Commands

```json
{"type":"mouse.move_rel","dx":10,"dy":-4}
{"type":"mouse.move_abs","x":1200,"y":340}
{"type":"mouse.click","button":"left"}
{"type":"key.tap","key":"Enter"}
{"type":"state.request"}
{"type":"state.set","busy":true}
{"type":"fw.version.request"}
```

### Responses/events (UART multiplex framing)

```json
{"ch":"ctrl","msg":{"type":"event","event":"mouse.move_rel"}}
{"ch":"ctrl","msg":{"type":"state","busy":false}}
{"ch":"ctrl","msg":{"type":"fw.version","version":"dev","built_at":"Mar  7 2026 12:34:56"}}
{"ch":"ctrl","msg":{"ok":true}}
{"ch":"log","msg":"rx.ble {\"type\":\"state.request\"}"}
```

`ctrl` carries protocol payloads. `log` carries diagnostic strings.  
Firmware also accepts legacy plain JSON command lines on UART and BLE RX.

Boot payload now includes build metadata:

```json
{"type":"boot","fw":"air-kvm-poc","version":"dev","built_at":"Mar  7 2026 12:34:56"}
```

## MCP tool contract

Tool: `airkvm_send`
- Input: `{ "command": <serial command object> }`
- Output text: transport-forwarding status or device rejection/timeout

## BLE Manual Testing

Device GATT profile:
- Service UUID: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- RX (write/write-no-response): `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- TX (notify/read): `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`

Important:
- Write UTF-8 JSON text to RX characteristic (not numbers like `8`).
- Newline is optional for BLE writes.

Example valid payloads:

```json
{"type":"state.request"}
{"type":"mouse.move_rel","dx":10,"dy":-4}
{"type":"mouse.move_abs","x":1200,"y":340}
{"type":"mouse.click","button":"left"}
{"type":"key.tap","key":"Enter"}
{"type":"fw.version.request"}
```

Expected TX notifications after `{"type":"state.request"}`:

```json
{"type":"state","busy":false}
{"ok":true}
```

Set busy example:

```json
{"type":"state.set","busy":true}
```

Expected:

```json
{"type":"state","busy":true}
{"ok":true}
```

Expected UART monitor output (framed):

```json
{"ch":"log","msg":"rx.ble {\"type\":\"state.request\"}"}
{"ch":"ctrl","msg":{"type":"state","busy":false}}
{"ch":"ctrl","msg":{"ok":true}}
```

Firmware version check example:

```json
{"type":"fw.version.request"}
```

Expected:

```json
{"type":"fw.version","version":"dev","built_at":"Mar  7 2026 12:34:56"}
{"ok":true}
```

Invalid payload behavior:

```json
{"ok":false,"error":"invalid_command"}
```

## Planned additions

1. Screenshot framing
- `screenshot.meta` control object
- binary chunk stream with frame id + sequence

2. Busy/DOM channel
- extension emits `busy.changed`, `dom.summary`
- transport/collection path intentionally separate from MCP
