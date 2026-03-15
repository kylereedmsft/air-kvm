#!/usr/bin/env node
/**
 * E2E browser integration test: MCP → UART → FW → BLE → Extension → browser
 *
 * Runs against a live firmware + extension. Requires:
 *   - AIRKVM_SERIAL_PORT set (or defaults to /dev/cu.usbserial-0001)
 *   - Extension loaded and connected to BLE in a Chromium-based browser
 *
 * Steps:
 *   1. open_tab       – open https://example.com in a new tab
 *   2. list_tabs      – list open tabs and confirm example.com is present
 *   3. window_bounds  – get the browser window dimensions
 *   4. dom_snapshot   – snapshot the DOM of the example.com tab
 *   5. exec_js_tab    – run JS in the tab and validate the return value
 *   6. screenshot_tab – capture a screenshot of the tab
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');
const tempDir = path.join(repoRoot, 'temp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);

function run() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/index.js'], {
      cwd: mcpDir,
      env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort },
    });

    const waiting = new Map();
    let stdoutCarry = '';
    let nextId = 1;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutCarry += chunk;
      let nl = stdoutCarry.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutCarry.slice(0, nl);
        stdoutCarry = stdoutCarry.slice(nl + 1);
        if (!line.trim()) { nl = stdoutCarry.indexOf('\n'); continue; }
        let msg;
        try { msg = JSON.parse(line); } catch { nl = stdoutCarry.indexOf('\n'); continue; }
        if (typeof msg.id !== 'undefined' && waiting.has(msg.id)) {
          const done = waiting.get(msg.id);
          waiting.delete(msg.id);
          done(msg);
        }
        nl = stdoutCarry.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);

    function stopChild() {
      return new Promise((done) => {
        child.once('exit', done);
        child.kill('SIGINT');
        setTimeout(() => child.kill('SIGKILL'), 800);
      });
    }

    function rpc(method, params = {}) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(
          () => { waiting.delete(id); rej(new Error(`rpc_timeout:${method}`)); },
          toolTimeoutMs
        );
        waiting.set(id, (msg) => { clearTimeout(timer); res(msg); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    function tool(name, args = {}) {
      return rpc('tools/call', { name, arguments: args });
    }

    function parseResult(response, toolName) {
      const text = response?.result?.content?.[0]?.text || '';
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`${toolName}_bad_json:${text}`); }
      if (data?.error) throw new Error(`${toolName}_error:${JSON.stringify(data)}`);
      return data;
    }

    function pass(step, detail = '') {
      console.log(`  ✓ ${step}${detail ? ': ' + detail : ''}`);
    }

    async function main() {
      // Initialize
      const init = await rpc('initialize', {});
      if (!init.result) throw new Error('initialize_failed');

      console.log('\nRunning E2E browser integration test...\n');

      // 1. Open tab
      const openRes = parseResult(await tool('airkvm_open_tab', { request_id: 'e2e-open-1', url: 'https://example.com' }), 'open_tab');
      const tabId = openRes.tab?.id ?? openRes.tab_id ?? openRes.tabId ?? openRes.id;
      if (!tabId) throw new Error(`open_tab_no_id:${JSON.stringify(openRes)}`);
      pass('open_tab', `tab_id=${tabId}`);

      // 2. List tabs
      const listRes = parseResult(await tool('airkvm_list_tabs', {}), 'list_tabs');
      const tabs = listRes.tabs ?? listRes;
      if (!Array.isArray(tabs)) throw new Error(`list_tabs_not_array:${JSON.stringify(listRes)}`);
      const exampleTab = tabs.find((t) => String(t.url || '').includes('example.com'));
      if (!exampleTab) throw new Error(`list_tabs_no_example:${JSON.stringify(tabs)}`);
      pass('list_tabs', `${tabs.length} tab(s), found example.com tab_id=${exampleTab.id}`);

      // Use the confirmed example.com tab for subsequent operations.
      const activeTabId = exampleTab.id;

      // 3. Window bounds
      const boundsRes = parseResult(await tool('airkvm_window_bounds', {}), 'window_bounds');
      const { width, height } = boundsRes.bounds ?? boundsRes;
      if (!width || !height) throw new Error(`window_bounds_missing:${JSON.stringify(boundsRes)}`);
      pass('window_bounds', `${width}x${height}`);

      // 4. DOM snapshot
      const domRes = parseResult(
        await tool('airkvm_dom_snapshot', { request_id: 'e2e-dom-1' }),
        'dom_snapshot'
      );
      const domText = domRes.snapshot?.summary
        ? JSON.stringify(domRes.snapshot.summary)
        : domRes.dom ?? domRes.snapshot ?? domRes.content ?? JSON.stringify(domRes);
      if (!domText || domText.length < 10) throw new Error(`dom_snapshot_empty:${JSON.stringify(domRes)}`);
      pass('dom_snapshot', `${domText.length} chars`);

      // 5. exec_js_tab
      const jsRes = parseResult(
        await tool('airkvm_exec_js_tab', {
          request_id: 'e2e-js-1',
          tab_id: activeTabId,
          script: 'document.location.hostname',
        }),
        'exec_js_tab'
      );
      let jsValue;
      try { jsValue = JSON.parse(jsRes.value_json ?? 'null'); } catch { jsValue = jsRes.value_json; }
      if (jsValue === null || jsValue === undefined) throw new Error(`exec_js_tab_null:${JSON.stringify(jsRes)}`);
      const jsDisplay = typeof jsValue === 'object' ? JSON.stringify(jsValue) : String(jsValue);
      pass('exec_js_tab', `document.location.hostname="${jsDisplay}"`);

      // 6. Screenshot
      const shotRes = parseResult(
        await tool('airkvm_screenshot_tab', {
          request_id: 'e2e-shot-1',
          tab_id: activeTabId,
          max_width: 1280,
          max_height: 720,
          quality: 0.6,
        }),
        'screenshot_tab'
      );
      const imgData = shotRes.data ?? shotRes.image ?? shotRes.base64;
      if (!imgData || imgData.length < 100) throw new Error(`screenshot_empty:${JSON.stringify(Object.keys(shotRes))}`);
      try {
        mkdirSync(tempDir, { recursive: true });
        const outPath = path.join(tempDir, 'e2e-screenshot.jpg');
        writeFileSync(outPath, Buffer.from(imgData, 'base64'));
        pass('screenshot_tab', `${imgData.length} base64 chars → saved ${outPath}`);
      } catch {
        pass('screenshot_tab', `${imgData.length} base64 chars (save failed)`);
      }

      console.log('\ne2e_browser_ok\n');
      await stopChild();
      resolve();
    }

    main().catch((err) => {
      stopChild().finally(() => reject(err));
    });
  });
}

run().catch((err) => {
  console.error(`\ne2e_browser_failed: ${err?.message || err}`);
  process.exit(1);
});
