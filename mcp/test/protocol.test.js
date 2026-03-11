import test from 'node:test';
import assert from 'node:assert/strict';

import { toDeviceLine, validateAgentCommand } from '../src/protocol.js';

test('validateAgentCommand accepts mouse.move_rel', () => {
  const result = validateAgentCommand({ type: 'mouse.move_rel', dx: 1, dy: -1 });
  assert.equal(result.ok, true);
});

test('validateAgentCommand rejects bad key.tap', () => {
  const result = validateAgentCommand({ type: 'key.tap', key: 13 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_key_tap');
});

test('validateAgentCommand accepts key.type with bounded text', () => {
  const result = validateAgentCommand({ type: 'key.type', text: 'Bluetooth' });
  assert.equal(result.ok, true);
});

test('validateAgentCommand rejects key.type with empty text', () => {
  const result = validateAgentCommand({ type: 'key.type', text: '' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_key_type');
});

test('validateAgentCommand accepts key.type with punctuation', () => {
  const result = validateAgentCommand({ type: 'key.type', text: 'Hello, World! -- The AirKVM' });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts key.type with backslash escape sequences', () => {
  const result = validateAgentCommand({ type: 'key.type', text: 'user\\tpass\\n' });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts key.type with named key braces', () => {
  const result = validateAgentCommand({ type: 'key.type', text: 'hello{Enter}world' });
  assert.equal(result.ok, true);
});

test('toDeviceLine returns JSONL', () => {
  const line = toDeviceLine({ type: 'state.request' });
  assert.equal(line, '{"type":"state.request"}\n');
});

test('validateAgentCommand accepts state.set with boolean busy', () => {
  const result = validateAgentCommand({ type: 'state.set', busy: true });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts fw.version.request', () => {
  const result = validateAgentCommand({ type: 'fw.version.request' });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts screenshot.request with tuning fields', () => {
  const result = validateAgentCommand({
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.55,
    max_chars: 70000,
    desktop_delay_ms: 500
  });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts tab.open.request within bounds', () => {
  const result = validateAgentCommand({
    type: 'tab.open.request',
    request_id: 'tab-1',
    url: 'https://example.com',
    active: false
  });
  assert.equal(result.ok, true);
});

test('validateAgentCommand rejects tab.open.request with invalid URL scheme', () => {
  const result = validateAgentCommand({
    type: 'tab.open.request',
    request_id: 'tab-1',
    url: 'ftp://example.com'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_tab_open_request');
});

test('validateAgentCommand accepts js.exec.request within bounds', () => {
  const result = validateAgentCommand({
    type: 'js.exec.request',
    request_id: 'js-1',
    script: 'return document.title;',
    tab_id: 5,
    timeout_ms: 500,
    max_result_chars: 300
  });
  assert.equal(result.ok, true);
});

test('validateAgentCommand accepts window.bounds.request within bounds', () => {
  const result = validateAgentCommand({
    type: 'window.bounds.request',
    request_id: 'wb-1',
    tab_id: 5
  });
  assert.equal(result.ok, true);
});

test('validateAgentCommand rejects window.bounds.request without request_id', () => {
  const result = validateAgentCommand({
    type: 'window.bounds.request'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_window_bounds_request');
});

test('validateAgentCommand rejects js.exec.request when script is too long', () => {
  const result = validateAgentCommand({
    type: 'js.exec.request',
    request_id: 'js-1',
    script: 'a'.repeat(12001)
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_js_exec_request');
});

test('validateAgentCommand accepts js.exec.request with script_transfer_id', () => {
  const result = validateAgentCommand({
    type: 'js.exec.request',
    request_id: 'js-xfer-1',
    script_transfer_id: 'tx_1234abcd',
    tab_id: 5
  });
  assert.equal(result.ok, true);
});

test('validateAgentCommand rejects js.exec.request when timeout is out of range', () => {
  const result = validateAgentCommand({
    type: 'js.exec.request',
    request_id: 'js-2',
    script: 'return 1;',
    timeout_ms: 10
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_js_exec_request');
});
