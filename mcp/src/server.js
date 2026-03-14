import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getTool,
  listTools,
  validateArgs
} from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const kTempDir = path.resolve(__dirname, '../../temp'); // TODO: parameter

function makeToolResultText(text) {
  return { content: [{ type: 'text', text }] };
}

function makeToolResultJson(payload) {
  return makeToolResultText(JSON.stringify(payload));
}

function sanitizeSegment(value, fallback) {
  const text = typeof value === 'string' && value.length > 0 ? value : fallback;
  return text.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

function maybePersistScreenshot(data) {
  if (process.env.AIRKVM_SAVE_SCREENSHOTS !== '1') return data;
  if (!data || typeof data.base64 !== 'string' || data.base64.length === 0) return data;
  try {
    // TODO(kyle): Remove test-only screenshot autosave once b64z transfer reliability validation is complete.
    fs.mkdirSync(kTempDir, { recursive: true });
    const ext = extensionForMime(data.mime);
    const source = sanitizeSegment(data.source || 'unknown', 'unknown');
    const requestId = sanitizeSegment(data.request_id || 'screenshot', 'screenshot');
    const filePath = path.join(kTempDir, `${requestId}-${source}-${Date.now()}.${ext}`);
    const bytes = Buffer.from(data.base64, 'base64');
    fs.writeFileSync(filePath, bytes);
    return { ...data, saved_path: filePath, saved_bytes: bytes.length };
  } catch (err) {
    return { ...data, save_error: String(err?.message || err) };
  }
}

function prepareToolResult(tool, command, data) {
  const shaped = tool.formatData ? tool.formatData(command, data) : data;
  return maybePersistScreenshot(shaped);
}

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
        result: makeToolResultJson(prepareToolResult(tool, command, data))
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
