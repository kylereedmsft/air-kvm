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
```

### Responses/events (current scaffold)

```json
{"type":"event","event":"mouse.move_rel"}
{"type":"state","busy":false}
{"ok":true}
```

## MCP tool contract

Tool: `airkvm_send`
- Input: `{ "command": <serial command object> }`
- Output text: transport-forwarding status string

## Planned additions

1. Screenshot framing
- `screenshot.meta` control object
- binary chunk stream with frame id + sequence

2. Busy/DOM channel
- extension emits `busy.changed`, `dom.summary`
- MCP bridge stores latest browser state and exposes read tool
