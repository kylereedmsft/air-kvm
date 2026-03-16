import test from 'node:test';
import assert from 'node:assert/strict';

import { getTool, validateArgs } from '../src/protocol.js';

test('getTool returns null for unknown tool', () => {
  assert.equal(getTool('nope'), null);
  assert.equal(getTool(''), null);
  assert.equal(getTool(undefined), null);
});

test('airkvm_mouse_move_rel build', () => {
  assert.deepEqual(getTool('airkvm_mouse_move_rel').build({ dx: 10, dy: -5 }), { type: 'mouse.move_rel', dx: 10, dy: -5 });
});

test('validateArgs rejects airkvm_mouse_move_rel with missing fields', () => {
  const tool = getTool('airkvm_mouse_move_rel');
  assert.deepEqual(validateArgs(tool, { dx: 1 }), { ok: false, error: 'missing_required_field:dy' });
  assert.deepEqual(validateArgs(tool, {}), { ok: false, error: 'missing_required_field:dx' });
});

test('validateArgs rejects airkvm_mouse_move_rel with non-integer', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_mouse_move_rel'), { dx: 1.5, dy: 0 }), { ok: false, error: 'invalid_type:dx' });
});

test('airkvm_mouse_click build', () => {
  assert.deepEqual(getTool('airkvm_mouse_click').build({ button: 'left' }), { type: 'mouse.click', button: 'left' });
});

test('validateArgs rejects airkvm_mouse_click with non-string button', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_mouse_click'), { button: 1 }), { ok: false, error: 'invalid_type:button' });
});

test('airkvm_key_tap build', () => {
  assert.deepEqual(getTool('airkvm_key_tap').build({ key: 'Enter' }), { type: 'key.tap', key: 'Enter' });
});

test('validateArgs rejects airkvm_key_tap with non-string key', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_key_tap'), { key: 13 }), { ok: false, error: 'invalid_type:key' });
});

test('airkvm_key_type build', () => {
  assert.deepEqual(getTool('airkvm_key_type').build({ text: 'Hello, World!' }), { type: 'key.type', text: 'Hello, World!' });
  assert.deepEqual(getTool('airkvm_key_type').build({ text: 'user\\tpass\\n' }), { type: 'key.type', text: 'user\\tpass\\n' });
  assert.deepEqual(getTool('airkvm_key_type').build({ text: 'hello{Enter}world' }), { type: 'key.type', text: 'hello{Enter}world' });
});

test('validateArgs rejects airkvm_key_type with empty or too-long text', () => {
  const tool = getTool('airkvm_key_type');
  assert.deepEqual(validateArgs(tool, { text: '' }), { ok: false, error: 'too_short:text' });
  assert.deepEqual(validateArgs(tool, { text: 'a'.repeat(201) }), { ok: false, error: 'too_long:text' });
});

test('airkvm_state_request build', () => {
  assert.deepEqual(getTool('airkvm_state_request').build({}), { type: 'state.request' });
});

test('airkvm_state_set build', () => {
  assert.deepEqual(getTool('airkvm_state_set').build({ busy: true }), { type: 'state.set', busy: true });
});

test('validateArgs rejects airkvm_state_set with non-boolean', () => {
  assert.deepEqual(validateArgs(getTool('airkvm_state_set'), { busy: 'yes' }), { ok: false, error: 'invalid_type:busy' });
});

test('airkvm_fw_version_request build', () => {
  assert.deepEqual(getTool('airkvm_fw_version_request').build({}), { type: 'fw.version.request' });
});

test('airkvm_transfer_reset build', () => {
  assert.deepEqual(getTool('airkvm_transfer_reset').build({}), { type: 'transfer.reset' });
});

test('target is set correctly on all tools', () => {
  for (const name of ['airkvm_send', 'airkvm_state_request', 'airkvm_state_set',
    'airkvm_fw_version_request', 'airkvm_transfer_reset']) {
    assert.equal(getTool(name).target, 'fw', `expected ${name} to have target: 'fw'`);
  }
  for (const name of ['airkvm_mouse_move_rel',
    'airkvm_mouse_click', 'airkvm_key_tap', 'airkvm_key_type']) {
    assert.equal(getTool(name).target, 'hid', `expected ${name} to have target: 'hid'`);
  }
  for (const name of ['airkvm_list_tabs', 'airkvm_screenshot_tab', 'airkvm_screenshot_desktop',
    'airkvm_dom_snapshot', 'airkvm_exec_js_tab', 'airkvm_window_bounds', 'airkvm_open_tab']) {
    assert.equal(getTool(name).target, 'extension', `expected ${name} to have target: 'extension'`);
  }
});
