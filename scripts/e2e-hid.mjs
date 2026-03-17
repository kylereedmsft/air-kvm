#!/usr/bin/env node
/**
 * E2E HID integration test: MCP → UART → firmware → HID USB → target machine
 *
 * Requires:
 *   - AIRKVM_SERIAL_PORT set (or defaults to /dev/cu.usbserial-0001)
 *   - Extension loaded and connected to BLE in a Chromium-based browser
 *   - AirKVM device connected via USB HID to the target machine (same machine
 *     running the browser in this test setup)
 *
 * Test flow:
 *   1. Open https://example.com in a new tab
 *   2. Inject a textarea + 4 buttons via exec_js_tab
 *   3. Use window_bounds + getBoundingClientRect to compute screen coords
 *   4. Click each button via HID mouse (validates firmware HID mouse path)
 *   5. Verify each button's text appeared in the textarea
 *   6. Click inside the textarea via HID mouse
 *   7. Type all printable ASCII (0x20–0x7E) via key.type
 *   8. Verify textarea contains the typed characters
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');
const mcpDir    = path.join(repoRoot, 'mcp');

const serialPort   = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const testUrl      = 'https://example.com';
const absMin       = 0;
const absMax       = 32767;
const screenWidth  = parseInt(process.env.AIRKVM_SCREEN_WIDTH || '3024', 10);
const screenHeight = parseInt(process.env.AIRKVM_SCREEN_HEIGHT || '1964', 10);
const calPopupWidth = parseInt(process.env.AIRKVM_CAL_WIDTH || '1400', 10);
const calPopupHeight = parseInt(process.env.AIRKVM_CAL_HEIGHT || '1000', 10);
const calScanStep = parseInt(process.env.AIRKVM_CAL_ABS_SCAN_STEP || '1024', 10);
const calSettleMs = parseInt(process.env.AIRKVM_CAL_ABS_SETTLE_MS || '220', 10);
const postCdpSettleMs = parseInt(process.env.AIRKVM_POST_CDP_SETTLE_MS || '1500', 10);

// Printable ASCII: space (0x20) through tilde (0x7E)
const PRINTABLE_ASCII = Array.from({ length: 0x7E - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');

// ─── Colours ──────────────────────────────────────────────────────────────────

const c = {
  reset:  (s) => `\x1b[0m${s}\x1b[0m`,
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
};

// ─── MCP harness ──────────────────────────────────────────────────────────────

function spawnMcp() {
  const child = spawn('node', ['src/index.js'], {
    cwd: mcpDir,
    env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort },
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
        } catch { /* non-JSON */ }
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
      const timer = setTimeout(
        () => { waiting.delete(id); reject(new Error(`timeout:${method}`)); },
        toolTimeoutMs
      );
      waiting.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function tool(name, args = {}) {
    return rpc('tools/call', { name, arguments: args });
  }

  function parse(response) {
    const rawText = response?.result?.content?.[0]?.text ?? '';
    let data;
    try { data = JSON.parse(rawText); } catch { data = { _unparseable: rawText }; }
    const ok = !data?.error && !response?.isError;
    return { ok, data, rawText };
  }

  return { rpc, tool, parse, stop };
}

// ─── Test suite helpers ────────────────────────────────────────────────────────

