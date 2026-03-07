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
    name: 'airkvm_screenshot_tab',
    description: 'Request a tab screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: 160, maximum: 1920 },
        max_height: { type: 'integer', minimum: 120, maximum: 1080 },
        quality: { type: 'number', minimum: 0.3, maximum: 0.9 },
        max_chars: { type: 'integer', minimum: 20000, maximum: 200000 }
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
        max_width: { type: 'integer', minimum: 160, maximum: 1920 },
        max_height: { type: 'integer', minimum: 120, maximum: 1080 },
        quality: { type: 'number', minimum: 0.3, maximum: 0.9 },
        max_chars: { type: 'integer', minimum: 20000, maximum: 200000 }
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

  if (name === 'airkvm_dom_snapshot') {
    return { type: 'dom.snapshot.request', request_id: requestId };
  }
  if (name === 'airkvm_screenshot_tab') {
    return { type: 'screenshot.request', source: 'tab', request_id: requestId, ...screenshotOptions };
  }
  if (name === 'airkvm_screenshot_desktop') {
    return { type: 'screenshot.request', source: 'desktop', request_id: requestId, ...screenshotOptions };
  }

  return null;
}

export function createResponseCollector(name, command) {
  if (name === 'airkvm_dom_snapshot') {
    const requestId = command.request_id;
    return (msg) => {
      if (typeof msg.ok === 'boolean' && msg.ok === false) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg.type === 'dom.snapshot' && msg.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: { request_id: requestId, snapshot: msg }
        };
      }
      if (msg.type === 'dom.snapshot.error' && msg.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'dom_snapshot_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop') {
    const requestId = command.request_id;
    const chunksBySeq = new Map();
    let meta = null;

    return (msg) => {
      if (typeof msg.ok === 'boolean' && msg.ok === false) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg.request_id !== requestId) {
        return null;
      }
      if (msg.type === 'screenshot.error') {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msg.source || command.source,
            error: msg.error || 'screenshot_error',
            detail: msg
          }
        };
      }
      if (msg.type === 'screenshot.meta') {
        meta = msg;
      } else if (msg.type === 'screenshot.chunk' && Number.isInteger(msg.seq) && typeof msg.data === 'string') {
        chunksBySeq.set(msg.seq, msg.data);
      }

      if (!meta || !Number.isInteger(meta.total_chunks) || meta.total_chunks < 0) {
        return null;
      }
      if (chunksBySeq.size < meta.total_chunks) {
        return null;
      }

      const ordered = [];
      for (let seq = 0; seq < meta.total_chunks; seq += 1) {
        if (!chunksBySeq.has(seq)) {
          return null;
        }
        ordered.push(chunksBySeq.get(seq));
      }

      const base64 = ordered.join('');
      return {
        done: true,
        ok: true,
        data: {
          request_id: requestId,
          source: meta.source || command.source,
          mime: meta.mime || 'application/octet-stream',
          total_chunks: meta.total_chunks,
          total_chars: typeof meta.total_chars === 'number' ? meta.total_chars : base64.length,
          base64
        }
      };
    };
  }

  return null;
}
