import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool
} from '../src/tooling.js';

test('buildCommandForTool maps screenshot tools to screenshot.request with bin encoding', () => {
  const tab = buildCommandForTool('airkvm_screenshot_tab', {
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123
  });
  const desktop = buildCommandForTool('airkvm_screenshot_desktop', { request_id: 'r2' });
  const desktopWithDelay = buildCommandForTool('airkvm_screenshot_desktop', {
    request_id: 'r3',
    desktop_delay_ms: 600
  });
  const tabs = buildCommandForTool('airkvm_list_tabs', { request_id: 't1' });
  const windowBounds = buildCommandForTool('airkvm_window_bounds', { request_id: 'wb-1', tab_id: 9 });
  const openTab = buildCommandForTool('airkvm_open_tab', {
    request_id: 'tab-1',
    url: 'https://example.com/path',
    active: false
  });
  const exec = buildCommandForTool('airkvm_exec_js_tab', {
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 7,
    timeout_ms: 500,
    max_result_chars: 256
  });

  assert.deepEqual(tab, {
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123,
    encoding: 'bin'
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2', encoding: 'bin' });
  assert.deepEqual(desktopWithDelay, {
    type: 'screenshot.request',
    source: 'desktop',
    request_id: 'r3',
    desktop_delay_ms: 600,
    encoding: 'bin'
  });
  assert.deepEqual(tabs, { type: 'tabs.list.request', request_id: 't1' });
  assert.deepEqual(windowBounds, { type: 'window.bounds.request', request_id: 'wb-1', tab_id: 9 });
  assert.deepEqual(openTab, {
    type: 'tab.open.request',
    request_id: 'tab-1',
    url: 'https://example.com/path',
    active: false
  });
  assert.deepEqual(exec, {
    type: 'js.exec.request',
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 7,
    timeout_ms: 500,
    max_result_chars: 256
  });
});

test('isKnownTool and isStructuredTool classify tools correctly', () => {
  assert.equal(isKnownTool('airkvm_send'), true);
  assert.equal(isKnownTool('airkvm_dom_snapshot'), true);
  assert.equal(isKnownTool('airkvm_list_tabs'), true);
  assert.equal(isKnownTool('airkvm_window_bounds'), true);
  assert.equal(isKnownTool('airkvm_open_tab'), true);
  assert.equal(isKnownTool('airkvm_exec_js_tab'), true);
  assert.equal(isKnownTool('nope'), false);
  assert.equal(isStructuredTool('airkvm_send'), false);
  assert.equal(isStructuredTool('airkvm_list_tabs'), true);
  assert.equal(isStructuredTool('airkvm_window_bounds'), true);
  assert.equal(isStructuredTool('airkvm_open_tab'), true);
  assert.equal(isStructuredTool('airkvm_exec_js_tab'), true);
  assert.equal(isStructuredTool('airkvm_screenshot_tab'), true);
});

test('js exec collector returns structured success payload', () => {
  const command = { type: 'js.exec.request', request_id: 'js-1', script: 'return 1;' };
  const collect = createResponseCollector('airkvm_exec_js_tab', command);
  const done = collect({
    type: 'js.exec.result',
    request_id: 'js-1',
    tab_id: 11,
    duration_ms: 14,
    value_type: 'number',
    value_json: '1',
    truncated: false,
    ts: 123
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.value_json, '1');
});

test('tab open collector returns structured success payload', () => {
  const command = { type: 'tab.open.request', request_id: 'tab-1', url: 'https://example.com', active: true };
  const collect = createResponseCollector('airkvm_open_tab', command);
  const done = collect({
    type: 'tab.open',
    request_id: 'tab-1',
    tab: {
      id: 50,
      window_id: 2,
      active: true,
      title: 'Example',
      url: 'https://example.com'
    },
    ts: 10
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.tab.id, 50);
});

test('tab open collector returns structured error payload', () => {
  const command = { type: 'tab.open.request', request_id: 'tab-err', url: 'https://example.com', active: true };
  const collect = createResponseCollector('airkvm_open_tab', command);
  const done = collect({
    type: 'tab.open.error',
    request_id: 'tab-err',
    error: 'tabs_create_failed',
    ts: 11
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'tabs_create_failed');
});

test('js exec collector returns structured error payload', () => {
  const command = { type: 'js.exec.request', request_id: 'js-err', script: 'throw new Error()' };
  const collect = createResponseCollector('airkvm_exec_js_tab', command);
  const done = collect({
    type: 'js.exec.error',
    request_id: 'js-err',
    tab_id: 12,
    duration_ms: 7,
    error_code: 'js_exec_runtime_error',
    error: 'Boom',
    ts: 456
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'Boom');
  assert.equal(done.data.detail.error_code, 'js_exec_runtime_error');
});

test('tabs list collector returns structured list payload', () => {
  const command = { type: 'tabs.list.request', request_id: 'tabs-1' };
  const collect = createResponseCollector('airkvm_list_tabs', command);
  const done = collect({
    type: 'tabs.list',
    request_id: 'tabs-1',
    tabs: [{ id: 10, title: 'Example', url: 'https://example.com' }]
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'tabs-1');
  assert.equal(done.data.tabs.length, 1);
});

test('window bounds collector returns structured success payload', () => {
  const command = { type: 'window.bounds.request', request_id: 'wb-1', tab_id: 4 };
  const collect = createResponseCollector('airkvm_window_bounds', command);
  const done = collect({
    type: 'window.bounds',
    request_id: 'wb-1',
    tab_id: 4,
    window_id: 7,
    bounds: { left: 100, top: 40, width: 1200, height: 900, window_state: 'normal' }
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.window_id, 7);
  assert.equal(done.data.bounds.left, 100);
});

test('window bounds collector returns structured error payload', () => {
  const command = { type: 'window.bounds.request', request_id: 'wb-2' };
  const collect = createResponseCollector('airkvm_window_bounds', command);
  const done = collect({
    type: 'window.bounds.error',
    request_id: 'wb-2',
    error: 'active_tab_not_found'
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'active_tab_not_found');
});

test('createResponseCollector returns null for stream-only tools', () => {
  const domCollect = createResponseCollector('airkvm_dom_snapshot', { type: 'dom.snapshot.request', request_id: 'd1' });
  assert.equal(domCollect, null);
  const tabCollect = createResponseCollector('airkvm_screenshot_tab', { type: 'screenshot.request', source: 'tab', request_id: 's1', encoding: 'bin' });
  assert.equal(tabCollect, null);
  const desktopCollect = createResponseCollector('airkvm_screenshot_desktop', { type: 'screenshot.request', source: 'desktop', request_id: 's2', encoding: 'bin' });
  assert.equal(desktopCollect, null);
});
