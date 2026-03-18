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
 *   2. Inject a textarea + 4 buttons via inject_js_tab
 *   3. Use window_bounds + getBoundingClientRect to compute screen coords
 *   4. Click each button via HID mouse (validates firmware HID mouse path)
 *   5. Verify each button's text appeared in a separate log area
 *   6. Click inside the textarea twice via HID mouse
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

function screenToAbs(screenModel, screenX, screenY) {
  return {
    x: clampAbs((screenX / screenModel.width) * absMax),
    y: clampAbs((screenY / screenModel.height) * absMax)
  };
}

function deriveGeometryFromBoundsResponse(boundsData) {
  const bounds = boundsData?.bounds || null;
  const screen = boundsData?.screen || null;
  const logicalWidth = Number(screen?.screen?.width);
  const logicalHeight = Number(screen?.screen?.height);
  const screenX = Number(screen?.viewport?.screen_x);
  const screenY = Number(screen?.viewport?.screen_y);
  const outerWidth = Number(screen?.viewport?.outer_width);
  const outerHeight = Number(screen?.viewport?.outer_height);
  const innerWidth = Number(screen?.viewport?.inner_width);
  const innerHeight = Number(screen?.viewport?.inner_height);

  if (!bounds || !Number.isFinite(logicalWidth) || !Number.isFinite(logicalHeight)) {
    throw new Error('window_bounds_screen_metrics_missing');
  }

  const chromeOffsetX = Number.isFinite(outerWidth) && Number.isFinite(innerWidth)
    ? Math.max(0, Math.round((outerWidth - innerWidth) / 2))
    : 0;
  const chromeOffsetY = Number.isFinite(outerHeight) && Number.isFinite(innerHeight)
    ? Math.max(0, Math.round(outerHeight - innerHeight))
    : 0;

  const contentOriginX = Number.isFinite(screenX)
    ? screenX + chromeOffsetX
    : ((bounds.left ?? 0) + chromeOffsetX);
  const contentOriginY = Number.isFinite(screenY)
    ? screenY + chromeOffsetY
    : ((bounds.top ?? 0) + chromeOffsetY);

  return {
    screenModel: {
      width: logicalWidth,
      height: logicalHeight,
      devicePixelRatio: Number(screen?.device_pixel_ratio ?? NaN)
    },
    contentOriginX,
    contentOriginY,
    chromeOffsetX,
    chromeOffsetY
  };
}

// ─── JS injection strings (no backticks — these are embedded in template literals) ──

function makeInjectScript() {
  return JSON.stringify({ __airkvm_inject: true, op: 'hid_fixture.inject' });
}

function makeLayoutScript() {
  return JSON.stringify({ __airkvm_inject: true, op: 'hid_fixture.layout' });
}

