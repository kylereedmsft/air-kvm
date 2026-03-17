#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = Number.parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const popupWidth = Number.parseInt(process.env.AIRKVM_CAL_WIDTH || '1200', 10);
const popupHeight = Number.parseInt(process.env.AIRKVM_CAL_HEIGHT || '900', 10);

const probePoints = [
  { label: 'mid', x: 16384, y: 16384 },
  { label: 'tl', x: 0, y: 0 },
  { label: 'tr', x: 32767, y: 0 },
  { label: 'bl', x: 0, y: 32767 },
  { label: 'br', x: 32767, y: 32767 },
  { label: 'done-ish', x: 16384, y: 20000 }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnMcp() {
  const child = spawn('node', ['src/index.js'], {
    cwd: mcpDir,
    env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort }
  });

  const waiting = new Map();
  let carry = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    carry += chunk;
    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && waiting.has(msg.id)) {
            const { resolve } = waiting.get(msg.id);
            waiting.delete(msg.id);
            resolve(msg);
          }
        } catch {}
      }
      nl = carry.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  function stop() {
    return new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 800);
    });
  }

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`timeout:${method}`));
      }, toolTimeoutMs);
      waiting.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function tool(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    const rawText = response?.result?.content?.[0]?.text ?? '';
    try {
      return JSON.parse(rawText);
    } catch {
      throw new Error(`bad_json:${name}:${rawText}`);
    }
  }

  return { rpc, tool, stop };
}

async function main() {
  const mcp = spawnMcp();
  const sessionId = `cal-abs-${Date.now()}`;
  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'calibration-abs-probe', version: '0.1.0' }
    });
    if (!init.result) throw new Error('mcp_initialize_failed');

    const opened = await mcp.tool('airkvm_open_calibration_window', {
      request_id: 'abs-probe-open',
      session_id: sessionId,
      focused: true,
      width: popupWidth,
      height: popupHeight
    });
    console.log(JSON.stringify({ phase: 'opened', opened }, null, 2));

    for (const point of probePoints) {
      await mcp.tool('airkvm_mouse_move_abs', { x: point.x, y: point.y });
      await sleep(220);
      const status = await mcp.tool('airkvm_calibration_status', {
        request_id: `abs-probe-${point.label}`
      });
      console.log(JSON.stringify({
        phase: 'probe',
        label: point.label,
        requested: { x: point.x, y: point.y },
        status
      }, null, 2));
    }
  } finally {
    await mcp.stop();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
