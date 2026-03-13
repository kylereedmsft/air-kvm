import test from 'node:test';
import assert from 'node:assert/strict';

import {
  kFrameType,
  kHeaderLen,
  kCrcLen,
  kMinFrameLen,
  kMaxPayload,
  encodeFrame,
  decodeFrame,
  tryExtractFrame,
  makeTransferId,
  encodeChunkFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
  encodeControlFrame,
  encodeLogFrame,
} from '../../shared/binary_frame.js';

// Shared code returns Uint8Array; helpers for test convenience.
const enc = new TextEncoder();
const dec = new TextDecoder();
function u8(str) { return enc.encode(str); }
function u8FromBytes(arr) { return new Uint8Array(arr); }
function concatU8(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── frame tests ────────────────────────────────────────────────────────

test('frame: round-trip all 6 frame types', () => {
  const types = [
    { type: kFrameType.CHUNK,   payload: u8('data') },
    { type: kFrameType.CONTROL, payload: u8('{"a":1}') },
    { type: kFrameType.LOG,     payload: u8('log msg') },
    { type: kFrameType.ACK,     payload: new Uint8Array(0) },
    { type: kFrameType.NACK,    payload: new Uint8Array(0) },
    { type: kFrameType.RESET,   payload: new Uint8Array(0) },
  ];
  for (const { type, payload } of types) {
    const encoded = encodeFrame({ type, transferId: 42, seq: 7, payload });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true, `type 0x${type.toString(16)} should decode ok`);
    assert.equal(decoded.type, type);
    assert.equal(decoded.transferId, 42);
    assert.equal(decoded.seq, 7);
    assert.deepEqual(decoded.payload, payload);
  }
});

test('frame: chunk frame with known payload', () => {
  const payload = u8FromBytes([0xDE, 0xAD, 0xBE, 0xEF]);
  const encoded = encodeChunkFrame({ transferId: 100, seq: 3, payload });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CHUNK);
  assert.deepEqual(decoded.payload, payload);
});

test('frame: control frame JSON roundtrip', () => {
  const msg = { action: 'ping', value: 42 };
  const encoded = encodeControlFrame(msg);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CONTROL);
  const parsed = JSON.parse(dec.decode(decoded.payload));
  assert.deepEqual(parsed, msg);
});

test('frame: log frame text roundtrip', () => {
  const text = 'hello log';
  const encoded = encodeLogFrame(text);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.LOG);
  assert.equal(dec.decode(decoded.payload), text);
});

test('frame: ack/nack/reset zero payload', () => {
  for (const { fn, type, seq } of [
    { fn: () => encodeAckFrame({ transferId: 10, seq: 5 }), type: kFrameType.ACK, seq: 5 },
    { fn: () => encodeNackFrame({ transferId: 20, seq: 8 }), type: kFrameType.NACK, seq: 8 },
    { fn: () => encodeResetFrame({ transferId: 30 }), type: kFrameType.RESET, seq: 0 },
  ]) {
    const decoded = decodeFrame(fn());
    assert.equal(decoded.ok, true);
    assert.equal(decoded.type, type);
    assert.equal(decoded.payload.length, 0);
    assert.equal(decoded.seq, seq);
  }
});

test('frame: reset always has seq=0', () => {
  const encoded = encodeResetFrame({ transferId: 999 });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.seq, 0);
  assert.equal(decoded.transferId, 999);
});

test('frame: CRC validation – corrupt payload byte', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: u8('hello') });
  const corrupted = new Uint8Array(encoded);
  corrupted[kHeaderLen] ^= 0xff; // flip first payload byte
  const decoded = decodeFrame(corrupted);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'crc_mismatch');
});

test('frame: max payload (255 bytes)', () => {
  const payload = new Uint8Array(255).fill(0xAB);
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.payload.length, 255);
  assert.deepEqual(decoded.payload, payload);
});

test('frame: payload too large (256 bytes) throws', () => {
  const payload = new Uint8Array(256);
  assert.throws(() => encodeChunkFrame({ transferId: 1, seq: 0, payload }), /payload_too_large/);
});

test('frame: empty payload chunk (zero-length terminator)', () => {
  const encoded = encodeChunkFrame({ transferId: 50, seq: 3, payload: new Uint8Array(0) });
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.type, kFrameType.CHUNK);
  assert.equal(decoded.payload.length, 0);
  assert.equal(decoded.transferId, 50);
  assert.equal(decoded.seq, 3);
});

