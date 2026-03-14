import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HalfPipe } from '../../shared/halfpipe.js';
import {
  decodeFrame,
  kFrameType,
  kMaxPayload,
  encodeChunkFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
  encodeFrame,
  kTarget,
} from '../../shared/binary_frame.js';

// Shared code returns Uint8Array; helpers for test convenience.
const enc = new TextEncoder();
const dec = new TextDecoder();
function u8(str) { return enc.encode(str); }

// ── Test helpers ────────────────────────────────────────────────────

function makeWriteCapture() {
  const frames = [];
  const writeFn = async (buf) => { frames.push(new Uint8Array(buf)); };
  return { frames, writeFn };
}

function inspectFrame(buf) {
  return decodeFrame(buf);
}

function simulateAck(hp, transferId, seq) {
  hp.onFrame({
    type: kFrameType.ACK,
    transferId,
    seq,
    payload: new Uint8Array(0),
  });
}

function simulateNack(hp, transferId, seq) {
  hp.onFrame({
    type: kFrameType.NACK,
    transferId,
    seq,
    payload: new Uint8Array(0),
  });
}

function simulateReset(hp) {
  hp.onFrame({
    type: kFrameType.RESET,
    transferId: 0,
    seq: 0,
    payload: new Uint8Array(0),
  });
}

/** Build a padded JSON string of exactly `targetLen` UTF-8 bytes. */
function makeJsonOfSize(targetLen) {
  // {"d":"XXXX..."} → overhead is 8 bytes: {"d":""}
  const overhead = 8;
  if (targetLen < overhead) throw new Error('targetLen too small');
  const pad = 'x'.repeat(targetLen - overhead);
  const json = `{"d":"${pad}"}`;
  assert.equal(enc.encode(json).length, targetLen);
  return json;
}

// ── TX Tests ────────────────────────────────────────────────────────

