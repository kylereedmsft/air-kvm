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
