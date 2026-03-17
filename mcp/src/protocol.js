// Tool registry: defines every MCP tool's name, description, JSON schema, target
// (fw = firmware-local, hid = HID input, extension = browser extension over BLE),
// and how to build the outgoing command and shape the response data.

import { SCREENSHOT_CONTRACT } from '../../shared/screenshot_contract.js';

export function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function reqId(args) {
  return typeof args?.request_id === 'string' && args.request_id.length > 0
    ? args.request_id
    : makeRequestId();
}

function screenshotOpts(args) {
  const opts = { encoding: SCREENSHOT_CONTRACT.encoding };
  if (Number.isInteger(args?.max_width)) opts.max_width = args.max_width;
  if (Number.isInteger(args?.max_height)) opts.max_height = args.max_height;
  if (typeof args?.quality === 'number') opts.quality = args.quality;
  if (Number.isInteger(args?.max_chars)) opts.max_chars = args.max_chars;
  if (Number.isInteger(args?.tab_id)) opts.tab_id = args.tab_id;
  return opts;
}

const TOOL_DEFINITIONS = [
  {
    name: 'airkvm_send',
    target: 'fw',
    description: 'Forward a raw control command to the AirKVM device transport.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          properties: { type: { type: 'string' } },
          required: ['type']
        }
      },
      required: ['command']
    },
    build: (args) => args.command
  },
  {
    name: 'airkvm_mouse_move_rel',
    target: 'hid',
    description: 'Move the mouse relative to its current position on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        dx: { type: 'integer' },
        dy: { type: 'integer' }
      },
      required: ['dx', 'dy']
    },
    build: (args) => ({ type: 'mouse.move_rel', dx: args.dx, dy: args.dy })
  },
  {
    name: 'airkvm_mouse_move_abs',
    target: 'hid',
    description: 'Move the mouse to an absolute coordinate in the target HID absolute range (0..32767).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer', minimum: 0, maximum: 32767 },
        y: { type: 'integer', minimum: 0, maximum: 32767 }
      },
      required: ['x', 'y']
    },
    build: (args) => ({ type: 'mouse.move_abs', x: args.x, y: args.y })
  },
  {
    name: 'airkvm_mouse_click',
    target: 'hid',
    description: 'Click a mouse button on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string' }
      },
      required: ['button']
    },
    build: (args) => ({ type: 'mouse.click', button: args.button })
  },
  {
    name: 'airkvm_key_tap',
    target: 'hid',
    description: 'Tap a single keyboard key on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' }
      },
      required: ['key']
    },
    build: (args) => ({ type: 'key.tap', key: args.key })
  },
  {
    name: 'airkvm_key_type',
    target: 'hid',
    description: 'Type a string of text on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['text']
    },
    build: (args) => ({ type: 'key.type', text: args.text })
  },
  {
    name: 'airkvm_state_request',
    target: 'fw',
    description: 'Request the current device state from the AirKVM firmware.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    build: () => ({ type: 'state.request' }),
  },
  {
    name: 'airkvm_state_set',
    target: 'fw',
    description: 'Set the busy state on the AirKVM device.',
    inputSchema: {
      type: 'object',
      properties: {
        busy: { type: 'boolean' }
      },
      required: ['busy']
    },
    build: (args) => ({ type: 'state.set', busy: args.busy }),
  },
  {
    name: 'airkvm_fw_version_request',
    target: 'fw',
    description: 'Request the firmware version from the AirKVM device.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    build: () => ({ type: 'fw.version.request' }),
  },
  {
    name: 'airkvm_transfer_reset',
    target: 'fw',
    description: 'Reset the BLE transfer state on the AirKVM device.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    build: () => ({ type: 'transfer.reset' })
  },
  {
    name: 'airkvm_save_image',
    description: 'Save a base64-encoded image to a file path on the host machine.',
    inputSchema: {
      type: 'object',
      properties: {
        base64: { type: 'string' },
        mime: { type: 'string' },
        path: { type: 'string' }
      },
      required: ['base64', 'mime', 'path']
    }
  },
  {
    name: 'airkvm_echo',
    target: 'extension',
    description: 'Round-trip echo to the target extension. Returns the same payload back. Useful for validating transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        payload: { type: 'string', minLength: 1, maxLength: 1000 }
      },
      required: ['payload']
    },
    build: (args) => ({ type: 'echo.request', request_id: reqId(args), payload: args.payload }),
    matchResponse: (cmd, msg) => msg?.type === 'echo.response' && msg?.request_id === cmd.request_id
  },
  {
    name: 'airkvm_list_tabs',
    target: 'extension',
    description: 'List automatable browser tabs available on the target extension.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    },
    build: (args) => ({ type: 'tabs.list.request', request_id: reqId(args) })
  },
  {
    name: 'airkvm_window_bounds',
    target: 'extension',
    description: 'Get browser window bounds in desktop coordinates for the target tab.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        tab_id: { type: 'integer' }
      },
      required: []
    },
    build: (args) => {
      const command = { type: 'window.bounds.request', request_id: reqId(args) };
      if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
      return command;
    }
  },
  {
    name: 'airkvm_open_tab',
    target: 'extension',
    description: 'Open a new browser tab on the target extension machine.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        url: { type: 'string', maxLength: 2048 },
        active: { type: 'boolean' }
      },
      required: ['request_id', 'url']
    },
    build: (args) => ({ type: 'tab.open.request', request_id: reqId(args), url: args.url, active: args.active ?? true })
  },
  {
    name: 'airkvm_open_window',
    target: 'extension',
    description: 'Open a new browser window on the target extension machine.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        url: { type: 'string', maxLength: 2048 },
        focused: { type: 'boolean' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        type: { type: 'string', enum: ['normal', 'popup'] }
      },
      required: ['request_id', 'url']
    },
    build: (args) => {
      const command = {
        type: 'window.open.request',
        request_id: reqId(args),
        url: args.url,
        focused: args.focused ?? true
      };
      if (Number.isInteger(args?.width)) command.width = args.width;
      if (Number.isInteger(args?.height)) command.height = args.height;
      if (typeof args?.type === 'string') command.window_type = args.type;
      return command;
    }
  },
  {
    name: 'airkvm_open_calibration_window',
    target: 'extension',
    description: 'Open the extension-hosted calibration popup window.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        session_id: { type: 'string' },
        focused: { type: 'boolean' },
        width: { type: 'integer' },
        height: { type: 'integer' }
      },
      required: ['request_id']
    },
    build: (args) => {
      const command = {
        type: 'calibration.open.request',
        request_id: reqId(args),
        session_id: typeof args?.session_id === 'string' && args.session_id.length > 0 ? args.session_id : reqId(args),
        focused: args.focused ?? true
      };
      if (Number.isInteger(args?.width)) command.width = args.width;
      if (Number.isInteger(args?.height)) command.height = args.height;
      return command;
    }
  },
  {
    name: 'airkvm_calibration_status',
    target: 'extension',
    description: 'Fetch the current calibration popup pointer-detection status.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: ['request_id']
    },
    build: (args) => ({ type: 'calibration.status.request', request_id: reqId(args) })
  },
  {
    name: 'airkvm_dom_snapshot',
    target: 'extension',
    timeoutMs: 10000,
    description: 'Request a DOM snapshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    },
    build: (args) => ({ type: 'dom.snapshot.request', request_id: reqId(args) }),
    formatData: (cmd, data) => ({ request_id: cmd.request_id, snapshot: data })
  },
  {
    name: 'airkvm_exec_js_tab',
    target: 'extension',
    description: 'Execute JavaScript in the target browser tab over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        script: { type: 'string', minLength: 1, maxLength: 12000 },
        tab_id: { type: 'integer' },
        timeout_ms: { type: 'integer', minimum: 50, maximum: 2000 },
        max_result_chars: { type: 'integer', minimum: 64, maximum: 700 }
      },
      required: ['request_id', 'script']
    },
    build: (args) => {
      const command = { type: 'js.exec.request', request_id: reqId(args), script: args.script };
      if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
      if (Number.isInteger(args?.timeout_ms)) command.timeout_ms = args.timeout_ms;
      if (Number.isInteger(args?.max_result_chars)) command.max_result_chars = args.max_result_chars;
      return command;
    }
  },
  {
    name: 'airkvm_screenshot_tab',
    target: 'extension',
    timeoutMs: 30000,
    description: 'Request a tab screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: SCREENSHOT_CONTRACT.width.min, maximum: SCREENSHOT_CONTRACT.width.max },
        max_height: { type: 'integer', minimum: SCREENSHOT_CONTRACT.height.min, maximum: SCREENSHOT_CONTRACT.height.max },
        quality: { type: 'number', minimum: SCREENSHOT_CONTRACT.quality.min, maximum: SCREENSHOT_CONTRACT.quality.max },
        max_chars: { type: 'integer', minimum: SCREENSHOT_CONTRACT.maxChars.min, maximum: SCREENSHOT_CONTRACT.maxChars.max },
        tab_id: { type: 'integer' },
        encoding: { type: 'string', enum: [SCREENSHOT_CONTRACT.encoding] }
      },
      required: []
    },
    build: (args) => ({ type: 'screenshot.request', source: 'tab', request_id: reqId(args), ...screenshotOpts(args) }),
    formatData: (cmd, data) => ({
      request_id: cmd.request_id,
      source: data.source || cmd.source,
      mime: data.mime || 'image/jpeg',
      base64: data.data || data.base64 || '',
    })
  },
  {
    name: 'airkvm_screenshot_desktop',
    target: 'extension',
    timeoutMs: 45000,
    description: 'Request a desktop screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: SCREENSHOT_CONTRACT.width.min, maximum: SCREENSHOT_CONTRACT.width.max },
        max_height: { type: 'integer', minimum: SCREENSHOT_CONTRACT.height.min, maximum: SCREENSHOT_CONTRACT.height.max },
        quality: { type: 'number', minimum: SCREENSHOT_CONTRACT.quality.min, maximum: SCREENSHOT_CONTRACT.quality.max },
        max_chars: { type: 'integer', minimum: SCREENSHOT_CONTRACT.maxChars.min, maximum: SCREENSHOT_CONTRACT.maxChars.max },
        desktop_delay_ms: {
          type: 'integer',
          minimum: SCREENSHOT_CONTRACT.desktopDelayMs.min,
          maximum: SCREENSHOT_CONTRACT.desktopDelayMs.max
        },
        encoding: { type: 'string', enum: [SCREENSHOT_CONTRACT.encoding] }
      },
      required: []
    },
    build: (args) => {
      const command = { type: 'screenshot.request', source: 'desktop', request_id: reqId(args), ...screenshotOpts(args) };
      if (Number.isInteger(args?.desktop_delay_ms)) command.desktop_delay_ms = args.desktop_delay_ms;
      return command;
    },
    formatData: (cmd, data) => ({
      request_id: cmd.request_id,
      source: data.source || cmd.source,
      mime: data.mime || 'image/jpeg',
      base64: data.data || data.base64 || '',
    })
  },
  {
    name: 'airkvm_bridge_logs',
    target: 'extension',
    timeoutMs: (args) => Number.isInteger(args?.timeout_ms) ? args.timeout_ms : 15000,
    description: 'Retrieve the recent log lines from the AirKVM BLE bridge page.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 }
      },
      required: []
    },
    build: (args) => ({ type: 'bridge.logs.request', request_id: reqId(args) }),
    matchResponse: (cmd, msg) => msg?.type === 'bridge.logs' && msg?.request_id === cmd.request_id,
    formatData: (cmd, data) => ({ request_id: cmd.request_id, lines: data.lines || [] })
  }
];