describe('HalfPipe TX', () => {
  let cap, hp;

  beforeEach(() => {
    cap = makeWriteCapture();
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 100, maxRetries: 3 , ackTarget: kTarget.MCP });
  });

  it('1. small message (single chunk)', async () => {
    const obj = { hello: 'world' };
    const p = hp.send(obj, kTarget.EXTENSION);

    // Wait a tick for the chunk to be written
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cap.frames.length, 1);

    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.CHUNK);
    assert.ok(f.payload.length < kMaxPayload);

    // Verify payload is the JSON
    assert.deepEqual(JSON.parse(dec.decode(f.payload)), obj);

    simulateAck(hp, f.transferId, f.seq);
    await p;
  });

  it('2. multi-chunk message (~600 bytes)', async () => {
    // Build object whose JSON is ~600 bytes
    const json = makeJsonOfSize(600);
    const obj = JSON.parse(json);
    const p = hp.send(obj, kTarget.EXTENSION);

    const expectedChunks = Math.ceil(600 / kMaxPayload); // 3 chunks (255+255+90)

    // ACK each chunk as it appears
    for (let i = 0; i < expectedChunks; i += 1) {
      await new Promise(r => setTimeout(r, 10));
      const f = inspectFrame(cap.frames[i]);
      assert.ok(f.ok);
      assert.equal(f.type, kFrameType.CHUNK);
      assert.equal(f.seq, i);
      simulateAck(hp, f.transferId, i);
    }

    await p;
    assert.equal(cap.frames.length, expectedChunks);
  });

  it('3. exact multiple of 255 sends zero-length terminator', async () => {
    const json = makeJsonOfSize(510); // 2 × 255
    const obj = JSON.parse(json);
    const p = hp.send(obj, kTarget.EXTENSION);

    // Expect 3 frames: 255, 255, 0 (terminator)
    for (let i = 0; i < 3; i += 1) {
      await new Promise(r => setTimeout(r, 10));
      const f = inspectFrame(cap.frames[i]);
      assert.ok(f.ok);
      assert.equal(f.type, kFrameType.CHUNK);
      assert.equal(f.seq, i);
      if (i < 2) {
        assert.equal(f.payload.length, 255);
      } else {
        assert.equal(f.payload.length, 0);
      }
      simulateAck(hp, f.transferId, i);
    }

    await p;
    assert.equal(cap.frames.length, 3);
  });

  it('4. ack timeout + retry', async () => {
    const obj = { retry: true };
    const p = hp.send(obj, kTarget.EXTENSION);

    // First attempt — don't ACK, wait for timeout + retry
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cap.frames.length, 1);

    // Wait for timeout (100ms) + retry
    await new Promise(r => setTimeout(r, 150));
    assert.equal(cap.frames.length, 2);

    // Verify both frames are the same chunk
    const f1 = inspectFrame(cap.frames[0]);
    const f2 = inspectFrame(cap.frames[1]);
    assert.equal(f1.transferId, f2.transferId);
    assert.equal(f1.seq, f2.seq);

    // Now ACK
    simulateAck(hp, f2.transferId, f2.seq);
    await p;
  });

  it('5. retries exhausted rejects', async () => {
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 50, maxRetries: 2 , ackTarget: kTarget.MCP });
    const p = hp.send({ fail: true }, kTarget.EXTENSION);

    // Wait for all attempts to timeout: (2+1) * 50ms + buffer
    await assert.rejects(p, /chunk_send_failed/);
  });

  it('6. nack triggers retry then ack succeeds', async () => {
    const obj = { nack_test: 1 };
    const p = hp.send(obj, kTarget.EXTENSION);

    await new Promise(r => setTimeout(r, 10));
    const f1 = inspectFrame(cap.frames[0]);
    simulateNack(hp, f1.transferId, f1.seq);

    // Retry happens
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cap.frames.length, 2);
    simulateAck(hp, f1.transferId, f1.seq);
    await p;
  });

  it('7. reset during send rejects with stream_reset', async () => {
    const obj = { reset_test: true };
    const p = hp.send(obj, kTarget.EXTENSION);

    await new Promise(r => setTimeout(r, 10));
    simulateReset(hp);

    await assert.rejects(p, { message: 'stream_reset' });
  });

  it('8. send queue — one at a time', async () => {
    const order = [];
    const obj1 = { q: 1 };
    const obj2 = { q: 2 };

    const p1 = hp.send(obj1, kTarget.EXTENSION);
    const p2 = hp.send(obj2, kTarget.EXTENSION);

    // First send's chunk should be written
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cap.frames.length, 1);
    const f1 = inspectFrame(cap.frames[0]);
    order.push(JSON.parse(dec.decode(f1.payload)).q);

    simulateAck(hp, f1.transferId, f1.seq);
    await p1;

    // Now second send proceeds
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cap.frames.length, 2);
    const f2 = inspectFrame(cap.frames[1]);
    order.push(JSON.parse(dec.decode(f2.payload)).q);

    simulateAck(hp, f2.transferId, f2.seq);
    await p2;

    assert.deepEqual(order, [1, 2]);
  });
});

// ── RX Tests ────────────────────────────────────────────────────────

