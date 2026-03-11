import test from 'node:test';
import assert from 'node:assert/strict';
import { HalfPipe } from '../src/halfpipe.js';
import {
  decodeFrame,
  kFrameType,
  kV2MaxPayload,
} from '../src/binary_frame.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWriteCapture() {
  const frames = [];
  const writeFn = async (buf) => { frames.push(new Uint8Array(buf)); };
  return { frames, writeFn };
}

function simulateAck(hp, transferId, seq) {
  hp.onFrame({ type: kFrameType.ACK, transferId, seq, payload: new Uint8Array(0) });
}

function simulateNack(hp, transferId, seq) {
  hp.onFrame({ type: kFrameType.NACK, transferId, seq, payload: new Uint8Array(0) });
}

function simulateReset(hp, transferId = 0) {
  hp.onFrame({ type: kFrameType.RESET, transferId, seq: 0, payload: new Uint8Array(0) });
}

/** Decode all captured frames, returning parsed results. */
function decodeAll(frames) {
  return frames.map((f) => decodeFrame(f));
}

/** Filter decoded frames to only CHUNK frames. */
function chunkFrames(decoded) {
  return decoded.filter((d) => d.ok && d.type === kFrameType.CHUNK);
}

/** Filter decoded frames to only ACK frames. */
function ackFrames(decoded) {
  return decoded.filter((d) => d.ok && d.type === kFrameType.ACK);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a JSON string of approximately `targetBytes` UTF-8 length. */
function makeJsonOfSize(targetBytes) {
  // {"d":"xxx...xxx"} → overhead ~7 bytes
  const overhead = 7;
  const fill = 'x'.repeat(Math.max(0, targetBytes - overhead));
  return JSON.stringify({ d: fill });
}

// ---------------------------------------------------------------------------
// TX Tests
// ---------------------------------------------------------------------------

test('TX 1: small message (single chunk)', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500 });
  const obj = { hello: 'world' };

  const p = hp.send(obj);
  await wait(20);

  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  assert.equal(chunks.length, 1, 'should have 1 chunk');
  assert.ok(chunks[0].payload.length < kV2MaxPayload, 'single chunk < 255');

  // ACK it
  simulateAck(hp, chunks[0].transferId, chunks[0].seq);
  await p;
});

test('TX 2: multi-chunk message', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500 });

  // ~600-byte payload → 3 chunks (255+255+90)
  const obj = { data: 'A'.repeat(580) };
  const p = hp.send(obj);

  // ACK each chunk as it arrives
  for (let i = 0; i < 10; i += 1) {
    await wait(10);
    const decoded = decodeAll(frames);
    const chunks = chunkFrames(decoded);
    const unacked = chunks.filter(
      (c) => !ackFrames(decoded).some((a) => a.transferId === c.transferId && a.seq === c.seq)
    );
    for (const c of unacked) {
      simulateAck(hp, c.transferId, c.seq);
    }
  }

  await p;
  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
});

test('TX 3: exact multiple of 255 → terminator', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500 });

  // Build JSON payload of exactly 510 bytes
  const encoder = new TextEncoder();
  let obj = { d: '' };
  // Adjust until encoded JSON is exactly 510
  while (encoder.encode(JSON.stringify(obj)).length < 510) {
    obj.d += 'x';
  }
  while (encoder.encode(JSON.stringify(obj)).length > 510) {
    obj.d = obj.d.slice(0, -1);
  }
  assert.equal(encoder.encode(JSON.stringify(obj)).length, 510);

  const p = hp.send(obj);

  // ACK chunks as they arrive (expect 3: 255+255+0)
  for (let i = 0; i < 10; i += 1) {
    await wait(10);
    const decoded = decodeAll(frames);
    const chunks = chunkFrames(decoded);
    for (const c of chunks) {
      simulateAck(hp, c.transferId, c.seq);
    }
  }

  await p;
  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  assert.equal(chunks.length, 3, 'should be 3 frames: 255 + 255 + terminator');
  assert.equal(chunks[0].payload.length, 255);
  assert.equal(chunks[1].payload.length, 255);
  assert.equal(chunks[2].payload.length, 0, 'last frame is zero-length terminator');
});

test('TX 4: ack timeout + retry', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 100, maxRetries: 3 });

  const obj = { retry: true };
  const p = hp.send(obj);

  // Wait for timeout + re-send
  await wait(150);
  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  assert.ok(chunks.length >= 2, 'should have retried at least once');

  // ACK latest
  const last = chunks[chunks.length - 1];
  simulateAck(hp, last.transferId, last.seq);
  await p;
});