export function getTool(name) {
  return TOOL_DEFINITIONS.find((t) => t.name === name) ?? null;
}

export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function validateArgs(tool, args) {
  const schema = tool.inputSchema;
  const props = schema.properties || {};
  const required = schema.required || [];

  for (const field of required) {
    if (args[field] === undefined || args[field] === null) {
      return { ok: false, error: `missing_required_field:${field}` };
    }
  }

  for (const [field, spec] of Object.entries(props)) {
    const value = args[field];
    if (value === undefined) continue;

    if (spec.type === 'string') {
      if (typeof value !== 'string') return { ok: false, error: `invalid_type:${field}` };
      if (spec.minLength !== undefined && value.length < spec.minLength) return { ok: false, error: `too_short:${field}` };
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return { ok: false, error: `too_long:${field}` };
      if (spec.enum && !spec.enum.includes(value)) return { ok: false, error: `invalid_enum:${field}` };
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(value)) return { ok: false, error: `invalid_type:${field}` };
      if (spec.minimum !== undefined && value < spec.minimum) return { ok: false, error: `out_of_range:${field}` };
      if (spec.maximum !== undefined && value > spec.maximum) return { ok: false, error: `out_of_range:${field}` };
    } else if (spec.type === 'number') {
      if (typeof value !== 'number') return { ok: false, error: `invalid_type:${field}` };
      if (spec.minimum !== undefined && value < spec.minimum) return { ok: false, error: `out_of_range:${field}` };
      if (spec.maximum !== undefined && value > spec.maximum) return { ok: false, error: `out_of_range:${field}` };
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, error: `invalid_type:${field}` };
    } else if (spec.type === 'object') {
      if (typeof value !== 'object' || value === null) return { ok: false, error: `invalid_type:${field}` };
    }
  }

  return { ok: true };
}
