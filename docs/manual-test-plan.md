# AirKVM Manual Test Plan

All tests use the MCP harness script against a live firmware over UART.
Set `AIRKVM_SERIAL_PORT` to your device path before running.

```bash
export AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001
```

The harness command pattern:
```bash
node scripts/mcp-tool-call.mjs <tool> '<json_args>'
```

---

## T-01 — Firmware Version

**Purpose:** Verify firmware is reachable and reports its build identity.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"fw.version.request"}}'
```

**Expected response contains:**
```json
{
  "type": "fw.version",
  "version": "dev",
  "built_at": "<compile-time timestamp>"
}
```

**Pass criteria:**
- `type` is `"fw.version"`
- `version` is a non-empty string
- `built_at` matches the format `"Mmm DD YYYY HH:MM:SS"` (e.g. `"Mar 12 2026 05:00:00"`)
- No `device_timeout` error

---

## T-02 — Device State Read

**Purpose:** Verify `state.request` returns the busy flag.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"state.request"}}'
```

**Expected response contains:**
```json
{
  "type": "state",
  "busy": false
}
```

**Pass criteria:**
- `type` is `"state"`
- `busy` is a boolean (`false` at idle)

---

## T-03 — Device State Write

**Purpose:** Verify `state.set` updates the busy flag and echoes back the new state.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"state.set","busy":true}}'
```

**Expected response contains:**
```json
{
  "type": "state",
  "busy": true
}
```

Then reset it:
```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"state.set","busy":false}}'
```

**Pass criteria:**
- First call: `busy` echoed back as `true`
- Second call: `busy` echoed back as `false`

---

## T-04 — Mouse Relative Move

**Purpose:** Verify mouse movement is injected via BLE HID.

**Setup:** Focus a window on the target machine where cursor movement is visible.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.move_rel","dx":50,"dy":50}}'
```

**Expected response:**
```json
{ "ok": true }
```

Verify cursor moved down-right ~50px on the target.

Also test negative movement:
```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.move_rel","dx":-50,"dy":-50}}'
```

**Pass criteria:**
- Both calls return `{"ok":true}`
- Cursor visibly moves on the target machine in the expected direction

---

## T-05 — Mouse Click

**Purpose:** Verify left, right, and middle click are injected via BLE HID.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.click","button":"left"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.click","button":"right"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.click","button":"middle"}}'
```

**Expected response (each):**
```json
{ "ok": true }
```

**Pass criteria:**
- All three return `{"ok":true}`
- Left click selects/activates target UI element
- Right click opens a context menu
- Middle click (e.g. over a browser tab) performs expected middle-click action

**Invalid button (error path):**
```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"mouse.click","button":"invalid"}}'
```
Expected: `{"ok":false,"error":"command_rejected"}`

---

## T-06 — Key Tap (Named Keys)

**Purpose:** Verify named key press/release is injected via BLE HID.

Focus a text field on the target machine, then:

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"a"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"A"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"Enter"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"Backspace"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"Escape"}}'
```

**Expected response (each):**
```json
{ "ok": true }
```

**Pass criteria:**
- `a` types lowercase `a`
- `A` types uppercase `A` (shift applied automatically)
- `Enter` sends a newline / submits a form
- `Backspace` deletes the previous character
- `Escape` dismisses a focused element / dialog

---

## T-07 — Key Tap (Modifier + Function Keys)

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"F5"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"ArrowRight"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.tap","key":"Tab"}}'
```

**Expected response (each):** `{"ok":true}`

**Pass criteria:**
- `F5` triggers page reload (or expected F5 action) on target
- `ArrowRight` moves cursor/focus right
- `Tab` moves focus to next element

---

## T-08 — Key Type (Plain Text)

**Purpose:** Verify a string is typed character by character via BLE HID.

Focus a text field on the target machine, then:

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"Hello, World!"}}'
```

**Expected response:** `{"ok":true}`

**Pass criteria:**
- Text field on target machine contains `Hello, World!`
- Capitalisation and punctuation correct

---

## T-09 — Key Type (Escape Sequences)