test('TX 5: retries exhausted → reject', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 50, maxRetries: 2 });

  const obj = { fail: true };
  await assert.rejects(
    () => hp.send(obj),
    /chunk_send_failed:seq=0/
  );

  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  // 1 initial + 2 retries = 3
  assert.equal(chunks.length, 3, 'initial + 2 retries');
});

test('TX 6: nack triggers retry', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500, maxRetries: 3 });

  const obj = { nack: true };
  const p = hp.send(obj);

  await wait(20);
  let decoded = decodeAll(frames);
  let chunks = chunkFrames(decoded);
  assert.equal(chunks.length, 1);

  // NACK → causes retry
  simulateNack(hp, chunks[0].transferId, chunks[0].seq);
  await wait(20);

  decoded = decodeAll(frames);
  chunks = chunkFrames(decoded);
  assert.ok(chunks.length >= 2, 'should have retried after NACK');

  // ACK the retry
  const last = chunks[chunks.length - 1];
  simulateAck(hp, last.transferId, last.seq);
  await p;
});

test('TX 7: reset during send → rejects with stream_reset', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 5000 });

  const obj = { data: 'x'.repeat(300) };
  const p = hp.send(obj);

  await wait(20);
  simulateReset(hp);

  await assert.rejects(p, /stream_reset/);
});

test('TX 8: send queue — second waits for first', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500 });

  const order = [];
  const p1 = hp.send({ id: 1 }).then(() => order.push(1));
  const p2 = hp.send({ id: 2 }).then(() => order.push(2));

  // ACK chunks as they arrive
  for (let i = 0; i < 20; i += 1) {
    await wait(10);
    const decoded = decodeAll(frames);
    const chunks = chunkFrames(decoded);
    for (const c of chunks) {
      simulateAck(hp, c.transferId, c.seq);
    }
  }

  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2], 'first send resolves before second');
});

// ---------------------------------------------------------------------------
// RX Tests
// ---------------------------------------------------------------------------

test('RX 9: single chunk receive', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  const obj = { type: 'test', value: 42 };
  const payload = new TextEncoder().encode(JSON.stringify(obj));
  assert.ok(payload.length < kV2MaxPayload, 'payload must be < 255 for single chunk');

  hp.onFrame({ type: kFrameType.CHUNK, transferId: 100, seq: 0, payload });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('RX 10: multi-chunk receive', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  const obj = { data: 'B'.repeat(500) };
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const transferId = 200;

  let seq = 0;
  for (let off = 0; off < bytes.length; off += kV2MaxPayload) {
    const chunk = bytes.slice(off, off + kV2MaxPayload);
    hp.onFrame({ type: kFrameType.CHUNK, transferId, seq, payload: chunk });
    seq += 1;
  }

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);

  // Verify ACKs were sent
  const decoded = decodeAll(frames);
  const acks = ackFrames(decoded);
  assert.equal(acks.length, seq, 'one ACK per chunk');
});

test('RX 11: zero-length terminator', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  // Build payload of exactly 255 bytes
  const encoder = new TextEncoder();
  let obj = { d: '' };
  while (encoder.encode(JSON.stringify(obj)).length < 255) obj.d += 'z';
  while (encoder.encode(JSON.stringify(obj)).length > 255) obj.d = obj.d.slice(0, -1);
  const bytes = encoder.encode(JSON.stringify(obj));
  assert.equal(bytes.length, 255);

  const transferId = 300;

  // Chunk 0: 255 bytes (full)
  hp.onFrame({ type: kFrameType.CHUNK, transferId, seq: 0, payload: bytes });
  assert.equal(messages.length, 0, 'not yet complete');

  // Chunk 1: 0-length terminator
  hp.onFrame({ type: kFrameType.CHUNK, transferId, seq: 1, payload: new Uint8Array(0) });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('RX 12: ACK sent for each chunk', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  hp.onMessage(() => {});

  const transferId = 400;
  const payload1 = new Uint8Array(kV2MaxPayload).fill(0x61); // 'a'
  const payload2 = new TextEncoder().encode('{}');

  hp.onFrame({ type: kFrameType.CHUNK, transferId, seq: 0, payload: payload1 });

  let decoded = decodeAll(frames);
  let acks = ackFrames(decoded);
  assert.equal(acks.length, 1, 'ACK after first chunk');
  assert.equal(acks[0].transferId, transferId);
  assert.equal(acks[0].seq, 0);

  hp.onFrame({ type: kFrameType.CHUNK, transferId, seq: 1, payload: payload2 });

  decoded = decodeAll(frames);
  acks = ackFrames(decoded);
  assert.equal(acks.length, 2, 'ACK after second chunk');
  assert.equal(acks[1].seq, 1);
});

