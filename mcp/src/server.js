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

function isScreenshotTool(name) {
  return name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop';
}

function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

function maybePersistScreenshot(name, data) {
  if (!isScreenshotTool(name)) return data;
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

    const command = tool.build(args);

    // Firmware-local control commands (HID, state, fw ops)
    if (tool.control) {
      transport.sendControlCommand(command).then((result) => {
        const isExplicitRejection = result?.msg && result.ok === false;
        if (isExplicitRejection) {
          send({
            jsonrpc: '2.0',
            id,
            result: makeToolResultText(`device rejected ${JSON.stringify(command)}: ${JSON.stringify(result.msg)}`),
            isError: true
          });
          return;
        }
        const isStateResponse = result?.msg?.type === 'state' && typeof result?.msg?.busy === 'boolean';
        if (command.type === 'state.request' && isStateResponse) {
          send({
            jsonrpc: '2.0',
            id,
            result: makeToolResultText(`forwarded ${JSON.stringify(command)}; state=${JSON.stringify(result.msg)}`)
          });
          return;
        }
        send({ jsonrpc: '2.0', id, result: makeToolResultText(`forwarded ${JSON.stringify(command)}`) });
      }).catch((err) => {
        send({
          jsonrpc: '2.0',
          id,
          result: makeToolResultText(`transport error: ${err.message}`),
          isError: true
        });
      });
      return;
    }

    // All other tools: bridge via half-pipe
    const timeoutMs = name === 'airkvm_dom_snapshot' ? 60000
      : (name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop') ? 30000
      : 30000;

    transport.sendRequest(command, { timeoutMs }).then((msg) => {
      if (!msg || msg.ok === false || msg.error) {
        send({
          jsonrpc: '2.0', id,
          result: makeToolResultJson({
            request_id: command.request_id || null,
            error: msg?.error || 'device_error',
            detail: msg
          }),
          isError: true
        });
        return;
      }

      let data;
      if (name === 'airkvm_dom_snapshot') {
        data = { request_id: command.request_id, snapshot: msg };
      } else if (isScreenshotTool(name)) {
        data = {
          request_id: command.request_id,
          source: msg.source || command.source,
          mime: msg.mime || 'image/jpeg',
          base64: msg.data || msg.base64 || '',
        };
      } else {
        data = msg;
      }

      send({
        jsonrpc: '2.0', id,
        result: makeToolResultJson(maybePersistScreenshot(name, data))
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
