import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamSender,
  StreamReceiver,
  kDefaultChunkSize,
  kSeqFinalBit,
} from '../src/stream.js';
import {
  decodeUartFrame,
  formatTransferId,
} from '../src/binary_frame.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonCapture() {
  const messages = [];
  const writeJsonFn = async (obj) => { messages.push(structuredClone(obj)); };
  return { messages, writeJsonFn };
}

function makeBinaryCapture() {
  const frames = [];
  const writeBinaryFn = async (buf) => { frames.push(Buffer.from(buf)); };
  return { frames, writeBinaryFn };
}

function decodeChunkInfo(buf) {
  const decoded = decodeUartFrame(buf);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    frameType: decoded.frameType,
    transferId: decoded.transferId,
    rawSeq: decoded.seq,
    seq: (decoded.seq & ~kSeqFinalBit) >>> 0,
    isFinal: (decoded.seq & kSeqFinalBit) !== 0,
    payload: decoded.payload,
    payloadLen: decoded.payloadLen,
  };
}

// ---------------------------------------------------------------------------
// StreamSender tests
// ---------------------------------------------------------------------------

test('StreamSender: small object sent via writeJsonFn', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({ writeJsonFn: jsonCap.writeJsonFn, writeBinaryFn: binCap.writeBinaryFn });
  const obj = { type: 'state.request' };
  await sender.send(obj);

  assert.equal(jsonCap.messages.length, 1);
  assert.deepEqual(jsonCap.messages[0], obj);
  assert.equal(binCap.frames.length, 0);
});

test('StreamSender: large object chunked and acked', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 500,
  });

  const obj = { type: 'test', data: 'x'.repeat(200) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(binCap.frames.length >= 1);

  let totalChunks = 0;
  while (true) {
    await new Promise((r) => setTimeout(r, 20));
    if (binCap.frames.length <= totalChunks) continue;

    const frame = binCap.frames[totalChunks];
    const info = decodeChunkInfo(frame);
    assert.equal(info.ok, true);
    assert.equal(info.frameType, 1);
    assert.equal(info.seq, totalChunks);

    sender.onAck({
      type: 'stream.ack',
      transfer_id: formatTransferId(info.transferId),
      seq: info.seq,
    });

    if (info.isFinal) { totalChunks += 1; break; }
    totalChunks += 1;
  }

  await sendPromise;
  assert.ok(totalChunks > 1, 'should have multiple chunks');
});

test('StreamSender: timeout triggers retry', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 100,
    maxRetries: 1,
  });

  const obj = { data: 'y'.repeat(80) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 250));

  assert.ok(binCap.frames.length >= 2, `expected >= 2 binary frames, got ${binCap.frames.length}`);

  // Ack everything to let it finish.
  for (const f of binCap.frames) {
    const d = decodeChunkInfo(f);
    if (d.ok && d.frameType === 1) {
      sender.onAck({
        type: 'stream.ack',
        transfer_id: formatTransferId(d.transferId),
        seq: d.seq,
      });
    }
  }

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    for (const f of binCap.frames) {
      const d = decodeChunkInfo(f);
      if (d.ok && d.frameType === 1) {
        sender.onAck({
          type: 'stream.ack',
          transfer_id: formatTransferId(d.transferId),
          seq: d.seq,
        });
      }
    }
  }

  try { await sendPromise; } catch { /* ok */ }
});

test('StreamSender: nack triggers retry', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 500,
    maxRetries: 2,
  });

  const obj = { data: 'z'.repeat(80) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(binCap.frames.length >= 1);

  const info = decodeChunkInfo(binCap.frames[0]);
  sender.onAck({
    type: 'stream.nack',
    transfer_id: formatTransferId(info.transferId),
    seq: info.seq,
    reason: 'crc_mismatch',
  });

  await new Promise((r) => setTimeout(r, 100));
  assert.ok(binCap.frames.length >= 2, 'should have retried after nack');

  for (const f of binCap.frames) {
    const d = decodeChunkInfo(f);
    if (d.ok && d.frameType === 1) {
      sender.onAck({
        type: 'stream.ack',
        transfer_id: formatTransferId(d.transferId),
        seq: d.seq,
      });
    }
  }

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    for (const f of binCap.frames) {
      const d = decodeChunkInfo(f);
      if (d.ok && d.frameType === 1) {
        sender.onAck({
          type: 'stream.ack',
          transfer_id: formatTransferId(d.transferId),
          seq: d.seq,
        });
      }
    }
  }

  try { await sendPromise; } catch { /* ok */ }
});

test('StreamSender: reset clears pending state', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 5000,
  });

  const obj = { data: 'a'.repeat(80) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 50));
  sender.reset();

  await assert.rejects(sendPromise, /stream_reset/);
});

test('StreamSender: mismatched transfer_id ack is ignored', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 200,
    maxRetries: 0,
  });

  const obj = { data: 'b'.repeat(80) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 50));
  sender.onAck({ type: 'stream.ack', transfer_id: 'tx_deadbeef', seq: 0 });

  await assert.rejects(sendPromise, /chunk_send_failed/);
});

// ---------------------------------------------------------------------------
// StreamReceiver tests
// ---------------------------------------------------------------------------

