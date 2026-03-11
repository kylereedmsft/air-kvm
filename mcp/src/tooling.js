import { SCREENSHOT_CONTRACT } from './screenshot_contract.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'airkvm_send',
    description: 'Validate and forward a control command to the AirKVM device transport.',
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

export function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

export function isKnownTool(name) {
  return TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export function isStructuredTool(name) {
  return (
    name === 'airkvm_dom_snapshot' ||
    name === 'airkvm_list_tabs' ||
    name === 'airkvm_window_bounds' ||
    name === 'airkvm_open_tab' ||
    name === 'airkvm_exec_js_tab' ||
    name === 'airkvm_screenshot_tab' ||
    name === 'airkvm_screenshot_desktop'
  );
}

export function buildCommandForTool(name, args = {}) {
  if (name === 'airkvm_send') {
    return args?.command;
  }

  const requestId =
    typeof args?.request_id === 'string' && args.request_id.length > 0
      ? args.request_id
      : makeRequestId();

  const screenshotOptions = {};
  if (Number.isInteger(args?.max_width)) screenshotOptions.max_width = args.max_width;
  if (Number.isInteger(args?.max_height)) screenshotOptions.max_height = args.max_height;
  if (typeof args?.quality === 'number') screenshotOptions.quality = args.quality;
  if (Number.isInteger(args?.max_chars)) screenshotOptions.max_chars = args.max_chars;
  if (Number.isInteger(args?.tab_id)) screenshotOptions.tab_id = args.tab_id;
  screenshotOptions.encoding = SCREENSHOT_CONTRACT.encoding;

  if (name === 'airkvm_list_tabs') {
    return { type: 'tabs.list.request', request_id: requestId };
  }
  if (name === 'airkvm_window_bounds') {
    const command = { type: 'window.bounds.request', request_id: requestId };
    if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
    return command;
  }
  if (name === 'airkvm_open_tab') {
    const command = {
      type: 'tab.open.request',
      request_id: requestId,
      url: typeof args?.url === 'string' ? args.url : '',
      active: typeof args?.active === 'boolean' ? args.active : true
    };
    return command;
  }
  if (name === 'airkvm_dom_snapshot') {
    return { type: 'dom.snapshot.request', request_id: requestId };
  }
  if (name === 'airkvm_exec_js_tab') {
    const command = {
      type: 'js.exec.request',
      request_id: requestId,
      script: typeof args?.script === 'string' ? args.script : ''
    };
    if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
    if (Number.isInteger(args?.timeout_ms)) command.timeout_ms = args.timeout_ms;
    if (Number.isInteger(args?.max_result_chars)) command.max_result_chars = args.max_result_chars;
    return command;
  }
  if (name === 'airkvm_screenshot_tab') {
    return { type: 'screenshot.request', source: 'tab', request_id: requestId, ...screenshotOptions };
  }
  if (name === 'airkvm_screenshot_desktop') {
    const desktopOptions = { ...screenshotOptions };
    if (Number.isInteger(args?.desktop_delay_ms)) desktopOptions.desktop_delay_ms = args.desktop_delay_ms;
    return { type: 'screenshot.request', source: 'desktop', request_id: requestId, ...desktopOptions };
  }

  return null;
}

function isCorrelatedDeviceRejection(msg, requestId) {
  if (typeof msg?.ok !== 'boolean' || msg.ok !== false) return false;
  if (typeof requestId !== 'string' || requestId.length === 0) return true;
  const msgRequestId = msg?.request_id ?? msg?.rid ?? null;
  return typeof msgRequestId === 'string' && msgRequestId === requestId;
}

export function createResponseCollector(name, command) {
  if (name === 'airkvm_list_tabs') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'tabs.list' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: {
            request_id: requestId,
            tabs: Array.isArray(msg.tabs) ? msg.tabs : []
          }
        };
      }
      if (msg?.type === 'tabs.list.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'tabs_list_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_open_tab') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'tab.open' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: msg
        };
      }
      if (msg?.type === 'tab.open.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'tab_open_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_window_bounds') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'window.bounds' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: msg
        };
      }
      if (msg?.type === 'window.bounds.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'window_bounds_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_exec_js_tab') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'js.exec.result' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: msg
        };
      }
      if (msg?.type === 'js.exec.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: msg.error || msg.error_code || 'js_exec_error',
            detail: msg
          }
        };
      }
      return null;
    };
  }

  return null;
}
