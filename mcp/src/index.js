import readline from 'node:readline';
import { validateAgentCommand, toDeviceLine } from './protocol.js';
import { UartTransport } from './uart.js';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function makeToolResultJson(payload) {
  return makeToolResultText(JSON.stringify(payload));
}

function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

const SERIAL_PORT = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const SERIAL_BAUD = Number.parseInt(process.env.AIRKVM_SERIAL_BAUD || '115200', 10);
const SERIAL_TIMEOUT_MS = Number.parseInt(process.env.AIRKVM_SERIAL_TIMEOUT_MS || '3000', 10);
const UART_DEBUG = process.env.AIRKVM_UART_DEBUG === '1';
const transport = new UartTransport({
  portPath: SERIAL_PORT,
  baudRate: Number.isNaN(SERIAL_BAUD) ? 115200 : SERIAL_BAUD,
  commandTimeoutMs: Number.isNaN(SERIAL_TIMEOUT_MS) ? 3000 : SERIAL_TIMEOUT_MS,
  debug: UART_DEBUG
});

function onInitialize(id) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'air-kvm-mcp', version: '0.1.0' },
      capabilities: { tools: {} }
    }
  });
}

function onToolsList(id) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      tools: [
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
              request_id: { type: 'string' }
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
              request_id: { type: 'string' }
            },
            required: []
          }
        }
      ]
    }
  });
}

function onToolCall(id, params) {
  const name = params?.name;
  let command = params?.arguments?.command;

  if (name === 'airkvm_dom_snapshot') {
    const requestId = params?.arguments?.request_id;
    command = {
      type: 'dom.snapshot.request',
      request_id: typeof requestId === 'string' && requestId.length > 0 ? requestId : makeRequestId()
    };
  }
  if (name === 'airkvm_screenshot_tab') {
    const requestId = params?.arguments?.request_id;
    command = {
      type: 'screenshot.request',
      source: 'tab',
      request_id: typeof requestId === 'string' && requestId.length > 0 ? requestId : makeRequestId()
    };
  }
  if (name === 'airkvm_screenshot_desktop') {
    const requestId = params?.arguments?.request_id;
    command = {
      type: 'screenshot.request',
      source: 'desktop',
      request_id: typeof requestId === 'string' && requestId.length > 0 ? requestId : makeRequestId()
    };
  }

  if (
    name !== 'airkvm_send' &&
    name !== 'airkvm_dom_snapshot' &&
    name !== 'airkvm_screenshot_tab' &&
    name !== 'airkvm_screenshot_desktop'
  ) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } });
    return;
  }

  const validation = validateAgentCommand(command);
  if (!validation.ok) {
    send({
      jsonrpc: '2.0',
      id,
      result: makeToolResultText(`command rejected: ${validation.error}`),
      isError: true
    });
    return;
  }

  const line = toDeviceLine(command).trim();
  let responseCollector = null;
  if (name === 'airkvm_dom_snapshot') {
    const requestId = command.request_id;
    responseCollector = (msg) => {
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
    responseCollector = (msg) => {
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

  transport.sendCommand(command, responseCollector).then((result) => {
    if (name === 'airkvm_dom_snapshot' || name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop') {
      if (result.ok === false) {
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultJson(result.data || { error: 'request_failed' }),
          isError: true
        });
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultJson(result.data || { ok: true })
      });
      return;
    }
    const isStateResponse = result?.msg?.type === 'state' && typeof result?.msg?.busy === 'boolean';
    const isExplicitRejection = result?.msg && result.ok === false;
    if (isExplicitRejection) {
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(`device rejected ${line}: ${JSON.stringify(result.msg)}`),
        isError: true
      });
      return;
    }
    if (command.type === 'state.request' && isStateResponse) {
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(`forwarded ${line}; state=${JSON.stringify(result.msg)}`)
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: makeToolResultText(`forwarded ${line}`)
    });
  }).catch((err) => {
    send({
      jsonrpc: '2.0',
      id,
      result: makeToolResultText(`transport error: ${err.message}`),
      isError: true
    });
  });
}

function handleRequest(msg) {
  if (msg?.jsonrpc !== '2.0') return;

  if (msg.method === 'initialize') {
    onInitialize(msg.id);
    return;
  }

  if (msg.method === 'tools/list') {
    onToolsList(msg.id);
    return;
  }

  if (msg.method === 'tools/call') {
    onToolCall(msg.id, msg.params);
    return;
  }

  if (typeof msg.id !== 'undefined') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    handleRequest(msg);
  } catch {
    // Ignore malformed input to keep STDIO loop resilient.
  }
});
rl.on('close', () => {
  transport.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  transport.close();
  process.exit(0);
});
