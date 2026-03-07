import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDeviceLine } from '../src/uart.js';

test('parseDeviceLine parses ctrl frame', () => {
  const frame = parseDeviceLine('{"ch":"ctrl","msg":{"ok":true}}');
  assert.equal(frame.kind, 'ctrl');
  assert.deepEqual(frame.msg, { ok: true });
});

test('parseDeviceLine parses log frame', () => {
  const frame = parseDeviceLine('{"ch":"log","msg":"rx.ble"}');
  assert.equal(frame.kind, 'log');
  assert.equal(frame.msg, 'rx.ble');
});

test('parseDeviceLine supports legacy ctrl object', () => {
  const frame = parseDeviceLine('{"ok":true}');
  assert.equal(frame.kind, 'legacy_ctrl');
  assert.deepEqual(frame.msg, { ok: true });
});

test('parseDeviceLine returns invalid for non-json line', () => {
  const frame = parseDeviceLine('garbage');
  assert.equal(frame.kind, 'invalid');
});
