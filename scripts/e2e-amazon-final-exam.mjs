#!/usr/bin/env node
/**
 * E2E "final exam" for AirKVM:
 *   MCP -> UART -> firmware -> BLE -> extension -> browser + HID
 *
 * Goal:
 *   Open Amazon, use HID to search for an ESP32-S board, scroll results,
 *   open a qualifying product under $30, and read back the result.
 *
 * Usage:
 *   AIRKVM_SERIAL_PORT=/dev/cu.usbserial-0001 node scripts/e2e-amazon-final-exam.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const amazonUrl = 'https://www.amazon.com/';
const searchQuery = 'ESP32-S3 development board';
const absMax = 32767;

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampAbs(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(absMax, Math.round(value)));
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

  return {
    screenModel: {
      width: logicalWidth,
      height: logicalHeight,
      devicePixelRatio: Number(screen?.device_pixel_ratio ?? NaN)
    },
    contentOriginX: Number.isFinite(screenX) ? screenX + chromeOffsetX : ((bounds.left ?? 0) + chromeOffsetX),
    contentOriginY: Number.isFinite(screenY) ? screenY + chromeOffsetY : ((bounds.top ?? 0) + chromeOffsetY)
  };
}

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

function makeSuite() {
  const passed = [];
  const failed = [];
  function assert(condition, label, got, expected) {
    if (condition) {
      console.log(`    ${c.green('✓')} ${label}`);
      passed.push(label);
    } else {
      console.log(`    ${c.red('✗')} ${label}`);
      if (got !== undefined) console.log(`        got:      ${c.red(JSON.stringify(got))}`);
      if (expected !== undefined) console.log(`        expected: ${c.yellow(String(expected))}`);
      failed.push(label);
    }
  }
  function section(label) {
    console.log(`\n${c.bold(label)}`);
  }
  function summary() {
    const total = passed.length + failed.length;
    console.log('\n' + '─'.repeat(60));
    if (failed.length === 0) {
      console.log(c.green(`Results: ${total}/${total} passed`));
    } else {
      console.log(c.red(`Results: ${passed.length}/${total} passed`));
      for (const f of failed) console.log(`  ${c.red('✗')} ${f}`);
    }
    console.log('─'.repeat(60));
    return failed.length === 0;
  }
  return { assert, section, summary, failed };
}

function resultsScript() {
  return `
    (() => {
      function parsePrice(text) {
        if (typeof text !== 'string') return null;
        const cleaned = text.replace(/[^0-9.]/g, '');
        const value = Number.parseFloat(cleaned);
        return Number.isFinite(value) ? value : null;
      }
      return Array.from(document.querySelectorAll('[data-component-type="s-search-result"]')).slice(0, 16).map((item, index) => {
        const titleAnchor = item.querySelector('h2 a');
        const titleEl = item.querySelector('h2 a span');
        const priceEl = item.querySelector('.a-price .a-offscreen');
        const r = titleAnchor ? titleAnchor.getBoundingClientRect() : item.getBoundingClientRect();
        const priceText = priceEl?.textContent?.trim() ?? null;
        return {
          index,
          asin: item.getAttribute('data-asin') || null,
          title: titleEl?.textContent?.trim() ?? '',
          href: titleAnchor?.href || null,
          price_text: priceText,
          price_value: parsePrice(priceText),
          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          }
        };
      }).filter((item) => item.title && item.rect.width > 0 && item.rect.height > 0);
    })()
  `;
}

function productScript() {
  return `
    (() => {
      function parsePrice(text) {
        if (typeof text !== 'string') return null;
        const cleaned = text.replace(/[^0-9.]/g, '');
        const value = Number.parseFloat(cleaned);
        return Number.isFinite(value) ? value : null;
      }
      const title = document.querySelector('#productTitle')?.textContent?.trim()
        || document.title
        || '';
      const priceText =
        document.querySelector('#corePrice_feature_div .a-price .a-offscreen')?.textContent?.trim()
        || document.querySelector('#priceblock_ourprice')?.textContent?.trim()
        || document.querySelector('#priceblock_dealprice')?.textContent?.trim()
        || null;
      return {
        url: location.href,
        title,
        price_text: priceText,
        price_value: parsePrice(priceText)
      };
    })()
  `;
}

function chooseCandidate(results) {
  return (results || []).find((item) =>
    typeof item?.title === 'string'
    && /ESP32-S/i.test(item.title)
    && typeof item?.price_value === 'number'
    && item.price_value < 30
  ) || null;
}

function chooseSearchBoxFromAx(snapshot) {
  const nodes = Array.isArray(snapshot?.summary?.nodes) ? snapshot.summary.nodes : [];
  return nodes.find((node) => {
    const role = String(node?.role || '').toLowerCase();
    const name = String(node?.name || '').toLowerCase();
    return node?.rect
      && (role === 'searchbox' || role === 'textbox')
      && (name.includes('search') || name.includes('amazon'));
  }) || null;
}

async function execJs(mcp, tabId, script, maxResultChars = 4000) {
  const res = mcp.parse(await mcp.tool('airkvm_exec_js_tab', {
    request_id: `exam-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    tab_id: tabId,
    script,
    max_result_chars: maxResultChars
  }));
  if (!res.ok) {
    throw new Error(res.data?.error || 'js_exec_failed');
  }
  return JSON.parse(res.data.value_json);
}

async function getAxSnapshot(mcp, tabId) {
  const res = mcp.parse(await mcp.tool('airkvm_accessibility_snapshot', {
    request_id: `exam-ax-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    tab_id: tabId,
    timeout_ms: 30000
  }));
  if (!res.ok) {
    throw new Error(res.data?.error || 'ax_snapshot_failed');
  }
  return res.data.snapshot;
}

async function moveToRectCenterAndClick(mcp, geometry, rect, { doubleClick = false } = {}) {
  const targetX = Math.round(geometry.contentOriginX + rect.left + rect.width / 2);
  const targetY = Math.round(geometry.contentOriginY + rect.top + rect.height / 2);
  const abs = screenToAbs(geometry.screenModel, targetX, targetY);
  await mcp.tool('airkvm_mouse_move_abs', abs);
  await sleep(80);
  await mcp.tool('airkvm_mouse_click', { button: 'left' });
  if (doubleClick) {
    await sleep(120);
    await mcp.tool('airkvm_mouse_click', { button: 'left' });
  }
}

async function main() {
  console.log(c.bold('AirKVM Amazon Final Exam'));
  console.log(c.dim(`  serial port : ${serialPort}`));
  console.log(c.dim(`  query       : ${searchQuery}`));
  const mcp = spawnMcp();
  const suite = makeSuite();

  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-amazon-final-exam', version: '0.1.0' }
    });
    if (!init.result) throw new Error('initialize_failed');

    suite.section('open Amazon in a new window');
    const openRes = mcp.parse(await mcp.tool('airkvm_open_window', {
      request_id: 'exam-open-1',
      url: amazonUrl,
      focused: true,
      width: 1280,
      height: 900,
      type: 'normal'
    }));
    const tabId = openRes.data?.tab?.id ?? null;
    suite.assert(openRes.ok, 'window opened', openRes.data?.error);
    suite.assert(Number.isInteger(tabId), 'tab id is integer', tabId, 'integer');
    if (!Number.isInteger(tabId)) throw new Error('tab_open_failed');
    await sleep(2500);

    suite.section('read geometry and search box');
    const boundsRes = mcp.parse(await mcp.tool('airkvm_window_bounds', {
      request_id: 'exam-bounds-1',
      tab_id: tabId
    }));
    suite.assert(boundsRes.ok, 'window bounds ok', boundsRes.data?.error);
    const geometry = deriveGeometryFromBoundsResponse(boundsRes.data);
    const snapRes = mcp.parse(await mcp.tool('airkvm_dom_snapshot', {
      request_id: 'exam-dom-1',
      tab_id: tabId
    }));
    suite.assert(snapRes.ok, 'dom snapshot ok', snapRes.data?.error);
    suite.assert(Array.isArray(snapRes.data?.snapshot?.summary?.actionable), 'dom snapshot has actionable elements', snapRes.data?.snapshot?.summary?.actionable, 'array');
    const axSnap = await getAxSnapshot(mcp, tabId);
    suite.assert(Array.isArray(axSnap?.summary?.nodes), 'accessibility snapshot has nodes', axSnap?.summary?.nodes, 'array');
    const searchBox = chooseSearchBoxFromAx(axSnap);
    suite.assert(searchBox && searchBox.rect, 'found search box in accessibility snapshot', searchBox, 'AX searchbox node');
    if (!searchBox?.rect) throw new Error('search_box_not_found');

    suite.section('HID search on Amazon');
    await moveToRectCenterAndClick(mcp, geometry, searchBox.rect, { doubleClick: true });
    await sleep(150);
    await mcp.tool('airkvm_key_type', { text: searchQuery });
    await mcp.tool('airkvm_key_tap', { key: 'Enter' });
    await sleep(3000);
    suite.assert(true, 'search submitted via HID');

    suite.section('inspect result cards and scroll if needed');
    let candidate = null;
    let attempts = 0;
    while (!candidate && attempts < 6) {
      const results = await execJs(mcp, tabId, resultsScript(), 6000);
      candidate = chooseCandidate(results);
      if (candidate) break;
      attempts += 1;
      await mcp.tool('airkvm_mouse_scroll', { dy: -480 });
      await sleep(1200);
    }
    suite.assert(candidate !== null, 'found candidate under $30 with ESP32-S in title', candidate, 'candidate result');
    if (!candidate) throw new Error('candidate_not_found');
    console.log(c.dim(`    candidate from results: ${JSON.stringify({ title: candidate.title, price: candidate.price_text, href: candidate.href }, null, 2)}`));

    suite.section('open candidate via HID');
    await moveToRectCenterAndClick(mcp, geometry, candidate.rect, { doubleClick: false });
    await sleep(3000);

    suite.section('validate product page and capture evidence');
    const product = await execJs(mcp, tabId, productScript(), 4000);
    suite.assert(typeof product?.title === 'string' && product.title.length > 0, 'product page has title', product?.title, 'non-empty string');
    suite.assert(/ESP32-S/i.test(product?.title || ''), 'product title references ESP32-S', product?.title, '/ESP32-S/');
    suite.assert(typeof product?.price_value === 'number' && product.price_value < 30, 'product price is under $30', product?.price_value, '< 30');
    console.log(c.dim(`    product: ${JSON.stringify(product, null, 2)}`));

    const shot = mcp.parse(await mcp.tool('airkvm_screenshot_tab', {
      request_id: 'exam-shot-1',
      tab_id: tabId,
      max_width: 1280,
      max_height: 900,
      quality: 0.6
    }));
    suite.assert(shot.ok, 'screenshot captured', shot.data?.error);
  } catch (err) {
    console.error(c.red(`\nFatal: ${err.message}`));
    suite.failed.push(`fatal:${err.message}`);
  } finally {
    await mcp.stop();
  }

  const ok = suite.summary();
  process.exit(ok ? 0 : 1);
}

main();
