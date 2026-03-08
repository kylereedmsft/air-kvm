import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeUartFrame,
  encodeControlFrame,
  encodeLogFrame,
  encodeTransferChunkFrame,
  tryExtractFrameFromBuffer
} from '../src/binary_frame.js';

test('decodeUartFrame decodes control JSON frame', () => {
  const frame = encodeControlFrame({ ok: true, type: 'state' });
  const parsed = decodeUartFrame(frame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.frameType, 2);
  assert.equal(parsed.msg.ok, true);
  assert.equal(parsed.msg.type, 'state');
});

test('decodeUartFrame decodes log text frame', () => {
  const frame = encodeLogFrame('hello log');
  const parsed = decodeUartFrame(frame);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.frameType, 3);
  assert.equal(parsed.text, 'hello log');
});

test('tryExtractFrameFromBuffer emits ctrl/log/bin kinds', () => {
  const ctrl = encodeControlFrame({ ok: true });
  const log = encodeLogFrame('x');
  const bin = encodeTransferChunkFrame({
    transferId: 0x11,
    seq: 2,
    payload: Buffer.from('ABC')
  });
  const joined = Buffer.concat([ctrl, log, bin]);

  const f1 = tryExtractFrameFromBuffer(joined);
  assert.equal(f1.frame.kind, 'ctrl');
  assert.equal(f1.frame.msg.ok, true);

  const rest1 = joined.subarray(f1.consumed);
  const f2 = tryExtractFrameFromBuffer(rest1);
  assert.equal(f2.frame.kind, 'log');
  assert.equal(f2.frame.msg, 'x');

  const rest2 = rest1.subarray(f2.consumed);
  const f3 = tryExtractFrameFromBuffer(rest2);
  assert.equal(f3.frame.kind, 'bin');
  assert.equal(f3.frame.transfer_id, 'tx_00000011');
  assert.equal(f3.frame.seq, 2);
});
