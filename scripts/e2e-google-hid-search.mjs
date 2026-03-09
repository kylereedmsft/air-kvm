#!/usr/bin/env node
import { spawn } from 'node:child_process';

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTool(name, args = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn('node', ['scripts/mcp-tool-call.mjs', name, JSON.stringify(args)], {
      cwd: process.cwd(),
      env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort }
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.setEncoding('utf8');
    cp.stderr.setEncoding('utf8');
    cp.stdout.on('data', (chunk) => { stdout += chunk; });
    cp.stderr.on('data', (chunk) => { stderr += chunk; });
    cp.on('error', reject);
    cp.on('exit', (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

function extractToolText(rawStdout) {
  try {
    const parsed = JSON.parse(rawStdout);
    return parsed?.content?.[0]?.text || '';
  } catch {
    return rawStdout.trim();
  }
}

function isTransportError(text) {
  return text.includes('transport_error') || text.includes('transport error');
}

async function runWithRetry(name, args = {}, retries = 8, retryDelayMs = 350) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const { stdout, stderr, code, signal } = await runTool(name, args);
    const text = extractToolText(stdout);
    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
    process.stdout.write(`[${name}] attempt=${attempt} code=${code ?? 'null'} signal=${signal ?? 'none'} ${text}\n`);
    if (code !== 0 && !isTransportError(text)) {
      throw new Error(`${name}_tool_exit_${code ?? 'null'}`);
    }
    if (code === 0 && !isTransportError(text)) {
      return text;
    }
    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }
  throw new Error(`${name}_transport_error_persistent`);
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  await runWithRetry('airkvm_open_tab', {
    url: 'https://www.google.com',
    active: true
  });
  await sleep(1200);

  await runWithRetry('airkvm_screenshot_tab', {
    max_width: 1280,
    max_height: 720,
    quality: 0.7
  });

  const metricsText = await runWithRetry('airkvm_exec_js_tab', {
    script: [
      'return JSON.stringify((() => {',
      '  const el = document.querySelector(\'textarea[name="q"],input[name="q"]\');',
      '  if (!el) return { ok: false, reason: "search_not_found" };',
      '  const r = el.getBoundingClientRect();',
      '  const dx = Math.max(0, Math.round((window.outerWidth - window.innerWidth) / 2));',
      '  const dy = Math.max(0, Math.round(window.outerHeight - window.innerHeight));',
      '  return {',
      '    ok: true,',
      '    target_screen_x: Math.round(window.screenX + dx + r.left + r.width / 2),',
      '    target_screen_y: Math.round(window.screenY + dy + r.top + r.height / 2),',
      '    screenX: window.screenX,',
      '    screenY: window.screenY,',
      '    dx,',
      '    dy,',
      '    cx: Math.round(r.left + r.width / 2),',
      '    cy: Math.round(r.top + r.height / 2)',
      '  };',
      '})());'
    ].join('\n')
  });

  const metricsEnvelope = parseJsonText(metricsText);
  const metricsRaw = typeof metricsEnvelope?.value_json === 'string'
    ? JSON.parse(metricsEnvelope.value_json)
    : metricsEnvelope?.result || null;
  const metrics = typeof metricsRaw === 'string' ? JSON.parse(metricsRaw) : metricsRaw;
  if (!metrics?.ok) {
    throw new Error('search_metrics_not_found');
  }

  const targetX = metrics.target_screen_x;
  const targetY = metrics.target_screen_y;
  process.stdout.write(`target_screen=(${targetX},${targetY}) viewport_center=(${metrics.cx},${metrics.cy})\n`);

  await runWithRetry('airkvm_send', { command: { type: 'mouse.move_rel', dx: -10000, dy: -10000 } });
  await sleep(80);
  await runWithRetry('airkvm_send', { command: { type: 'mouse.move_rel', dx: targetX, dy: targetY } });
  await sleep(80);
  await runWithRetry('airkvm_send', { command: { type: 'mouse.click', button: 'left' } });
  await sleep(80);

  await runWithRetry('airkvm_send', { command: { type: 'key.type', text: 'Bluetooth' } });
  await runWithRetry('airkvm_send', { command: { type: 'key.tap', key: 'Enter' } });

  const tabsText = await runWithRetry('airkvm_list_tabs', {});
  process.stdout.write(`[tabs] ${tabsText}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.message || err)}\n`);
  process.exit(1);
});