function makeGetTextareaScript() {
  return JSON.stringify({ __airkvm_inject: true, op: 'hid_fixture.read' });
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
  const injectRes = parse(await tool('airkvm_inject_js_tab', {
    request_id: reqNum(), tab_id: tabId, script: makeInjectScript()
  }));
  suite.assert(!injectRes.data?.error, 'no error', injectRes.data?.error
    ? `${injectRes.data.error} — ${injectRes.data.detail ?? '(no detail)'}` : undefined);
  console.log(c.dim(`    inject value_json: ${injectRes.data?.value_json}`));
  suite.assert(injectRes.data?.value_json === '"injected"', 'fixture injected', injectRes.data?.value_json, '"injected"');
  if (injectRes.data?.error || injectRes.data?.value_json !== '"injected"') {
    throw new Error('fixture_injection_failed');
  }

  // ── 3. Get window bounds + gather element rects ──────────────────────────────
  // window_bounds uses chrome.windows API and rect gather uses inject_js_tab, so
  // neither step should trigger the CDP debugger infobar.
  suite.section('get window bounds');
  const boundsRes = parse(await tool('airkvm_window_bounds', {
    request_id: reqNum(), tab_id: tabId
  }));
  console.log(c.dim(`    bounds raw: ${boundsRes.rawText?.slice(0, 200)}`));
  suite.assert(!boundsRes.data?.error, 'no error', boundsRes.data?.error);
  const bounds = boundsRes.data?.bounds;
  suite.assert(bounds != null, 'bounds received', bounds, 'object');
  const geometry = deriveGeometryFromBoundsResponse(boundsRes.data);
  console.log(c.dim(`    window screen origin: (${bounds?.left ?? 0}, ${bounds?.top ?? 0})`));
  console.log(c.dim(`    logical screen: ${geometry.screenModel.width}x${geometry.screenModel.height} @ DPR ${geometry.screenModel.devicePixelRatio}`));
  console.log(c.dim(`    derived content origin: (${geometry.contentOriginX}, ${geometry.contentOriginY})`));

  suite.section('gather element rects');
  const gatherRes = parse(await tool('airkvm_inject_js_tab', {
    request_id: reqNum(), tab_id: tabId, script: makeLayoutScript(), max_result_chars: 700
  }));
  suite.assert(!gatherRes.data?.error, 'no error', gatherRes.data?.error);
  const layout = gatherRes.data?.value_json ? JSON.parse(gatherRes.data.value_json) : null;
  suite.assert(layout !== null, 'layout gathered');
  if (gatherRes.data?.error || layout === null) {
    throw new Error('fixture_layout_failed');
  }
  const toolbarHeight = layout?.toolbarHeight ?? 0;
  console.log(c.dim(`    toolbar height: ${toolbarHeight}px`));

  // ── 4. HID mouse actions ──────────────────────────────────────────────────────
  // Important: do not issue any CDP-backed exec_js_tab calls once HID starts.
  // This test path uses inject_js_tab for pre/post DOM work to avoid debugger UI.
  const contentOriginX = geometry.contentOriginX;
  const contentOriginY = geometry.contentOriginY;
  // ── 5. Click textarea twice: first click raises/focuses the window, second
  // places the caret in the textarea. This is still environment-sensitive if
  // another window is covering the browser, but it is the most reliable flow
  // we have with HID-only input.
  suite.section('HID mouse: focus + click into textarea');
  const taRect = layout?.textarea;
  suite.assert(taRect !== null, 'textarea rect found', taRect, 'object');

  if (taRect) {
    const taX = Math.round(contentOriginX + taRect.left + taRect.width  / 2);
    const taY = Math.round(contentOriginY + taRect.top  + taRect.height / 2);
    console.log(c.dim(`    textarea screen coords: (${taX}, ${taY})`));
    const abs = screenToAbs(geometry.screenModel, taX, taY);
    await tool('airkvm_mouse_move_abs', abs);
    await sleep(50);
    await tool('airkvm_mouse_click', { button: 'left' });
    await sleep(120);
    await tool('airkvm_mouse_click', { button: 'left' });
    await sleep(120);
  }

  // ── 6. Type printable ASCII ───────────────────────────────────────────────────
  suite.section('HID key.type: all printable ASCII (0x20–0x7E)');
  const chunkSize = 200;
  for (let offset = 0; offset < PRINTABLE_ASCII.length; offset += chunkSize) {
    await tool('airkvm_key_type', { text: PRINTABLE_ASCII.slice(offset, offset + chunkSize) });
  }

  // ── 7. Click buttons after typing so later selection/click behavior cannot
  // wipe out the typed payload.
  for (let i = 1; i <= 4; i++) {
    suite.section(`HID click: Button ${i}`);
    const rect = layout?.[`btn${i}`];
    suite.assert(rect !== null, `btn${i} rect found`, rect, 'object');
    if (!rect) continue;

    const targetX = Math.round(contentOriginX + rect.left + rect.width  / 2);
    const targetY = Math.round(contentOriginY + rect.top  + rect.height / 2);
    console.log(c.dim(`    btn${i} screen coords: (${targetX}, ${targetY})`));
    const abs = screenToAbs(geometry.screenModel, targetX, targetY);
    await tool('airkvm_mouse_move_abs', abs);
    await sleep(50);
    await tool('airkvm_mouse_click', { button: 'left' });
    await sleep(80);
  }

  // ── 8. Validate via silent injection ──────────────────────────────────────────
  suite.section('validate: textarea contains ASCII and log contains button presses');
  const finalRes = parse(await tool('airkvm_inject_js_tab', {
    request_id: reqNum(), tab_id: tabId,
    script: makeGetTextareaScript(),
    max_result_chars: 700
  }));
  suite.assert(!finalRes.data?.error, 'no error reading textarea', finalRes.data?.error);

  const rawContent = finalRes.data?.value_json ? JSON.parse(finalRes.data.value_json) : null;
  const finalContent = typeof rawContent?.value === 'string' ? rawContent.value : '';
  const finalLog = typeof rawContent?.log === 'string' ? rawContent.log : '';
  const hidDebug = rawContent?.hid || null;
  suite.assert(finalContent.length > 0, 'textarea is non-empty');
  suite.assert(finalLog.length > 0, 'button log is non-empty');

  for (let i = 1; i <= 4; i++) {
    suite.assert(
      finalLog.includes(`Button ${i} Pressed`),
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
  console.log(c.dim(`    button log preview: ${JSON.stringify(finalLog.slice(0, 120))}`));
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