test('frame: transfer ID boundaries', () => {
  for (const tid of [0, 65535, 12345]) {
    const encoded = encodeChunkFrame({ transferId: tid, seq: 0, payload: u8('x') });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.transferId, tid);
  }
});

test('frame: seq boundaries', () => {
  for (const seq of [0, 65535]) {
    const encoded = encodeChunkFrame({ transferId: 1, seq, payload: u8('y') });
    const decoded = decodeFrame(encoded);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.seq, seq);
  }
});

test('frame: invalid transferId throws', () => {
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 70000, seq: 0, payload: new Uint8Array(0) }), /invalid_transfer_id/);
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: -1, seq: 0, payload: new Uint8Array(0) }), /invalid_transfer_id/);
});

test('frame: invalid seq throws', () => {
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: 70000, payload: new Uint8Array(0) }), /invalid_seq/);
  assert.throws(() => encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: -1, payload: new Uint8Array(0) }), /invalid_seq/);
});

test('frame: bad magic', () => {
  const buf = new Uint8Array(kMinFrameLen);
  buf[0] = 0x00;
  buf[1] = 0x00;
  const decoded = decodeFrame(buf);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'bad_magic');
});

test('frame: truncated frame', () => {
  const decoded = decodeFrame(new Uint8Array(8));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'frame_too_short');
});

test('frame: length mismatch', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: u8('hello') });
  // Truncate: remove last 2 bytes so len field says 5 but data is shorter
  const truncated = new Uint8Array(encoded.subarray(0, encoded.length - 2));
  const decoded = decodeFrame(truncated);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error, 'length_mismatch');
});

test('frame: tryExtractFrame – multiple frames', () => {
  const f1 = encodeChunkFrame({ transferId: 1, seq: 0, payload: u8('aaa') });
  const f2 = encodeAckFrame({ transferId: 2, seq: 1 });
  const f3 = encodeLogFrame('test');
  const joined = concatU8(f1, f2, f3);

  const r1 = tryExtractFrame(joined);
  assert.ok(r1);
  assert.equal(r1.frame.type, kFrameType.CHUNK);
  assert.equal(r1.frame.transferId, 1);
  assert.deepEqual(r1.frame.payload, u8('aaa'));

  const r2 = tryExtractFrame(joined.subarray(r1.consumed));
  assert.ok(r2);
  assert.equal(r2.frame.type, kFrameType.ACK);
  assert.equal(r2.frame.transferId, 2);

  const r3 = tryExtractFrame(joined.subarray(r1.consumed + r2.consumed));
  assert.ok(r3);
  assert.equal(r3.frame.type, kFrameType.LOG);
  assert.equal(dec.decode(r3.frame.payload), 'test');
});

test('frame: tryExtractFrame – partial frame returns null', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: u8('data') });
  const half = encoded.subarray(0, Math.floor(encoded.length / 2));
  assert.equal(tryExtractFrame(half), null);
});

test('frame: tryExtractFrame – empty buffer returns null', () => {
  assert.equal(tryExtractFrame(new Uint8Array(0)), null);
});

test('frame: tryExtractFrame – error frame on bad CRC', () => {
  const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload: u8('hi') });
  const corrupted = new Uint8Array(encoded);
  corrupted[kHeaderLen] ^= 0xff;
  const result = tryExtractFrame(corrupted);
  assert.ok(result);
  assert.equal(result.frame.type, 'error');
  assert.equal(result.frame.error, 'crc_mismatch');
  assert.equal(result.consumed, corrupted.length);
});

test('frame: frame size verification', () => {
  for (const n of [0, 1, 100, 255]) {
    const payload = new Uint8Array(n).fill(0x42);
    const encoded = encodeChunkFrame({ transferId: 1, seq: 0, payload });
    assert.equal(encoded.length, 12 + n);
  }
});

test('frame: makeTransferId returns integer 0–65535', () => {
  for (let i = 0; i < 50; i++) {
    const tid = makeTransferId();
    assert.ok(Number.isInteger(tid));
    assert.ok(tid >= 0 && tid <= 65535);
  }
});

test('frame: bad type throws', () => {
  assert.throws(() => encodeFrame({ type: 0x07, transferId: 0, seq: 0, payload: new Uint8Array(0) }), /bad_type/);
  assert.throws(() => encodeFrame({ type: 0x00, transferId: 0, seq: 0, payload: new Uint8Array(0) }), /bad_type/);
});
