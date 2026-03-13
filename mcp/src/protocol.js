import { SCREENSHOT_CONTRACT } from '../../shared/screenshot_contract.js';

const TOOL_DEFINITIONS = [
  {
    name: 'airkvm_send',
    control: true,
    description: 'Forward a raw control command to the AirKVM device transport.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          properties: {
            type: { type: 'string' }
          },
          required: ['type']
        }
      },
      required: ['command']
    }
  },
  {
    name: 'airkvm_mouse_move_rel',
    control: true,
    description: 'Move the mouse relative to its current position on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        dx: { type: 'integer' },
        dy: { type: 'integer' }
      },
      required: ['dx', 'dy']
    }
  },
  {
    name: 'airkvm_mouse_move_abs',
    control: true,
    description: 'Move the mouse to an absolute screen position on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'airkvm_mouse_click',
    control: true,
    description: 'Click a mouse button on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string' }
      },
      required: ['button']
    }
  },
  {
    name: 'airkvm_key_tap',
    control: true,
    description: 'Tap a single keyboard key on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' }
      },
      required: ['key']
    }
  },
  {
    name: 'airkvm_key_type',
    control: true,
    description: 'Type a string of text on the target machine.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 128 }
      },
      required: ['text']
    }
  },
  {
    name: 'airkvm_state_request',
    control: true,
    description: 'Request the current device state from the AirKVM firmware.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'airkvm_state_set',
    control: true,
    description: 'Set the busy state on the AirKVM device.',
    inputSchema: {
      type: 'object',
      properties: {
        busy: { type: 'boolean' }
      },
      required: ['busy']
    }
  },
  {
    name: 'airkvm_fw_version_request',
    control: true,
    description: 'Request the firmware version from the AirKVM device.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'airkvm_transfer_reset',
    control: true,
    description: 'Reset the BLE transfer state on the AirKVM device.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'airkvm_list_tabs',
    description: 'List automatable browser tabs available on the target extension.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_window_bounds',
    description: 'Get browser window bounds in desktop coordinates for the target tab.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        tab_id: { type: 'integer' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_open_tab',
    description: 'Open a new browser tab on the target extension machine.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        url: { type: 'string', maxLength: 2048 },
        active: { type: 'boolean' }
      },
      required: ['request_id', 'url']
    }
  },
  {
    name: 'airkvm_dom_snapshot',
    description: 'Request a DOM snapshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_exec_js_tab',
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
    }
  },
  {
    name: 'airkvm_screenshot_tab',
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
    }
  },
  {
    name: 'airkvm_screenshot_desktop',
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
    }
  }
];

export function isControlTool(name) {
  return TOOL_DEFINITIONS.find((t) => t.name === name)?.control === true;
}

export function listTools() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function validateToolArgs(name, args) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: 'unknown_tool' };

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

function buildScreenshotOpts(args) {
  const opts = { encoding: SCREENSHOT_CONTRACT.encoding };
  if (Number.isInteger(args?.max_width)) opts.max_width = args.max_width;
  if (Number.isInteger(args?.max_height)) opts.max_height = args.max_height;
  if (typeof args?.quality === 'number') opts.quality = args.quality;
  if (Number.isInteger(args?.max_chars)) opts.max_chars = args.max_chars;
  if (Number.isInteger(args?.tab_id)) opts.tab_id = args.tab_id;
  return opts;
}

export function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export function buildCommandForTool(name, args = {}) {
  const validation = validateToolArgs(name, args);
  if (!validation.ok && validation.error !== 'unknown_tool') {
    throw new Error(validation.error);
  }

  if (name === 'airkvm_send') return args?.command;
  if (name === 'airkvm_mouse_move_rel') return { type: 'mouse.move_rel', dx: args.dx, dy: args.dy };
  if (name === 'airkvm_mouse_move_abs') return { type: 'mouse.move_abs', x: args.x, y: args.y };
  if (name === 'airkvm_mouse_click') return { type: 'mouse.click', button: args.button };
  if (name === 'airkvm_key_tap') return { type: 'key.tap', key: args.key };
  if (name === 'airkvm_key_type') return { type: 'key.type', text: args.text };
  if (name === 'airkvm_state_request') return { type: 'state.request' };
  if (name === 'airkvm_state_set') return { type: 'state.set', busy: args.busy };
  if (name === 'airkvm_fw_version_request') return { type: 'fw.version.request' };
  if (name === 'airkvm_transfer_reset') return { type: 'transfer.reset' };

  const requestId =
    typeof args?.request_id === 'string' && args.request_id.length > 0
      ? args.request_id
      : makeRequestId();

  if (name === 'airkvm_list_tabs') return { type: 'tabs.list.request', request_id: requestId };
  if (name === 'airkvm_window_bounds') {
    const command = { type: 'window.bounds.request', request_id: requestId };
    if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
    return command;
  }
  if (name === 'airkvm_open_tab') {
    return { type: 'tab.open.request', request_id: requestId, url: args.url, active: args.active ?? true };
  }
  if (name === 'airkvm_dom_snapshot') return { type: 'dom.snapshot.request', request_id: requestId };
  if (name === 'airkvm_exec_js_tab') {
    const command = { type: 'js.exec.request', request_id: requestId, script: args.script };
    if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
    if (Number.isInteger(args?.timeout_ms)) command.timeout_ms = args.timeout_ms;
    if (Number.isInteger(args?.max_result_chars)) command.max_result_chars = args.max_result_chars;
    return command;
  }
  if (name === 'airkvm_screenshot_tab') {
    return { type: 'screenshot.request', source: 'tab', request_id: requestId, ...buildScreenshotOpts(args) };
  }
  if (name === 'airkvm_screenshot_desktop') {
    const command = { type: 'screenshot.request', source: 'desktop', request_id: requestId, ...buildScreenshotOpts(args) };
    if (Number.isInteger(args?.desktop_delay_ms)) command.desktop_delay_ms = args.desktop_delay_ms;
    return command;
  }

  return null;
}
