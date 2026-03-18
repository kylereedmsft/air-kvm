import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeHarness(opts = {}) {
  const sent = [];
  const transport = {
    send: opts.send || (async (command, tool) => {
      const isLocal = tool.target === 'fw' || tool.target === 'hid';
      if (isLocal) return { ok: true, data: { ok: true } };
      return { ok: true, data: { ok: true, request_id: command.request_id } };
    }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });
  return { server, sent, transport };
}

test('tools/list includes structured tools', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(sent.length, 1);
  const names = sent[0].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'airkvm_send',
    'airkvm_mouse_move_rel',
    'airkvm_mouse_move_abs',
    'airkvm_mouse_click',
    'airkvm_key_tap',
    'airkvm_key_type',
    'airkvm_state_request',
    'airkvm_state_set',
    'airkvm_fw_version_request',
    'airkvm_transfer_reset',
    'airkvm_save_image',
    'airkvm_echo',
    'airkvm_list_tabs',
    'airkvm_window_bounds',
    'airkvm_open_tab',
    'airkvm_open_window',
    'airkvm_dom_snapshot',
    'airkvm_exec_js_tab',
    'airkvm_inject_js_tab',
    'airkvm_screenshot_tab',
    'airkvm_screenshot_desktop',
    'airkvm_bridge_logs'
  ]);
});

test('unknown tool returns error', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'nonexistent_tool', arguments: {} }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32601);
});

test('airkvm_send routes through transport.send as fw tool', async () => {
  const { sent, server } = makeHarness();
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_send', arguments: { command: { type: 'key.tap', key: 'Enter' } } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const result = JSON.parse(sent[0].result.content[0].text);
  assert.equal(result.ok, true);
});

test('airkvm_send rejection surfaces as device error', async () => {
  const { sent, server } = makeHarness({
    send: async () => ({ ok: false, data: { ok: false, error: 'invalid_key' } }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_send', arguments: { command: { type: 'key.tap', key: 'Enter' } } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
});

test('airkvm_send transport error', async () => {
  const { sent, server } = makeHarness({
    send: async () => { throw new Error('serial_gone'); },
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_send', arguments: { command: { type: 'key.tap', key: 'a' } } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent[0].isError, true);
  assert.ok(sent[0].result.content[0].text.includes('transport_error'));
});

test('airkvm_list_tabs uses transport.send', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'tabs.list',
        request_id: command.request_id,
        tabs: [{ id: 1, title: 'Test' }]
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'airkvm_list_tabs', arguments: { request_id: 'req-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const result = JSON.parse(sent[0].result.content[0].text);
  assert.equal(result.request_id, 'req-1');
  assert.deepEqual(result.tabs, [{ id: 1, title: 'Test' }]);
});

test('airkvm_window_bounds returns structured json', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'window.bounds',
        request_id: command.request_id,
        tab_id: 2,
        window_id: 5,
        bounds: { left: 80, top: 40, width: 1280, height: 900, window_state: 'normal' },
        screen: {
          device_pixel_ratio: 2,
          screen: { width: 1512, height: 982 },
          viewport: { inner_width: 757, inner_height: 727, outer_width: 765, outer_height: 817, screen_x: 9, screen_y: 57 }
        },
        ts: 55
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 8,
    method: 'tools/call',
    params: { name: 'airkvm_window_bounds', arguments: { request_id: 'wb-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'window.bounds');
  assert.equal(payload.request_id, 'wb-1');
  assert.equal(payload.bounds.left, 80);
  assert.equal(payload.screen.device_pixel_ratio, 2);
  assert.equal(payload.screen.screen.width, 1512);
});

test('airkvm_open_tab returns structured json', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'tab.open',
        request_id: command.request_id,
        tab: { id: 101, window_id: 3, active: true, title: 'Example', url: 'https://example.com' },
        ts: 123
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 7,
    method: 'tools/call',
    params: { name: 'airkvm_open_tab', arguments: { request_id: 'tab-1', url: 'https://example.com', active: true } }
  });
  await new Promise((r) => setTimeout(r, 50));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'tab.open');
  assert.equal(payload.tab.id, 101);
});

test('airkvm_open_window returns structured json', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'window.open',
        request_id: command.request_id,
        window: {
          id: 77,
          focused: true,
          type: 'popup',
          bounds: { left: 100, top: 80, width: 900, height: 700, window_state: 'normal' }
        },
        tab: { id: 201, window_id: 77, active: true, title: 'Example', url: 'https://example.com' },
        ts: 123
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 17,
    method: 'tools/call',
    params: {
      name: 'airkvm_open_window',
      arguments: { request_id: 'win-1', url: 'https://example.com', focused: true, width: 900, height: 700, type: 'popup' }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'window.open');
  assert.equal(payload.window.id, 77);
  assert.equal(payload.tab.window_id, 77);
});

test('airkvm_exec_js_tab returns structured json', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'js.exec.result',
        request_id: command.request_id,
        tab_id: 2,
        duration_ms: 5,
        value_type: 'string',
        value_json: '"hello"',
        truncated: false
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 6,
    method: 'tools/call',
    params: { name: 'airkvm_exec_js_tab', arguments: { request_id: 'js-1', script: 'return "hello"' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'js.exec.result');
  assert.equal(payload.value_json, '"hello"');
});

test('airkvm_inject_js_tab returns structured json', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'js.inject.result',
        request_id: command.request_id,
        tab_id: 6,
        duration_ms: 3,
        value_type: 'string',
        value_json: '"silent"',
        truncated: false
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 7,
    method: 'tools/call',
    params: { name: 'airkvm_inject_js_tab', arguments: { request_id: 'inj-1', script: 'return "silent"' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.type, 'js.inject.result');
  assert.equal(payload.value_json, '"silent"');
});

test('airkvm_dom_snapshot uses transport.send', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'dom.snapshot',
        request_id: command.request_id,
        html: '<h1>hello</h1>',
        title: 'Test Page'
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 2,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-hp-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-hp-1');
  assert.equal(payload.snapshot.html, '<h1>hello</h1>');
});

