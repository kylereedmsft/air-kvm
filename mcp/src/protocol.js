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
    case 'screenshot.request':
      if (!((msg.source === 'tab' || msg.source === 'desktop') && typeof msg.request_id === 'string')) {
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
      if (typeof msg.quality !== 'undefined' && typeof msg.quality !== 'number') {
        return { ok: false, error: 'invalid_screenshot_request' };
      }
      return { ok: true };
    default:
      return { ok: false, error: 'unknown_type' };
  }
}

export function toDeviceLine(msg) {
  return `${JSON.stringify(msg)}\n`;
}