function makeSuite() {
  const passed = [];
  const failed = [];

  function assert(condition, label, got, expected) {
    if (condition) {
      console.log(`    ${c.green('✓')} ${label}`);
      passed.push(label);
    } else {
      console.log(`    ${c.red('✗')} ${label}`);
      if (got !== undefined)      console.log(`        got:      ${c.red(JSON.stringify(got))}`);
      if (expected !== undefined) console.log(`        expected: ${c.yellow(String(expected))}`);
      failed.push(label);
    }
  }

  function section(label, raw) {
    const icon = failed.length === 0 ? c.green('✓') : c.red('✗');
    // Only show icon based on whether *this* section added failures — track before/after
    console.log(`\n${icon} ${c.bold(label)}`);
    if (raw !== undefined) {
      const display = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      const lines = display.split('\n');
      const trimmed = lines.length > 20 ? [...lines.slice(0, 20), '    ...(truncated)'] : lines;
      console.log(c.dim('    raw: ' + trimmed.join('\n         ')));
    }
  }

  function sectionResult(failsBefore) {
    // Reprint section header with correct icon based on failures added since last section
    return failed.length > failsBefore;
  }

  function summary() {
    const total = passed.length + failed.length;
    console.log('\n' + '─'.repeat(60));
    if (failed.length === 0) {
      console.log(c.green(`Results: ${total}/${total} passed`));
    } else {
      console.log(c.red(`Results: ${passed.length}/${total} passed`));
      console.log(c.red(`         ${failed.length} FAILED`));
      for (const f of failed) console.log(`  ${c.red('✗')} ${f}`);
    }
    console.log('─'.repeat(60));
    return failed.length === 0;
  }

  return { assert, section, sectionResult, summary, passed, failed };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampAbs(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(absMin, Math.min(absMax, Math.round(value)));
}

function screenToAbs(bounds, screenX, screenY) {
  if (Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0) {
    return {
      x: clampAbs((screenX / screenWidth) * absMax),
      y: clampAbs((screenY / screenHeight) * absMax)
    };
  }
  function interp(target, lowScreen, highScreen, lowAbs, highAbs) {
    const spanScreen = highScreen - lowScreen;
    const spanAbs = highAbs - lowAbs;
    if (!Number.isFinite(spanScreen) || !Number.isFinite(spanAbs) || spanScreen === 0) {
      return clampAbs((lowAbs + highAbs) / 2);
    }
    return clampAbs(lowAbs + ((target - lowScreen) * spanAbs / spanScreen));
  }
  return {
    x: interp(screenX, bounds.left.screen_x, bounds.right.screen_x, bounds.left.abs, bounds.right.abs),
    y: interp(screenY, bounds.top.screen_y, bounds.bottom.screen_y, bounds.top.abs, bounds.bottom.abs)
  };
}

async function calibrateAbsoluteMap(mcp, reqNum) {
  const { tool, parse } = mcp;
  const sessionId = `e2e-hid-cal-${Date.now()}`;

  const opened = parse(await tool('airkvm_open_calibration_window', {
    request_id: reqNum(),
    session_id: sessionId,
    focused: true,
    width: calPopupWidth,
    height: calPopupHeight
  })).data;
  if (opened?.error) throw new Error(`calibration_open_failed:${opened.error}`);
  const popupBounds = opened?.window?.bounds || null;

  async function status(label) {
    return parse(await tool('airkvm_calibration_status', { request_id: `${reqNum()}-${label}` })).data;
  }

  async function moveAbs(x, y, label) {
    parse(await tool('airkvm_mouse_move_abs', { x: clampAbs(x), y: clampAbs(y) }));
    await sleep(calSettleMs);
    return status(label);
  }

  async function scanBoundary({ axis, startAbs, endAbs, fixedAbs, direction, label }) {
    let lastCount = Number((await status(`${label}-baseline`))?.event_count || 0);
    let cursor = startAbs;
    let firstProbe = true;
    while ((direction > 0 && cursor <= endAbs) || (direction < 0 && cursor >= endAbs)) {
      const point = axis === 'x'
        ? { x: cursor, y: fixedAbs }
        : { x: fixedAbs, y: cursor };
      const next = await moveAbs(point.x, point.y, `${label}-${cursor}`);
      const count = Number(next?.event_count || 0);
      const changed = count > lastCount;
      console.log(c.dim(`    calibration ${label}: abs=(${point.x},${point.y}) changed=${changed} client=(${next?.event?.client_x ?? 'null'},${next?.event?.client_y ?? 'null'})`));
      if (firstProbe && changed) {
        throw new Error(`calibration_invalid_start:${label}`);
      }
      firstProbe = false;
      lastCount = count;
      if (changed) {
        return {
          abs: axis === 'x' ? point.x : point.y,
          client_x: Number(next?.event?.client_x),
          client_y: Number(next?.event?.client_y),
          screen_x: Number(next?.event?.screen_x),
          screen_y: Number(next?.event?.screen_y),
          status: next
        };
      }
      cursor += direction > 0 ? calScanStep : -calScanStep;
    }
    throw new Error(`calibration_boundary_failed:${label}`);
  }

  const centerAbs = 16384;
  const left = await scanBoundary({ axis: 'x', startAbs: 0, endAbs: absMax, fixedAbs: centerAbs, direction: 1, label: 'left' });
  const right = await scanBoundary({ axis: 'x', startAbs: absMax, endAbs: absMin, fixedAbs: centerAbs, direction: -1, label: 'right' });
  const midAbsX = clampAbs((left.abs + right.abs) / 2);
  const top = await scanBoundary({ axis: 'y', startAbs: 0, endAbs: absMax, fixedAbs: midAbsX, direction: 1, label: 'top' });
  const bottom = await scanBoundary({ axis: 'y', startAbs: absMax, endAbs: absMin, fixedAbs: midAbsX, direction: -1, label: 'bottom' });

  const bounds = { left, right, top, bottom };
  const layout = bottom.status?.layout || top.status?.layout || right.status?.layout || left.status?.layout;
  if (!layout) throw new Error('calibration_layout_missing');

  const doneAbs = screenToAbs(bounds, Number(layout.done_center_x) + (left.screen_x - left.client_x), Number(layout.done_center_y) + (top.screen_y - top.client_y));
  const doneStatus = await moveAbs(doneAbs.x, doneAbs.y, 'done-center');
  const doneClientX = Number(doneStatus?.event?.client_x);
  const doneClientY = Number(doneStatus?.event?.client_y);
  const doneScreenX = Number(doneStatus?.event?.screen_x);
  const doneScreenY = Number(doneStatus?.event?.screen_y);
  const doneLeft = Number(layout?.done_left);
  const doneTop = Number(layout?.done_top);
  const doneWidth = Number(layout?.done_width);
  const doneHeight = Number(layout?.done_height);
  const expectedDoneScreenX = Number(layout.done_center_x) + (left.screen_x - left.client_x);
  const expectedDoneScreenY = Number(layout.done_center_y) + (top.screen_y - top.client_y);
  console.log(c.dim(`    calibration done screen error: (${doneScreenX - expectedDoneScreenX}, ${doneScreenY - expectedDoneScreenY})`));
  const withinDone = Number.isFinite(doneClientX) &&
    Number.isFinite(doneClientY) &&
    doneClientX >= doneLeft &&
    doneClientX <= (doneLeft + doneWidth) &&
    doneClientY >= doneTop &&
    doneClientY <= (doneTop + doneHeight);
  if (!withinDone) {
    throw new Error(`calibration_done_not_confirmed:${doneClientX},${doneClientY}`);
  }
  parse(await tool('airkvm_mouse_click', { button: 'left' }));
  await sleep(300);
  const finalStatus = await status('done-final');
  if (!finalStatus?.done_clicked) throw new Error('calibration_done_click_failed');

  console.log(c.dim(`    calibration bounds x:[${left.abs},${right.abs}] y:[${top.abs},${bottom.abs}]`));
  const screenLeft = left.screen_x - left.client_x;
  const screenTop = top.screen_y - top.client_y;
  return {
    bounds,
    screenLeft,
    screenTop,
    chromeOffsetX: Number.isFinite(popupBounds?.left) ? screenLeft - popupBounds.left : null,
    chromeOffsetY: Number.isFinite(popupBounds?.top) ? screenTop - popupBounds.top : null,
    screenModel: {
      width: screenWidth,
      height: screenHeight
    }
  };
}

// ─── JS injection strings (no backticks — these are embedded in template literals) ──

function makeInjectScript() {
  return `
(function() {
  // Remove any previous test fixture
  var old = document.getElementById('airkvm-hid-fixture');
  if (old) old.parentNode.removeChild(old);
  window.__airkvmHid = {
    clicks: [],
    lastClick: null
  };

  var fixture = document.createElement('div');
  fixture.id = 'airkvm-hid-fixture';
  fixture.style.cssText = 'position:fixed;top:20px;left:20px;z-index:999999;background:#fff;padding:16px;border:2px solid #333;font-family:monospace;';

  var textarea = document.createElement('textarea');
  textarea.id = 'airkvm-hid-output';
  textarea.rows = 8;
  textarea.cols = 60;
  textarea.style.cssText = 'display:block;margin-bottom:8px;font-size:12px;';
  textarea.addEventListener('click', function() {
    window.__airkvmHid.lastClick = {
      id: 'airkvm-hid-output',
      text: 'textarea'
    };
    window.__airkvmHid.clicks.push(window.__airkvmHid.lastClick);
  });
  fixture.appendChild(textarea);

  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;';

  for (var i = 1; i <= 4; i++) {
    (function(n) {
      var btn = document.createElement('button');
      btn.id = 'airkvm-hid-btn-' + n;
      btn.textContent = 'Button ' + n;
      btn.style.cssText = 'padding:8px 16px;font-size:14px;cursor:pointer;';
      btn.addEventListener('click', function() {
        window.__airkvmHid.lastClick = {
          id: btn.id,
          text: btn.textContent
        };
        window.__airkvmHid.clicks.push(window.__airkvmHid.lastClick);
        document.getElementById('airkvm-hid-output').value += 'Button ' + n + ' Pressed\\n';
      });
      btnRow.appendChild(btn);
    })(i);
  }

  fixture.appendChild(btnRow);
  fixture.addEventListener('click', function(event) {
    if (event.target === fixture || event.target === btnRow) {
      window.__airkvmHid.lastClick = {
        id: event.target.id || 'fixture-container',
        text: event.target.textContent || ''
      };
      window.__airkvmHid.clicks.push(window.__airkvmHid.lastClick);
    }
  });
  document.body.appendChild(fixture);

  return 'injected';
})()
`.trim();
}

function makeGetTextareaScript() {
  return `
(function() {
  var el = document.getElementById('airkvm-hid-output');
  return {
    value: el ? el.value : null,
    hid: window.__airkvmHid || null
  };
})()
`.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runTests(mcp, suite) {
  const { tool, parse } = mcp;
  const reqNum = (() => { let n = 0; return () => `hid-${++n}`; })();

  // ── 1. Open tab ──────────────────────────────────────────────────────────────
  suite.section('open_tab: https://example.com');
  const openRes = parse(await tool('airkvm_open_tab', { request_id: reqNum(), url: testUrl }));
  const tabId = openRes.data?.tab?.id ?? null;
  suite.assert(!openRes.data?.error, 'no error', openRes.data?.error);
  suite.assert(Number.isInteger(tabId), 'tab.id is integer', tabId, 'integer');
  suite.assert(openRes.data?.tab?.active === true, 'tab is active');
  if (!Number.isInteger(tabId)) throw new Error('Cannot continue without a valid tab ID');

  await sleep(500); // let page settle

  // ── 2. Inject fixture ────────────────────────────────────────────────────────
  suite.section('inject fixture: textarea + 4 buttons');
  const injectRes = parse(await tool('airkvm_exec_js_tab', {
    request_id: reqNum(), tab_id: tabId, script: makeInjectScript()
  }));
  suite.assert(!injectRes.data?.error, 'no error', injectRes.data?.error
    ? `${injectRes.data.error} — ${injectRes.data.detail ?? '(no detail)'}` : undefined);
  console.log(c.dim(`    inject value_json: ${injectRes.data?.value_json}`));
  suite.assert(injectRes.data?.value_json === '"injected"', 'fixture injected', injectRes.data?.value_json, '"injected"');

  // ── 3. Get window bounds + gather element rects ──────────────────────────────
  // window_bounds uses chrome.windows API (no CDP banner), then exec_js gets rects.
  // After exec_js returns, the CDP banner disappears before any HID actions.
  suite.section('get window bounds');
  const boundsRes = parse(await tool('airkvm_window_bounds', {
    request_id: reqNum(), tab_id: tabId
  }));
  console.log(c.dim(`    bounds raw: ${boundsRes.rawText?.slice(0, 200)}`));
  suite.assert(!boundsRes.data?.error, 'no error', boundsRes.data?.error);
  const bounds = boundsRes.data?.bounds;
  suite.assert(bounds != null, 'bounds received', bounds, 'object');
  const winLeft = bounds?.left ?? 0;
  const winTop  = bounds?.top  ?? 0;
  console.log(c.dim(`    window screen origin: (${winLeft}, ${winTop})`));

  suite.section('gather element rects');
  const gatherScript = `
(function() {
  function rect(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return {
    toolbarHeight: window.outerHeight - window.innerHeight,
    btn1: rect('airkvm-hid-btn-1'),
    btn2: rect('airkvm-hid-btn-2'),
    btn3: rect('airkvm-hid-btn-3'),
    btn4: rect('airkvm-hid-btn-4'),
    textarea: rect('airkvm-hid-output')
  };
})()`.trim();

  const gatherRes = parse(await tool('airkvm_exec_js_tab', {
    request_id: reqNum(), tab_id: tabId, script: gatherScript, max_result_chars: 700
  }));
  suite.assert(!gatherRes.data?.error, 'no error', gatherRes.data?.error);
  const layout = gatherRes.data?.value_json ? JSON.parse(gatherRes.data.value_json) : null;
  suite.assert(layout !== null, 'layout gathered');
  const toolbarHeight = layout?.toolbarHeight ?? 0;
  console.log(c.dim(`    toolbar height: ${toolbarHeight}px`));
  // viewport top = window top + toolbar height; CDP banner is gone now.

  // ── 4. Absolute calibration ──────────────────────────────────────────────────
  suite.section('post-CDP settle');
  console.log(c.dim(`    waiting ${postCdpSettleMs}ms for debugger/banner state to clear before calibration`));
  await sleep(postCdpSettleMs);
  suite.assert(true, 'settle wait completed');

  suite.section('absolute calibration: popup bounds + DONE');
  const absCalibration = await calibrateAbsoluteMap(mcp, reqNum);
  suite.assert(absCalibration != null, 'absolute calibration completed');
  console.log(c.dim(`    calibration content origin: (${absCalibration.screenLeft}, ${absCalibration.screenTop})`));
  console.log(c.dim(`    calibration chrome offsets: (${absCalibration.chromeOffsetX}, ${absCalibration.chromeOffsetY})`));

  // ── 5. HID mouse actions ──────────────────────────────────────────────────────
  // Important: do not issue any further exec_js_tab calls once HID interaction
  // starts. On macOS/Chromium the active debugger infobar appears at the top of
  // the page during CDP work and shifts content, which invalidates the rects we
  // just measured for HID targeting.
  const contentOriginX = Number.isFinite(absCalibration.chromeOffsetX)
    ? winLeft + absCalibration.chromeOffsetX
    : winLeft;
  const contentOriginY = Number.isFinite(absCalibration.chromeOffsetY)
    ? winTop + absCalibration.chromeOffsetY
    : (winTop + toolbarHeight);
  console.log(c.dim(`    calibrated real-tab content origin: (${contentOriginX}, ${contentOriginY})`));
  for (let i = 1; i <= 4; i++) {
    suite.section(`HID click: Button ${i}`);
    const rect = layout?.[`btn${i}`];
    suite.assert(rect !== null, `btn${i} rect found`, rect, 'object');
    if (!rect) continue;

    const targetX = Math.round(contentOriginX + rect.left + rect.width  / 2);
    const targetY = Math.round(contentOriginY + rect.top  + rect.height / 2);
    console.log(c.dim(`    btn${i} screen coords: (${targetX}, ${targetY})`));
    const abs = screenToAbs(absCalibration.bounds, targetX, targetY);
    await tool('airkvm_mouse_move_abs', abs);
    await tool('airkvm_mouse_click', { button: 'left' });
    await sleep(80);
  }

  // ── 6. Click textarea and type all printable ASCII ───────────────────────────
  suite.section('HID mouse: click into textarea');
  const taRect = layout?.textarea;
  suite.assert(taRect !== null, 'textarea rect found', taRect, 'object');

  if (taRect) {
    const taX = Math.round(contentOriginX + taRect.left + taRect.width  / 2);
    const taY = Math.round(contentOriginY + taRect.top  + taRect.height / 2);
    console.log(c.dim(`    textarea screen coords: (${taX}, ${taY})`));
    const abs = screenToAbs(absCalibration.bounds, taX, taY);
    await tool('airkvm_mouse_move_abs', abs);
    await tool('airkvm_mouse_click', { button: 'left' });
    await sleep(80);
  }

  // ── 7. Type printable ASCII ───────────────────────────────────────────────────
  suite.section('HID key.type: all printable ASCII (0x20–0x7E)');
  const chunkSize = 200;
  for (let offset = 0; offset < PRINTABLE_ASCII.length; offset += chunkSize) {
    await tool('airkvm_key_type', { text: PRINTABLE_ASCII.slice(offset, offset + chunkSize) });
  }

  // ── 8. Validate via CDP ───────────────────────────────────────────────────────
  // This re-enters the debugger path intentionally after HID is finished.
  suite.section('validate: textarea contains button presses + ASCII');
  const finalRes = parse(await tool('airkvm_exec_js_tab', {
    request_id: reqNum(), tab_id: tabId,
    script: makeGetTextareaScript(),
    max_result_chars: 700
  }));
  suite.assert(!finalRes.data?.error, 'no error reading textarea', finalRes.data?.error);

  const rawContent = finalRes.data?.value_json ? JSON.parse(finalRes.data.value_json) : null;
  const finalContent = typeof rawContent?.value === 'string' ? rawContent.value : '';
  const hidDebug = rawContent?.hid || null;
  suite.assert(finalContent.length > 0, 'textarea is non-empty');

  for (let i = 1; i <= 4; i++) {
    suite.assert(
      finalContent.includes(`Button ${i} Pressed`),
      `contains "Button ${i} Pressed"`,
      null, `Button ${i} Pressed`
    );
  }

  for (const ch of [' ', 'A', 'z', '~', '0', '!']) {
    suite.assert(
      finalContent.includes(ch),
      `contains char ${JSON.stringify(ch)} (0x${ch.charCodeAt(0).toString(16).padStart(2, '0')})`,
      null, ch
    );
  }

  console.log(c.dim(`    textarea length: ${finalContent.length} chars`));
  console.log(c.dim(`    textarea preview: ${JSON.stringify(finalContent.slice(0, 80))}`));
  console.log(c.dim(`    last recorded click: ${JSON.stringify(hidDebug?.lastClick ?? null)}`));
  console.log(c.dim(`    click log: ${JSON.stringify(hidDebug?.clicks ?? [])}`));
}

async function main() {
  console.log(c.bold('AirKVM HID E2E Test Suite'));
  console.log(c.dim(`  serial port : ${serialPort}`));
  console.log(c.dim(`  test URL    : ${testUrl}`));
  console.log(c.dim(`  timeout     : ${toolTimeoutMs}ms per tool`));

  const mcp   = spawnMcp();
  const suite = makeSuite();

  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-hid', version: '0.1.0' }
    });
    if (!init.result) throw new Error('MCP initialize failed');
    console.log(c.dim('  MCP initialized\n'));

    await runTests(mcp, suite);
  } catch (err) {
    console.error(c.red(`\nFatal: ${err.message}`));
    suite.failed.push(`fatal: ${err.message}`);
  } finally {
    await mcp.stop();
  }

  const ok = suite.summary();
  process.exit(ok ? 0 : 1);
}

main();