test('StreamReceiver: inline control message delivered directly', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onControlFrame({ type: 'tabs.list', tabs: [1, 2, 3] });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { type: 'tabs.list', tabs: [1, 2, 3] });
});

test('StreamReceiver: stream control messages not delivered to app', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onControlFrame({ type: 'stream.ack', transfer_id: 'tx_00000001', seq: 0 });
  receiver.onControlFrame({ type: 'stream.nack', transfer_id: 'tx_00000001', seq: 0 });
  receiver.onControlFrame({ type: 'stream.reset' });

  assert.equal(messages.length, 0);
});

test('StreamReceiver: single-chunk transfer reassembled', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { type: 'test', value: 42 };
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, 'utf8');

  receiver.onChunkFrame({
    transfer_id: 'tx_00000001',
    raw_seq: kSeqFinalBit | 0,
    payload,
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
  assert.ok(cap.messages.length >= 1);
  assert.equal(cap.messages[0].type, 'stream.ack');
});

test('StreamReceiver: multi-chunk transfer reassembled in order', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { type: 'big', data: 'hello world this is a longer payload for testing' };
  const json = JSON.stringify(obj);
  const bytes = Buffer.from(json, 'utf8');
  const chunkSize = 20;
  const totalChunks = Math.ceil(bytes.length / chunkSize);

  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(bytes.length, start + chunkSize);
    const final = i === totalChunks - 1;
    receiver.onChunkFrame({
      transfer_id: 'tx_aabbccdd',
      raw_seq: final ? (kSeqFinalBit | i) : i,
      payload: bytes.subarray(start, end),
    });
  }

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: duplicate chunks during transfer are idempotent', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { dup: true };
  const bytes = Buffer.from(JSON.stringify(obj), 'utf8');
  const mid = Math.floor(bytes.length / 2);

  const chunk0 = { transfer_id: 'tx_00000002', raw_seq: 0, payload: bytes.subarray(0, mid) };
  receiver.onChunkFrame(chunk0);
  receiver.onChunkFrame(chunk0);

  receiver.onChunkFrame({
    transfer_id: 'tx_00000002',
    raw_seq: kSeqFinalBit | 1,
    payload: bytes.subarray(mid),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: out-of-order chunks reassembled correctly', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { order: 'reversed' };
  const bytes = Buffer.from(JSON.stringify(obj), 'utf8');
  const mid = Math.floor(bytes.length / 2);

  receiver.onChunkFrame({
    transfer_id: 'tx_00000003',
    raw_seq: kSeqFinalBit | 1,
    payload: bytes.subarray(mid),
  });

  assert.equal(messages.length, 0, 'should not deliver yet');

  receiver.onChunkFrame({
    transfer_id: 'tx_00000003',
    raw_seq: 0,
    payload: bytes.subarray(0, mid),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: reset clears partial transfers', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onChunkFrame({
    transfer_id: 'tx_00000004',
    raw_seq: 0,
    payload: Buffer.from('partial'),
  });

  receiver.reset();

  const obj = { after: 'reset' };
  receiver.onChunkFrame({
    transfer_id: 'tx_00000005',
    raw_seq: kSeqFinalBit | 0,
    payload: Buffer.from(JSON.stringify(obj)),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: invalid JSON triggers error handler', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const errors = [];
  receiver.onError((err) => errors.push(err));

  receiver.onChunkFrame({
    transfer_id: 'tx_00000006',
    raw_seq: kSeqFinalBit | 0,
    payload: Buffer.from('not valid json {{{'),
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'json_parse_failed');
});

// ---------------------------------------------------------------------------
// Integration: sender → receiver round-trip
// ---------------------------------------------------------------------------

test('Integration: sender and receiver complete a chunked transfer', async () => {
  const senderBinFrames = [];
  const senderJsonMsgs = [];
  const receiverAckMsgs = [];

  const sender = new StreamSender({
    writeJsonFn: async (obj) => { senderJsonMsgs.push(structuredClone(obj)); },
    writeBinaryFn: async (buf) => { senderBinFrames.push(Buffer.from(buf)); },
    chunkSize: 30,
    ackTimeoutMs: 2000,
  });

  const receiver = new StreamReceiver({
    writeJsonFn: async (obj) => { receiverAckMsgs.push(structuredClone(obj)); },
  });

  const received = [];
  receiver.onMessage((msg) => received.push(msg));

  const bigObj = { type: 'dom.snapshot', data: 'A'.repeat(200) };
  const sendPromise = sender.send(bigObj);

  for (let tick = 0; tick < 100; tick += 1) {
    await new Promise((r) => setTimeout(r, 10));

    // Feed sender binary frames to receiver.
    while (senderBinFrames.length > 0) {
      const raw = senderBinFrames.shift();
      const decoded = decodeUartFrame(raw);
      if (!decoded.ok) continue;
      if (decoded.frameType === 1) {
        receiver.onChunkFrame({
          transfer_id: formatTransferId(decoded.transferId),
          raw_seq: decoded.seq,
          payload: decoded.payload,
        });
      }
    }

    // Feed receiver ack JSON back to sender.
    while (receiverAckMsgs.length > 0) {
      const msg = receiverAckMsgs.shift();
      sender.onAck(msg);
    }

    if (received.length > 0) break;
  }

  await sendPromise;
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], bigObj);
});
