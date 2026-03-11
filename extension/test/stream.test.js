import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamSender,
  StreamReceiver,
  kSeqFinalBit,
} from '../src/stream.js';
import { makeTransferId } from '../src/binary_frame.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTransferId(n) {
  return `tx_${(n >>> 0).toString(16).padStart(8, '0')}`;
}

function makeJsonCapture() {
  const messages = [];
  const writeJsonFn = async (obj) => { messages.push(structuredClone(obj)); };
  return { messages, writeJsonFn };
}

function makeBinaryCapture() {
  const frames = [];
  const writeBinaryFn = async (buf) => { frames.push(new Uint8Array(buf)); };
  return { frames, writeBinaryFn };
}

// ---------------------------------------------------------------------------
// StreamSender tests
// ---------------------------------------------------------------------------

test('StreamSender: small object sent via writeJsonFn', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
  });

  const obj = { type: 'state.request' };
  await sender.send(obj);

  assert.equal(jsonCap.messages.length, 1);
  assert.deepEqual(jsonCap.messages[0], obj);
  assert.equal(binCap.frames.length, 0, 'no binary frames for small messages');
});

test('StreamSender: large object uses writeBinaryFn', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 200,
    maxRetries: 0,
  });

  const obj = { data: 'x'.repeat(200) };
  const sendPromise = sender.send(obj);

  // Wait for first chunk to be sent.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(binCap.frames.length >= 1, 'should have sent at least one binary frame');
  assert.equal(jsonCap.messages.length, 0, 'should not use JSON path for large messages');

  // Since maxRetries=0 and no ack, it should eventually fail.
  await assert.rejects(sendPromise, /chunk_send_failed/);
});

test('StreamSender: reset clears state', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
    chunkSize: 50,
    ackTimeoutMs: 5000,
  });

  const obj = { data: 'a'.repeat(200) };
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

  const obj = { data: 'c'.repeat(80) };
  const sendPromise = sender.send(obj);

  await new Promise((r) => setTimeout(r, 50));
  sender.onAck({ type: 'stream.ack', transfer_id: 'tx_deadbeef', seq: 0 });

  await assert.rejects(sendPromise, /chunk_send_failed/);
});

// ---------------------------------------------------------------------------
// StreamReceiver tests
// ---------------------------------------------------------------------------

test('StreamReceiver: control message delivered to app', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onControlMessage({ type: 'tabs.list', tabs: [1] });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { type: 'tabs.list', tabs: [1] });
});

test('StreamReceiver: stream control messages filtered out', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onControlMessage({ type: 'stream.ack', transfer_id: 'tx_00000001', seq: 0 });
  receiver.onControlMessage({ type: 'stream.nack', transfer_id: 'tx_00000001', seq: 0 });
  receiver.onControlMessage({ type: 'stream.reset' });

  assert.equal(messages.length, 0);
});

test('StreamReceiver: single-chunk transfer', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { type: 'test', value: 42 };
  const payload = new TextEncoder().encode(JSON.stringify(obj));

  receiver.onChunkFrame({
    transfer_id: 'tx_00000001',
    raw_seq: kSeqFinalBit | 0,
    payload,
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);

  // Should have sent ack.
  assert.ok(cap.messages.length >= 1);
  assert.equal(cap.messages[0].type, 'stream.ack');
});

test('StreamReceiver: multi-chunk reassembly', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { type: 'big', data: 'hello world this is a test payload' };
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const chunkSize = 15;
  const total = Math.ceil(bytes.length / chunkSize);

  for (let i = 0; i < total; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(bytes.length, start + chunkSize);
    const final = i === total - 1;
    receiver.onChunkFrame({
      transfer_id: 'tx_aabb0001',
      raw_seq: final ? (kSeqFinalBit | i) : i,
      payload: bytes.slice(start, end),
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
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const mid = Math.floor(bytes.length / 2);

  // Send chunk 0 twice, then chunk 1 (final).
  const chunk0 = { transfer_id: 'tx_00000002', raw_seq: 0, payload: bytes.slice(0, mid) };
  receiver.onChunkFrame(chunk0);
  receiver.onChunkFrame(chunk0); // duplicate

  receiver.onChunkFrame({
    transfer_id: 'tx_00000002',
    raw_seq: kSeqFinalBit | 1,
    payload: bytes.slice(mid),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: out-of-order chunks', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  const obj = { order: 'reversed' };
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const mid = Math.floor(bytes.length / 2);

  // Send chunk 1 (final) first, then chunk 0.
  receiver.onChunkFrame({
    transfer_id: 'tx_00000003',
    raw_seq: kSeqFinalBit | 1,
    payload: bytes.slice(mid),
  });
  assert.equal(messages.length, 0);

  receiver.onChunkFrame({
    transfer_id: 'tx_00000003',
    raw_seq: 0,
    payload: bytes.slice(0, mid),
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
    payload: new Uint8Array([1, 2, 3]),
  });
  receiver.reset();

  const obj = { after: 'reset' };
  receiver.onChunkFrame({
    transfer_id: 'tx_00000005',
    raw_seq: kSeqFinalBit | 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: invalid JSON triggers error', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const errors = [];
  receiver.onError((err) => errors.push(err));

  receiver.onChunkFrame({
    transfer_id: 'tx_00000006',
    raw_seq: kSeqFinalBit | 0,
    payload: new TextEncoder().encode('not json {{{'),
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'json_parse_failed');
});

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

test('StreamSender: concurrent sends are serialized', async () => {
  const jsonCap = makeJsonCapture();
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: jsonCap.writeJsonFn,
    writeBinaryFn: binCap.writeBinaryFn,
  });

  const p1 = sender.send({ id: 1 });
  const p2 = sender.send({ id: 2 });
  await Promise.all([p1, p2]);

  assert.equal(jsonCap.messages.length, 2);
  assert.equal(jsonCap.messages[0].id, 1);
  assert.equal(jsonCap.messages[1].id, 2);
});

test('StreamSender: writeJsonFn error propagates', async () => {
  const binCap = makeBinaryCapture();
  const sender = new StreamSender({
    writeJsonFn: async () => { throw new Error('ble_disconnected'); },
    writeBinaryFn: binCap.writeBinaryFn,
  });

  await assert.rejects(
    () => sender.send({ type: 'small' }),
    /ble_disconnected/
  );
});

test('StreamReceiver: stale transfer_id starts new transfer', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onChunkFrame({
    transfer_id: 'tx_aaaa0001',
    raw_seq: 0,
    payload: new TextEncoder().encode('partial'),
  });

  const obj = { replaced: true };
  receiver.onChunkFrame({
    transfer_id: 'tx_bbbb0002',
    raw_seq: kSeqFinalBit | 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('StreamReceiver: non-Uint8Array payload sends nack', async () => {
  const cap = makeJsonCapture();
  const receiver = new StreamReceiver({ writeJsonFn: cap.writeJsonFn });
  const messages = [];
  receiver.onMessage((msg) => messages.push(msg));

  receiver.onChunkFrame({
    transfer_id: 'tx_00000099',
    raw_seq: kSeqFinalBit | 0,
    payload: 'not a buffer',
  });

  assert.equal(messages.length, 0);
  const nack = cap.messages.find((m) => m.type === 'stream.nack');
  assert.ok(nack, 'should have sent nack');
  assert.equal(nack.reason, 'invalid_payload');
});