test('RX 13: wrong seq → NACK', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  const transferId = 500;
  // Send seq=1 without seq=0
  hp.onFrame({ type: kFrameType.CHUNK, transferId, seq: 1, payload: new TextEncoder().encode('{}') });

  assert.equal(messages.length, 0, 'message not delivered');
  const decoded = decodeAll(frames);
  const nacks = decoded.filter((d) => d.ok && d.type === kFrameType.NACK);
  assert.equal(nacks.length, 1, 'should have sent NACK');
  assert.equal(nacks[0].transferId, transferId);
  assert.equal(nacks[0].seq, 1);
});

test('RX 14: new transfer replaces partial', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  // Start transfer A with a full chunk (not complete)
  hp.onFrame({ type: kFrameType.CHUNK, transferId: 600, seq: 0, payload: new Uint8Array(kV2MaxPayload).fill(0x62) });
  assert.equal(messages.length, 0);

  // Start transfer B — replaces A
  const obj = { replaced: true };
  hp.onFrame({
    type: kFrameType.CHUNK,
    transferId: 601,
    seq: 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

// ---------------------------------------------------------------------------
// Reset Tests
// ---------------------------------------------------------------------------

test('Reset 15: reset() sends reset frame', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });

  await hp.reset();

  const decoded = decodeAll(frames);
  const resets = decoded.filter((d) => d.ok && d.type === kFrameType.RESET);
  assert.equal(resets.length, 1, 'should have sent RESET frame');
});

test('Reset 16: reset() clears TX → rejects pending, new send works', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 5000 });

  const p = hp.send({ big: 'x'.repeat(300) });
  await wait(20);

  await hp.reset();
  await assert.rejects(p, /stream_reset/);

  // New send should work
  const p2 = hp.send({ after: 'reset' });
  await wait(20);
  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  const latest = chunks[chunks.length - 1];
  simulateAck(hp, latest.transferId, latest.seq);
  await p2;
});

test('Reset 17: reset() clears RX → new transfer works', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  // Partial RX
  hp.onFrame({ type: kFrameType.CHUNK, transferId: 700, seq: 0, payload: new Uint8Array(kV2MaxPayload).fill(0x63) });
  assert.equal(messages.length, 0);

  await hp.reset();

  // New transfer works
  const obj = { fresh: true };
  hp.onFrame({
    type: kFrameType.CHUNK,
    transferId: 701,
    seq: 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

test('Reset 18: incoming reset clears all', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 5000 });
  const messages = [];
  hp.onMessage((msg) => messages.push(msg));

  // Start TX
  const p = hp.send({ data: 'x'.repeat(300) });
  await wait(20);

  // Partial RX
  hp.onFrame({ type: kFrameType.CHUNK, transferId: 800, seq: 0, payload: new Uint8Array(kV2MaxPayload).fill(0x64) });

  // Incoming RESET
  simulateReset(hp);

  await assert.rejects(p, /stream_reset/);

  // RX cleared — new transfer starts fresh from seq 0
  const obj = { post_reset: true };
  hp.onFrame({
    type: kFrameType.CHUNK,
    transferId: 801,
    seq: 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], obj);
});

// ---------------------------------------------------------------------------
// Control / Log Tests
// ---------------------------------------------------------------------------

test('Control 19: control frame delivered', () => {
  const { writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const controls = [];
  hp.onControl((msg) => controls.push(msg));

  const obj = { type: 'busy.changed', busy: false };
  hp.onFrame({
    type: kFrameType.CONTROL,
    transferId: 0,
    seq: 0,
    payload: new TextEncoder().encode(JSON.stringify(obj)),
  });

  assert.equal(controls.length, 1);
  assert.deepEqual(controls[0], obj);
});

test('Log 20: log frame delivered', () => {
  const { writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn });
  const logs = [];
  hp.onLog((text) => logs.push(text));

  hp.onFrame({
    type: kFrameType.LOG,
    transferId: 0,
    seq: 0,
    payload: new TextEncoder().encode('Hello from firmware'),
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0], 'Hello from firmware');
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

test('Edge 21: empty object', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 500 });

  const p = hp.send({});
  await wait(20);

  const decoded = decodeAll(frames);
  const chunks = chunkFrames(decoded);
  assert.equal(chunks.length, 1);

  simulateAck(hp, chunks[0].transferId, chunks[0].seq);
  await p;
});

test('Edge 22: close() rejects pending with halfpipe_closed', async () => {
  const { frames, writeFn } = makeWriteCapture();
  const hp = new HalfPipe({ writeFn, ackTimeoutMs: 5000 });

  const p = hp.send({ data: 'x'.repeat(300) });
  await wait(20);

  hp.close();

  await assert.rejects(p, /halfpipe_closed/);

  // Further sends also rejected
  await assert.rejects(() => hp.send({ after: 'close' }), /halfpipe_closed/);
});
