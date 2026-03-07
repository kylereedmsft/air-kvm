import readline from 'node:readline';
import { validateAgentCommand, toDeviceLine } from './protocol.js';
import { UartTransport } from './uart.js';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
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
        }
      ]
    }
  });
}

function onToolCall(id, params) {
  const name = params?.name;
  const command = params?.arguments?.command;

  if (name !== 'airkvm_send') {
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
  transport.sendCommand(command).then((result) => {
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