test('airkvm_screenshot_tab uses transport.send', async () => {
  const { sent, server } = makeHarness({
    send: async (command) => ({
      ok: true,
      data: {
        type: 'screenshot.response',
        request_id: command.request_id,
        source: 'tab',
        mime: 'image/jpeg',
        data: '/9j/fakebase64'
      }
    }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 3,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: 'shot-hp-1', max_width: 800, max_height: 600, quality: 0.5 }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent[0].isError, undefined);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'shot-hp-1');
  assert.equal(payload.mime, 'image/jpeg');
  assert.equal(payload.base64, '/9j/fakebase64');
});

test('airkvm_bridge_logs passes timeout override to transport.send', async () => {
  let seenTimeoutMs = null;
  const { sent, server } = makeHarness({
    send: async (command, _tool, options) => {
      seenTimeoutMs = options?.timeoutMs ?? null;
      return {
        ok: true,
        data: {
          type: 'bridge.logs',
          request_id: command.request_id,
          lines: ['line 1']
        }
      };
    },
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 4,
    method: 'tools/call',
    params: {
      name: 'airkvm_bridge_logs',
      arguments: { request_id: 'bridge-1', timeout_ms: 30000 }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent[0].isError, undefined);
  assert.equal(seenTimeoutMs, 30000);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'bridge-1');
  assert.deepEqual(payload.lines, ['line 1']);
});

test('transport error surfaces as transport_error', async () => {
  const { sent, server } = makeHarness({
    send: async () => { throw new Error('device_timeout'); },
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 5,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-err-1' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('device error response surfaces as structured error', async () => {
  const { sent, server } = makeHarness({
    send: async () => ({ ok: false, data: { ok: false, error: 'no_tab', request_id: 'dom-dev-err' } }),
  });
  server.handleRequest({
    jsonrpc: '2.0', id: 6,
    method: 'tools/call',
    params: { name: 'airkvm_dom_snapshot', arguments: { request_id: 'dom-dev-err' } }
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.error, 'no_tab');
});

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

test('airkvm_save_image writes file and returns saved_path and saved_bytes', () => {
  const { sent, server } = makeHarness();
  const fakeBase64 = Buffer.from('fake image data').toString('base64');
  const filePath = path.join(os.tmpdir(), `airkvm_test_${Date.now()}.jpg`);

  server.handleRequest({
    jsonrpc: '2.0', id: 10,
    method: 'tools/call',
    params: { name: 'airkvm_save_image', arguments: { base64: fakeBase64, mime: 'image/jpeg', path: filePath } }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, undefined);
  const result = JSON.parse(sent[0].result.content[0].text);
  assert.equal(result.saved_path, filePath);
  assert.equal(result.saved_bytes, Buffer.from(fakeBase64, 'base64').length);
  assert.ok(fs.existsSync(filePath));
  fs.unlinkSync(filePath);
});

test('airkvm_save_image missing required fields returns error', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({
    jsonrpc: '2.0', id: 11,
    method: 'tools/call',
    params: { name: 'airkvm_save_image', arguments: { base64: 'abc', mime: 'image/jpeg' } }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
});

test('airkvm_save_image bad base64 surfaces save_failed error', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({
    jsonrpc: '2.0', id: 12,
    method: 'tools/call',
    params: { name: 'airkvm_save_image', arguments: { base64: 'ok', mime: 'image/jpeg', path: '/no/such/dir/that/cannot/be/created/x/y/z/img.jpg' } }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].isError, true);
  const result = JSON.parse(sent[0].result.content[0].text);
  assert.equal(result.error, 'save_failed');
});
