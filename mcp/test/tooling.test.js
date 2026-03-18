import test from 'node:test';
import assert from 'node:assert/strict';

import { getTool, validateArgs } from '../src/protocol.js';

test('screenshot and browser tools build correct commands', () => {
  const mouseAbs = getTool('airkvm_mouse_move_abs').build({ x: 1024, y: 2048 });
  const mouseScroll = getTool('airkvm_mouse_scroll').build({ dy: -120 });
  const tab = getTool('airkvm_screenshot_tab').build({
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123
  });
  const desktop = getTool('airkvm_screenshot_desktop').build({ request_id: 'r2' });
  const desktopWithDelay = getTool('airkvm_screenshot_desktop').build({ request_id: 'r3', desktop_delay_ms: 600 });
  const tabs = getTool('airkvm_list_tabs').build({ request_id: 't1' });
  const windowBounds = getTool('airkvm_window_bounds').build({ request_id: 'wb-1', tab_id: 9 });
  const openTab = getTool('airkvm_open_tab').build({ request_id: 'tab-1', url: 'https://example.com/path', active: false });
  const openWindow = getTool('airkvm_open_window').build({
    request_id: 'win-1',
    url: 'https://example.com/window',
    focused: true,
    width: 900,
    height: 700,
    type: 'popup'
  });
  const exec = getTool('airkvm_exec_js_tab').build({
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 7,
    timeout_ms: 500,
    max_result_chars: 256
  });
  const inject = getTool('airkvm_inject_js_tab').build({
    request_id: 'inj-1',
    script: 'return document.title;',
    tab_id: 8,
    timeout_ms: 600,
    max_result_chars: 300
  });
  const ax = getTool('airkvm_accessibility_snapshot').build({ request_id: 'ax-1', tab_id: 11, timeout_ms: 30000 });

  assert.deepEqual(mouseAbs, { type: 'mouse.move_abs', x: 1024, y: 2048 });
  assert.deepEqual(mouseScroll, { type: 'mouse.scroll', dy: -120 });
  assert.deepEqual(tab, {
    type: 'screenshot.request', source: 'tab', request_id: 'r1',
    max_width: 800, max_height: 450, quality: 0.5, max_chars: 70000, tab_id: 123, encoding: 'bin'
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2', encoding: 'bin' });
  assert.deepEqual(desktopWithDelay, {
    type: 'screenshot.request', source: 'desktop', request_id: 'r3', desktop_delay_ms: 600, encoding: 'bin'
  });
  assert.deepEqual(tabs, { type: 'tabs.list.request', request_id: 't1' });
  assert.deepEqual(windowBounds, { type: 'window.bounds.request', request_id: 'wb-1', tab_id: 9 });
  assert.deepEqual(openTab, { type: 'tab.open.request', request_id: 'tab-1', url: 'https://example.com/path', active: false });
  assert.deepEqual(openWindow, {
    type: 'window.open.request',
    request_id: 'win-1',
    url: 'https://example.com/window',
    focused: true,
    width: 900,
    height: 700,
    window_type: 'popup'
  });
  assert.deepEqual(exec, {
    type: 'js.exec.request', request_id: 'js-1', script: 'return document.title;',
    tab_id: 7, timeout_ms: 500, max_result_chars: 256
  });
  assert.deepEqual(inject, {
    type: 'js.inject.request', request_id: 'inj-1', script: 'return document.title;',
    tab_id: 8, timeout_ms: 600, max_result_chars: 300
  });
  assert.deepEqual(ax, { type: 'ax.snapshot.request', request_id: 'ax-1', tab_id: 11 });
});

test('validateArgs returns ok for valid args', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_open_tab'), { request_id: 'r1', url: 'https://example.com' }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_open_window'), { request_id: 'r1', url: 'https://example.com' }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_mouse_scroll'), { dy: -120 }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_accessibility_snapshot'), { request_id: 'r1', tab_id: 7 }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_accessibility_snapshot'), { request_id: 'r1', tab_id: 7, timeout_ms: 30000 }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_exec_js_tab'), { request_id: 'r1', script: 'return 1;' }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_inject_js_tab'), { request_id: 'r1', script: 'return 1;' }), { ok: true });
  assert.deepEqual(validateArgs(getTool('airkvm_list_tabs'), {}), { ok: true });
});

test('validateArgs rejects missing required fields', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_open_tab'), { request_id: 'r1' }), { ok: false, error: 'missing_required_field:url' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_window'), { request_id: 'r1' }), { ok: false, error: 'missing_required_field:url' });
  assert.deepEqual(validateArgs(getTool('airkvm_exec_js_tab'), { request_id: 'r1' }), { ok: false, error: 'missing_required_field:script' });
  assert.deepEqual(validateArgs(getTool('airkvm_inject_js_tab'), { request_id: 'r1' }), { ok: false, error: 'missing_required_field:script' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_tab'), { url: 'https://example.com' }), { ok: false, error: 'missing_required_field:request_id' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_window'), { url: 'https://example.com' }), { ok: false, error: 'missing_required_field:request_id' });
});

test('validateArgs rejects wrong types', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_open_tab'), { request_id: 42, url: 'https://x.com' }), { ok: false, error: 'invalid_type:request_id' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_window'), { request_id: 42, url: 'https://x.com' }), { ok: false, error: 'invalid_type:request_id' });
  assert.deepEqual(validateArgs(getTool('airkvm_screenshot_tab'), { max_width: 1.5 }), { ok: false, error: 'invalid_type:max_width' });
  assert.deepEqual(validateArgs(getTool('airkvm_screenshot_tab'), { quality: 'high' }), { ok: false, error: 'invalid_type:quality' });
});

test('validateArgs rejects out-of-range values', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_exec_js_tab'), { request_id: 'r', script: 's', timeout_ms: 10 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateArgs(getTool('airkvm_exec_js_tab'), { request_id: 'r', script: 's', timeout_ms: 9999 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateArgs(getTool('airkvm_inject_js_tab'), { request_id: 'r', script: 's', timeout_ms: 10 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateArgs(getTool('airkvm_inject_js_tab'), { request_id: 'r', script: 's', timeout_ms: 9999 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateArgs(getTool('airkvm_accessibility_snapshot'), { request_id: 'r', timeout_ms: 10 }), { ok: false, error: 'out_of_range:timeout_ms' });
  assert.deepEqual(validateArgs(getTool('airkvm_accessibility_snapshot'), { request_id: 'r', timeout_ms: 120001 }), { ok: false, error: 'out_of_range:timeout_ms' });
});

test('validateArgs rejects strings violating length constraints', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_exec_js_tab'), { request_id: 'r', script: '' }), { ok: false, error: 'too_short:script' });
  assert.deepEqual(validateArgs(getTool('airkvm_inject_js_tab'), { request_id: 'r', script: '' }), { ok: false, error: 'too_short:script' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_tab'), { request_id: 'r', url: 'x'.repeat(2049) }), { ok: false, error: 'too_long:url' });
  assert.deepEqual(validateArgs(getTool('airkvm_open_window'), { request_id: 'r', url: 'x'.repeat(2049) }), { ok: false, error: 'too_long:url' });
});

test('validateArgs rejects invalid enum values', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_screenshot_tab'), { encoding: 'base64' }), { ok: false, error: 'invalid_enum:encoding' });
});