describe('HalfPipe RX', () => {
  let cap, hp;

  beforeEach(() => {
    cap = makeWriteCapture();
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 100, maxRetries: 3 , ackTarget: kTarget.MCP });
  });

  it('9. single chunk receive', async () => {
    const obj = { rx: 'single' };
    const payload = u8(JSON.stringify(obj));

    let received = null;
    hp.onMessage((msg) => { received = msg; });

    hp.onFrame({
      type: kFrameType.CHUNK,
      transferId: 42,
      seq: 0,
      payload,
    });

    assert.deepEqual(received, obj);
  });

  it('10. multi-chunk receive', async () => {
    const json = makeJsonOfSize(600);
    const obj = JSON.parse(json);
    const bytes = u8(json);
    const tid = 100;

    let received = null;
    hp.onMessage((msg) => { received = msg; });

    const numChunks = Math.ceil(bytes.length / kMaxPayload);
    for (let i = 0; i < numChunks; i += 1) {
      const start = i * kMaxPayload;
      const end = Math.min(start + kMaxPayload, bytes.length);
      hp.onFrame({
        type: kFrameType.CHUNK,
        transferId: tid,
        seq: i,
        payload: bytes.subarray(start, end),
      });
    }

    assert.deepEqual(received, obj);

    // Verify ACK sent for each chunk
    assert.equal(cap.frames.length, numChunks);
    for (let i = 0; i < numChunks; i += 1) {
      const f = inspectFrame(cap.frames[i]);
      assert.ok(f.ok);
      assert.equal(f.type, kFrameType.ACK);
      assert.equal(f.transferId, tid);
      assert.equal(f.seq, i);
    }
  });

  it('11. zero-length terminator receive', async () => {
    const json = makeJsonOfSize(510); // 2 × 255
    const obj = JSON.parse(json);
    const bytes = u8(json);
    const tid = 200;

    let received = null;
    hp.onMessage((msg) => { received = msg; });

    // Chunk 0: 255 bytes
    hp.onFrame({ type: kFrameType.CHUNK, transferId: tid, seq: 0, payload: bytes.subarray(0, 255) });
    assert.equal(received, null); // not yet

    // Chunk 1: 255 bytes
    hp.onFrame({ type: kFrameType.CHUNK, transferId: tid, seq: 1, payload: bytes.subarray(255, 510) });
    assert.equal(received, null); // not yet

    // Chunk 2: zero-length terminator
    hp.onFrame({ type: kFrameType.CHUNK, transferId: tid, seq: 2, payload: new Uint8Array(0) });
    assert.deepEqual(received, obj);
  });

  it('12. ACK sent for each received chunk', () => {
    const payload = u8('{"a":1}');
    hp.onMessage(() => {});

    hp.onFrame({ type: kFrameType.CHUNK, transferId: 55, seq: 0, payload });

    assert.equal(cap.frames.length, 1);
    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.ACK);
    assert.equal(f.transferId, 55);
    assert.equal(f.seq, 0);
  });

  it('13. wrong seq sends NACK', () => {
    hp.onMessage(() => {});

    // Feed seq=1 without seq=0 first
    hp.onFrame({
      type: kFrameType.CHUNK,
      transferId: 60,
      seq: 1,
      payload: u8('data'),
    });

    assert.equal(cap.frames.length, 1);
    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.NACK);
    assert.equal(f.transferId, 60);
    assert.equal(f.seq, 1);
  });

  it('14. new transfer replaces partial', () => {
    let received = null;
    hp.onMessage((msg) => { received = msg; });

    // Start transfer A with a full 255-byte chunk (not final)
    const padA = new Uint8Array(kMaxPayload).fill(0x61); // 'a' repeated
    hp.onFrame({ type: kFrameType.CHUNK, transferId: 300, seq: 0, payload: padA });
    assert.equal(received, null);

    // Now start transfer B (different transferId) — replaces A
    const objB = { transfer: 'B' };
    const payloadB = u8(JSON.stringify(objB));
    hp.onFrame({ type: kFrameType.CHUNK, transferId: 301, seq: 0, payload: payloadB });

    assert.deepEqual(received, objB);
  });
});

// ── Reset Tests ─────────────────────────────────────────────────────

