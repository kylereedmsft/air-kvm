import { validateAgentCommand, toDeviceLine } from './protocol.js';
import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool,
  TOOL_DEFINITIONS
} from './tooling.js';

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function makeToolResultJson(payload) {
  return makeToolResultText(JSON.stringify(payload));
}

export function createServer({ transport, send }) {
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
        tools: TOOL_DEFINITIONS
      }
    });
  }

  function onToolCall(id, params) {
    const name = params?.name;
    const command = buildCommandForTool(name, params?.arguments || {});

    if (!isKnownTool(name)) {
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
    const responseCollector = createResponseCollector(name, command);

    transport.sendCommand(command, responseCollector).then((result) => {
      if (isStructuredTool(name)) {
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

  return { handleRequest };
}