**Purpose:** Verify escape sequences in `key.type` are resolved correctly.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"line1\nline2"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"col1\tcol2"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"back\\slash"}}'
```

**Pass criteria:**
- `\n` produces a newline / Enter between `line1` and `line2`
- `\t` produces a tab between `col1` and `col2`
- `\\` produces a literal backslash

---

## T-10 — Key Type (Named Key Sequences)

**Purpose:** Verify `{Name}` tokens inside `key.type` text.

```bash
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"end{Enter}"}}'
node scripts/mcp-tool-call.mjs airkvm_send '{"command":{"type":"key.type","text":"{Tab}value"}}'
```

**Pass criteria:**
- `{Enter}` produces Enter at the end of typed text
- `{Tab}` moves focus before typing `value`

---

## T-11 — List Tabs

**Purpose:** Verify the extension returns the current list of open tabs.

**Prerequisite:** Extension loaded from `extension/dist/` and BLE connected.

```bash
node scripts/mcp-tool-call.mjs airkvm_list_tabs '{}'
```

**Expected response:**
```json
{
  "tabs": [
    { "id": 1, "title": "...", "url": "https://..." }
  ]
}
```

**Pass criteria:**
- `tabs` is an array with at least one entry
- Each entry has `id` (number), `title` (string), `url` (string)

---

## T-12 — Open Tab

**Purpose:** Verify a new tab can be opened on the target machine.

```bash
node scripts/mcp-tool-call.mjs airkvm_open_tab '{"request_id":"open-1","url":"https://example.com","active":true}'
```

**Expected response:**
```json
{
  "tab_id": 3,
  "url": "https://example.com",
  "title": "Example Domain"
}
```

**Pass criteria:**
- `tab_id` is a positive integer
- `url` matches the requested URL
- `title` is a non-empty string
- Tab visibly opens on the target browser

---

## T-13 — DOM Snapshot

**Purpose:** Verify the extension captures a DOM snapshot of the active tab.

```bash
node scripts/mcp-tool-call.mjs airkvm_dom_snapshot '{"request_id":"dom-1"}'
```

**Expected response:** large JSON object containing `html` and/or `text_content` fields.

**Pass criteria:**
- Response arrives within 60 seconds
- `html` or `text_content` is a non-empty string
- Content reflects the active page on the target

---

## T-14 — Execute JavaScript

**Purpose:** Verify JavaScript can be executed in the active tab.

```bash
node scripts/mcp-tool-call.mjs airkvm_exec_js_tab '{"request_id":"js-1","script":"return document.title;"}'
```

**Expected response:**
```json
{ "result": "<current page title>" }
```

**Pass criteria:**
- `result` matches the visible page title on the target

---

## T-14b — Inject JavaScript Silently

**Purpose:** Verify JavaScript can be injected into the active tab without using the CDP-backed exec path.

```bash
node scripts/mcp-tool-call.mjs airkvm_inject_js_tab '{"request_id":"js-inject-1","script":"{\"__airkvm_inject\":true,\"op\":\"hid_fixture.read\"}"}'
```

**Expected response:**
```json
{ "value": null, "log": null, "hid": null }
```

**Pass criteria:**
- Response arrives without debugger UI side effects
- Response is structured JSON from the injected page-side helper

---

## T-15 — Tab Screenshot

**Purpose:** Verify a JPEG screenshot of the active tab is captured and returned.

```bash
AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_tab \
  '{"request_id":"shot-1","max_width":960,"max_height":540,"quality":0.55}'
```

**Expected response:**
```json
{
  "request_id": "shot-1",
  "source": "tab",
  "mime": "image/jpeg",
  "base64": "...",
  "saved_path": "temp/shot-1.jpg"
}
```

**Pass criteria:**
- `mime` is `"image/jpeg"`
- `base64` is a non-empty string
- `saved_path` exists and opens as a valid JPEG showing the active tab content

---

## T-16 — Desktop Screenshot

**Purpose:** Verify a JPEG screenshot of the full desktop is captured.

```bash
AIRKVM_SAVE_SCREENSHOTS=1 node scripts/mcp-tool-call.mjs airkvm_screenshot_desktop \
  '{"request_id":"desk-1","max_width":960,"max_height":540,"quality":0.55,"desktop_delay_ms":500}'
```

**Expected response:**
```json
{
  "request_id": "desk-1",
  "source": "desktop",
  "mime": "image/jpeg",
  "base64": "...",
  "saved_path": "temp/desk-1.jpg"
}
```

**Pass criteria:**
- `mime` is `"image/jpeg"`
- `saved_path` exists and opens as a valid JPEG showing the full desktop of the target machine

---

## Known Bugs Fixed

| Bug | Fix commit |
|-----|------------|
| `fw.version.request` always timed out — MCP `shouldResolveForCommand` had no case for `fw.version` response | `08ab100` / `mcp/src/uart.js` |
| `ble_bridge.html` 404 — service worker path was `src/ble_bridge.html`, file lives at `ble_bridge.html` in dist | `a198c18` |