describe('HalfPipe Reset', () => {
  let cap, hp;

  beforeEach(() => {
    cap = makeWriteCapture();
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 100, maxRetries: 3 , ackTarget: kTarget.MCP });
  });

  it('15. reset() sends reset frame', async () => {
    await hp.reset();
    assert.equal(cap.frames.length, 1);
    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.RESET);
  });

  it('16. reset() clears TX state — send rejects, then new send works', async () => {
    const p = hp.send({ will_reset: true }, kTarget.EXTENSION);
    await new Promise(r => setTimeout(r, 10));

    await hp.reset();
    await assert.rejects(p, { message: 'stream_reset' });

    // New send should work
    cap.frames.length = 0;
    const p2 = hp.send({ after_reset: true }, kTarget.EXTENSION);
    await new Promise(r => setTimeout(r, 10));

    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.CHUNK);
    simulateAck(hp, f.transferId, f.seq);
    await p2;
  });

  it('17. reset() clears RX state — new transfer works', async () => {
    let received = null;
    hp.onMessage((msg) => { received = msg; });

    // Feed partial chunk (255 bytes, not final)
    const pad = new Uint8Array(kMaxPayload).fill(0x61);
    hp.onFrame({ type: kFrameType.CHUNK, transferId: 400, seq: 0, payload: pad });
    assert.equal(received, null);

    await hp.reset();
    cap.frames.length = 0;

    // Feed a new complete transfer
    const obj = { fresh: true };
    hp.onFrame({
      type: kFrameType.CHUNK,
      transferId: 401,
      seq: 0,
      payload: u8(JSON.stringify(obj)),
    });
    assert.deepEqual(received, obj);
  });

  it('18. incoming reset clears all state', async () => {
    let received = null;
    hp.onMessage((msg) => { received = msg; });

    // Start a send
    const p = hp.send({ will_be_reset: true }, kTarget.EXTENSION);
    await new Promise(r => setTimeout(r, 10));

    // Feed partial RX
    const pad = new Uint8Array(kMaxPayload).fill(0x61);
    hp.onFrame({ type: kFrameType.CHUNK, transferId: 500, seq: 0, payload: pad });

    // Incoming reset
    simulateReset(hp);

    await assert.rejects(p, { message: 'stream_reset' });
    assert.equal(received, null);

    // Verify RX is cleared by feeding a new transfer
    const obj = { after: 'reset' };
    hp.onFrame({
      type: kFrameType.CHUNK,
      transferId: 501,
      seq: 0,
      payload: u8(JSON.stringify(obj)),
    });
    assert.deepEqual(received, obj);
  });
});

// ── Control / Log Passthrough Tests ─────────────────────────────────

describe('HalfPipe Control/Log', () => {
  let cap, hp;

  beforeEach(() => {
    cap = makeWriteCapture();
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 100, maxRetries: 3 , ackTarget: kTarget.MCP });
  });

  it('19. control frame delivered', () => {
    const ctrlObj = { type: 'busy.changed', busy: true };
    let received = null;
    hp.onControl((msg) => { received = msg; });

    hp.onFrame({
      type: kFrameType.CONTROL,
      transferId: 0,
      seq: 0,
      payload: u8(JSON.stringify(ctrlObj)),
    });

    assert.deepEqual(received, ctrlObj);
  });

  it('20. log frame delivered', () => {
    const text = 'firmware: BLE connected';
    let received = null;
    hp.onLog((t) => { received = t; });

    hp.onFrame({
      type: kFrameType.LOG,
      transferId: 0,
      seq: 0,
      payload: u8(text),
    });

    assert.equal(received, text);
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────

describe('HalfPipe Edge Cases', () => {
  let cap, hp;

  beforeEach(() => {
    cap = makeWriteCapture();
    hp = new HalfPipe({ writeFn: cap.writeFn, ackTimeoutMs: 100, maxRetries: 3 , ackTarget: kTarget.MCP });
  });

  it('21. empty object send/receive', async () => {
    const obj = {};
    const p = hp.send(obj, kTarget.EXTENSION);

    await new Promise(r => setTimeout(r, 10));
    const f = inspectFrame(cap.frames[0]);
    assert.ok(f.ok);
    assert.equal(f.type, kFrameType.CHUNK);
    assert.equal(dec.decode(f.payload), '{}');
    assert.equal(f.payload.length, 2);

    simulateAck(hp, f.transferId, f.seq);
    await p;

    // Also test receive side
    let received = null;
    hp.onMessage((msg) => { received = msg; });
    hp.onFrame({
      type: kFrameType.CHUNK,
      transferId: 999,
      seq: 0,
      payload: u8('{}'),
    });
    assert.deepEqual(received, {});
  });

  it('22. close() rejects pending send', async () => {
    const p = hp.send({ close_test: true }, kTarget.EXTENSION);
    await new Promise(r => setTimeout(r, 10));

    hp.close();
    await assert.rejects(p, { message: 'halfpipe_closed' });
  });
});
