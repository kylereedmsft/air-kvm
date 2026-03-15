// MCP server: handles JSON-RPC requests from the client (tools/list, tools/call),
// validates arguments, dispatches to the UART transport for firmware/extension commands,
// and formats responses back to the client.

import fs from 'node:fs';
import path from 'node:path';

import {
  getTool,
  listTools,
  validateArgs
} from './protocol.js';

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function makeToolResultJson(payload) {
  return makeToolResultText(JSON.stringify(payload));
}

function saveImage(base64, mime, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(base64, 'base64');
  fs.writeFileSync(filePath, bytes);
  return { saved_path: filePath, saved_bytes: bytes.length };
}

// TODO: DEAD
function compactFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  if (frame.kind === 'log') return { kind: 'log', msg: frame.msg };
  if (frame.kind === 'ctrl') return { kind: 'ctrl', msg: frame.msg };
  if (frame.kind === 'invalid') return { kind: 'invalid', raw: frame.raw };
  return frame;
}

function buildDiagnostics(err) {
  const frames = Array.isArray(err?.frames) ? err.frames.map(compactFrame) : [];
  const recent = Array.isArray(err?.recentFrames) ? err.recentFrames.map(compactFrame) : [];
  if (frames.length === 0 && recent.length === 0) return null;
  return { frames, recent_frames: recent };
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
        tools: listTools()
      }
    });
  }

  function onToolCall(id, params) {
    const name = params?.name;
    const tool = getTool(name);

    if (!tool) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool' } });
      return;
    }

    const args = params?.arguments || {};
    const validation = validateArgs(tool, args);
    if (!validation.ok) {
      send({
        jsonrpc: '2.0',
        id,
        result: makeToolResultText(`invalid arguments: ${validation.error}`),
        isError: true
      });
      return;
    }

    if (name === 'airkvm_transfer_reset') {
      transport.halfpipe.reset().then(() => {
        send({ jsonrpc: '2.0', id, result: makeToolResultText('BLE transfer state reset') });
      }).catch((err) => {
        send({ jsonrpc: '2.0', id, result: makeToolResultText(`reset failed: ${err.message}`), isError: true });
      });
      return;
    }

    if (name === 'airkvm_save_image') {
      try {
        const result = saveImage(args.base64, args.mime, args.path);
        send({ jsonrpc: '2.0', id, result: makeToolResultJson(result) });
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: makeToolResultJson({ error: 'save_failed', detail: err.message }), isError: true });
      }
      return;
    }

    const command = tool.build(args);
    const timeoutMs = tool.timeoutMs ?? 8000;

    transport.send(command, tool, { timeoutMs }).then(({ ok, data }) => {
      if (!ok) {
        send({
          jsonrpc: '2.0', id,
          result: makeToolResultJson({
            request_id: command.request_id || null,
            error: data?.error || 'device_error',
            detail: data
          }),
          isError: true
        });
        return;
      }

      send({
        jsonrpc: '2.0', id,
        result: makeToolResultJson(tool.formatData ? tool.formatData(command, data) : data)
      });
    }).catch((err) => {
      const diagnostics = buildDiagnostics(err);
      send({
        jsonrpc: '2.0', id,
        result: makeToolResultJson({
          request_id: command.request_id || null,
          error: 'transport_error',
          detail: err.message,
          diagnostics
        }),
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
