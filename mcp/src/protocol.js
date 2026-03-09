export function isCommand(msg) {
  return typeof msg === 'object' && msg !== null && typeof msg.type === 'string';
}

export function validateAgentCommand(msg) {
  if (!isCommand(msg)) return { ok: false, error: 'invalid_message' };

  switch (msg.type) {
    case 'mouse.move_rel':
      return Number.isInteger(msg.dx) && Number.isInteger(msg.dy)
        ? { ok: true }
        : { ok: false, error: 'invalid_mouse_move_rel' };
    case 'mouse.move_abs':
      return Number.isInteger(msg.x) && Number.isInteger(msg.y)
        ? { ok: true }
        : { ok: false, error: 'invalid_mouse_move_abs' };
    case 'mouse.click':
      return typeof msg.button === 'string' ? { ok: true } : { ok: false, error: 'invalid_mouse_click' };
    case 'key.tap':
      return typeof msg.key === 'string' ? { ok: true } : { ok: false, error: 'invalid_key_tap' };
    case 'key.type':
      if (typeof msg.text !== 'string' || msg.text.length < 1 || msg.text.length > 128) {
        return { ok: false, error: 'invalid_key_type' };
      }
      return /^[A-Za-z0-9 ]+$/.test(msg.text)
        ? { ok: true }
        : { ok: false, error: 'invalid_key_type' };
    case 'state.request':
      return { ok: true };
    case 'state.set':
      return typeof msg.busy === 'boolean' ? { ok: true } : { ok: false, error: 'invalid_state_set' };
    case 'fw.version.request':
      return { ok: true };
    case 'dom.snapshot.request':
      return typeof msg.request_id === 'string'
        ? { ok: true }
        : { ok: false, error: 'invalid_dom_snapshot_request' };
    case 'tab.open.request':
      if (typeof msg.request_id !== 'string' || msg.request_id.length === 0) {
        return { ok: false, error: 'invalid_tab_open_request' };
      }
      if (
        typeof msg.url !== 'string' ||
        msg.url.length === 0 ||
        msg.url.length > 2048 ||
        (!msg.url.startsWith('http://') && !msg.url.startsWith('https://'))
      ) {
        return { ok: false, error: 'invalid_tab_open_request' };
      }
      if (typeof msg.active !== 'undefined' && typeof msg.active !== 'boolean') {
        return { ok: false, error: 'invalid_tab_open_request' };
      }
      return { ok: true };
    case 'js.exec.request':
      if (typeof msg.request_id !== 'string') {
        return { ok: false, error: 'invalid_js_exec_request' };
      }
      if (typeof msg.script !== 'string' || msg.script.length < 1 || msg.script.length > 600) {
        return { ok: false, error: 'invalid_js_exec_request' };
      }
      if (typeof msg.tab_id !== 'undefined' && !Number.isInteger(msg.tab_id)) {
        return { ok: false, error: 'invalid_js_exec_request' };
      }
      if (
        typeof msg.timeout_ms !== 'undefined' &&
        (!Number.isInteger(msg.timeout_ms) || msg.timeout_ms < 50 || msg.timeout_ms > 2000)
      ) {
        return { ok: false, error: 'invalid_js_exec_request' };
      }
      if (
        typeof msg.max_result_chars !== 'undefined' &&
        (!Number.isInteger(msg.max_result_chars) || msg.max_result_chars < 64 || msg.max_result_chars > 700)
      ) {
        return { ok: false, error: 'invalid_js_exec_request' };
      }
      return { ok: true };
    case 'screenshot.request':
      if (!((msg.source === 'tab' || msg.source === 'desktop') && typeof msg.request_id === 'string')) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.tab_id !== 'undefined' && !Number.isInteger(msg.tab_id)) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.max_width !== 'undefined' && !Number.isInteger(msg.max_width)) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.max_height !== 'undefined' && !Number.isInteger(msg.max_height)) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.max_chars !== 'undefined' && !Number.isInteger(msg.max_chars)) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.desktop_delay_ms !== 'undefined' && !Number.isInteger(msg.desktop_delay_ms)) {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.quality !== 'undefined' && typeof msg.quality !== 'number') {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      if (typeof msg.encoding !== 'undefined' && msg.encoding !== 'bin') {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      return { ok: true };
    case 'tabs.list.request':
      return { ok: true };
    case 'transfer.reset':
      return { ok: true };
    case 'transfer.cancel':
      return typeof msg.transfer_id === 'string'
        ? { ok: true }
        : { ok: false, error: 'invalid_transfer_control' };
    case 'transfer.resume':
      return (typeof msg.transfer_id === 'string' && Number.isInteger(msg.from_seq))
        ? { ok: true }
        : { ok: false, error: 'invalid_transfer_control' };
    case 'transfer.ack':
      return (typeof msg.transfer_id === 'string' && Number.isInteger(msg.highest_contiguous_seq))
        ? { ok: true }
        : { ok: false, error: 'invalid_transfer_control' };
    case 'transfer.done.ack':
      return typeof msg.transfer_id === 'string'
        ? { ok: true }
        : { ok: false, error: 'invalid_transfer_control' };
    case 'transfer.nack':
      return (typeof msg.transfer_id === 'string' && Number.isInteger(msg.seq))
        ? { ok: true }
        : { ok: false, error: 'invalid_transfer_control' };
    default:
      return { ok: false, error: 'unknown_type' };
  }
}

export function toDeviceLine(msg) {
  return `${JSON.stringify(msg)}\n`;
}
