import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32,
  kMagic0,
  kMagic1,
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
  encodeControlFrame,
  encodeLogFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
} from '../../shared/binary_frame.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// -------------------------------------------------------
// helpers
// -------------------------------------------------------
function fillBytes(len, seed = 0xAB) {
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i++) a[i] = (seed + i) & 0xff;
  return a;
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// -------------------------------------------------------
// round-trip all 6 types
// -------------------------------------------------------
describe('round-trip all 6 types', () => {
  const types = [
    { name: 'CHUNK',   type: kFrameType.CHUNK,   payload: new Uint8Array([1, 2, 3]) },
    { name: 'CONTROL', type: kFrameType.CONTROL,  payload: enc.encode('{"a":1}') },
    { name: 'LOG',     type: kFrameType.LOG,      payload: enc.encode('hello') },
    { name: 'ACK',     type: kFrameType.ACK,      payload: new Uint8Array(0) },
    { name: 'NACK',    type: kFrameType.NACK,     payload: new Uint8Array(0) },
    { name: 'RESET',   type: kFrameType.RESET,    payload: new Uint8Array(0) },
  ];

  for (const { name, type, payload } of types) {
    it(`round-trips ${name}`, () => {
      const frame = encodeFrame({ type, transferId: 42, seq: 7, payload });
      const r = decodeFrame(frame);
      assert.equal(r.ok, true);
      assert.equal(r.type, type);
      assert.equal(r.transferId, 42);
      assert.equal(r.seq, 7);
      assert.deepEqual(r.payload, payload);
    });
  }
});

// -------------------------------------------------------
// chunk frame with data
// -------------------------------------------------------
describe('chunk frame with data', () => {
  it('encodes and decodes known payload bytes', () => {
    const payload = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const frame = encodeChunkFrame({ transferId: 100, seq: 5, payload });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.CHUNK);
    assert.deepEqual(r.payload, payload);
  });
});

// -------------------------------------------------------
// control frame
// -------------------------------------------------------
describe('control frame', () => {
  it('encodes JSON object and decodes payload', () => {
    const msg = { action: 'ping', ts: 12345 };
    const frame = encodeControlFrame(msg);
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.CONTROL);
    const parsed = JSON.parse(dec.decode(r.payload));
    assert.deepEqual(parsed, msg);
  });
});

// -------------------------------------------------------
// log frame
// -------------------------------------------------------
describe('log frame', () => {
  it('encodes text and decodes payload', () => {
    const text = 'debug info line';
    const frame = encodeLogFrame(text);
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.LOG);
    assert.equal(dec.decode(r.payload), text);
  });
});

// -------------------------------------------------------
// ack / nack / reset zero payload
// -------------------------------------------------------
describe('ack/nack/reset zero payload', () => {
  it('ack has zero-length payload and correct fields', () => {
    const frame = encodeAckFrame({ transferId: 999, seq: 3 });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.ACK);
    assert.equal(r.payload.length, 0);
    assert.equal(r.transferId, 999);
    assert.equal(r.seq, 3);
  });

  it('nack has zero-length payload and correct fields', () => {
    const frame = encodeNackFrame({ transferId: 500, seq: 10 });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.NACK);
    assert.equal(r.payload.length, 0);
    assert.equal(r.transferId, 500);
    assert.equal(r.seq, 10);
  });

  it('reset has zero-length payload and correct fields', () => {
    const frame = encodeResetFrame({ transferId: 1 });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.type, kFrameType.RESET);
    assert.equal(r.payload.length, 0);
    assert.equal(r.transferId, 1);
  });
});

// -------------------------------------------------------
// reset seq is 0
// -------------------------------------------------------
describe('reset seq is 0', () => {
  it('encodeResetFrame always sets seq to 0', () => {
    const frame = encodeResetFrame({ transferId: 77 });
    const r = decodeFrame(frame);
    assert.equal(r.seq, 0);
  });
});

// -------------------------------------------------------
// CRC validation
// -------------------------------------------------------
describe('CRC validation', () => {
  it('corrupt one byte → crc_mismatch', () => {
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload: new Uint8Array([0x42]) });
    // corrupt payload byte
    frame[kHeaderLen] ^= 0xff;
    const r = decodeFrame(frame);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'crc_mismatch');
    assert.equal(r.type, kFrameType.CHUNK);
    assert.equal(r.transferId, 1);
    assert.equal(r.seq, 0);
    assert.equal(typeof r.gotCrc, 'number');
    assert.equal(typeof r.wantCrc, 'number');
    assert.notEqual(r.gotCrc, r.wantCrc);
  });
});

// -------------------------------------------------------
// max payload (255 bytes)
// -------------------------------------------------------
describe('max payload', () => {
  it('encodes and decodes 255-byte payload', () => {
    const payload = fillBytes(255);
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload, payload);
  });
});

// -------------------------------------------------------
// payload too large
// -------------------------------------------------------
describe('payload too large', () => {
  it('256-byte payload throws', () => {
    assert.throws(
      () => encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload: fillBytes(256) }),
      { message: 'payload_too_large' }
    );
  });
});

// -------------------------------------------------------
// empty payload chunk (zero-length terminator)
// -------------------------------------------------------
describe('empty payload chunk', () => {
  it('encodes and decodes zero-length payload', () => {
    const frame = encodeChunkFrame({ transferId: 55, seq: 3, payload: new Uint8Array(0) });
    const r = decodeFrame(frame);
    assert.equal(r.ok, true);
    assert.equal(r.payload.length, 0);
    assert.equal(r.transferId, 55);
    assert.equal(r.seq, 3);
  });
});

// -------------------------------------------------------
// transfer ID boundaries
// -------------------------------------------------------
describe('transfer ID boundaries', () => {
  for (const tid of [0, 65535]) {
    it(`transferId=${tid} round-trips`, () => {
      const frame = encodeFrame({ type: kFrameType.ACK, transferId: tid, seq: 0 });
      const r = decodeFrame(frame);
      assert.equal(r.ok, true);
      assert.equal(r.transferId, tid);
    });
  }

  it('random transferId round-trips', () => {
    const tid = makeTransferId();
    const frame = encodeFrame({ type: kFrameType.ACK, transferId: tid, seq: 0 });
    const r = decodeFrame(frame);
    assert.equal(r.transferId, tid);
  });
});

// -------------------------------------------------------
// seq boundaries
// -------------------------------------------------------
describe('seq boundaries', () => {
  for (const s of [0, 65535]) {
    it(`seq=${s} round-trips`, () => {
      const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: s, payload: new Uint8Array(0) });
      const r = decodeFrame(frame);
      assert.equal(r.ok, true);
      assert.equal(r.seq, s);
    });
  }
});

// -------------------------------------------------------
// invalid transferId
// -------------------------------------------------------
describe('invalid transferId', () => {
  it('70000 throws', () => {
    assert.throws(
      () => encodeFrame({ type: kFrameType.ACK, transferId: 70000, seq: 0 }),
      { message: 'invalid_transfer_id' }
    );
  });

  it('negative throws', () => {
    assert.throws(
      () => encodeFrame({ type: kFrameType.ACK, transferId: -1, seq: 0 }),
      { message: 'invalid_transfer_id' }
    );
  });
});

// -------------------------------------------------------
// invalid seq
// -------------------------------------------------------
describe('invalid seq', () => {
  it('70000 throws', () => {
    assert.throws(
      () => encodeFrame({ type: kFrameType.ACK, transferId: 0, seq: 70000 }),
      { message: 'invalid_seq' }
    );
  });

  it('negative throws', () => {
    assert.throws(
      () => encodeFrame({ type: kFrameType.ACK, transferId: 0, seq: -1 }),
      { message: 'invalid_seq' }
    );
  });
});

// -------------------------------------------------------
// bad magic
// -------------------------------------------------------
describe('bad magic', () => {
  it('returns bad_magic', () => {
    const frame = encodeFrame({ type: kFrameType.ACK, transferId: 0, seq: 0 });
    frame[0] = 0x00;
    const r = decodeFrame(frame);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_magic');
  });
});

// -------------------------------------------------------
// truncated frame
// -------------------------------------------------------
describe('truncated frame', () => {
  it('< 12 bytes → frame_too_short', () => {
    const r = decodeFrame(new Uint8Array([0x41, 0x4b, 0x01, 0, 0, 0, 0]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'frame_too_short');
  });
});

// -------------------------------------------------------
// length mismatch
// -------------------------------------------------------
describe('length mismatch', () => {
  it('len says 10 but data shorter', () => {
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: 0, payload: new Uint8Array(10) });
    // Truncate: remove last 5 bytes so actual frame is shorter than len indicates
    const truncated = frame.slice(0, frame.length - 5);
    const r = decodeFrame(truncated);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'length_mismatch');
    assert.equal(r.type, kFrameType.CHUNK);
    assert.equal(r.transferId, 0);
    assert.equal(r.seq, 0);
    assert.equal(r.len, 10);
  });
});

// -------------------------------------------------------
// tryExtractFrame: multiple frames
// -------------------------------------------------------
describe('tryExtractFrame: multiple frames', () => {
  it('extracts 3 frames sequentially', () => {
    const f1 = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload: new Uint8Array([0xAA]) });
    const f2 = encodeFrame({ type: kFrameType.ACK, transferId: 2, seq: 1 });
    const f3 = encodeFrame({ type: kFrameType.LOG, transferId: 3, seq: 2, payload: enc.encode('hi') });
    let buf = concat(f1, f2, f3);

    const r1 = tryExtractFrame(buf);
    assert.notEqual(r1, null);
    assert.equal(r1.frame.type, kFrameType.CHUNK);
    assert.equal(r1.consumed, f1.length);
    buf = buf.slice(r1.consumed);

    const r2 = tryExtractFrame(buf);
    assert.notEqual(r2, null);
    assert.equal(r2.frame.type, kFrameType.ACK);
    assert.equal(r2.consumed, f2.length);
    buf = buf.slice(r2.consumed);

    const r3 = tryExtractFrame(buf);
    assert.notEqual(r3, null);
    assert.equal(r3.frame.type, kFrameType.LOG);
    assert.equal(r3.consumed, f3.length);
  });
});

// -------------------------------------------------------
// tryExtractFrame: partial frame
// -------------------------------------------------------
describe('tryExtractFrame: partial frame', () => {
  it('half a frame → null', () => {
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload: fillBytes(50) });
    const half = frame.slice(0, Math.floor(frame.length / 2));
    assert.equal(tryExtractFrame(half), null);
  });
});

// -------------------------------------------------------
// tryExtractFrame: empty buffer
// -------------------------------------------------------
describe('tryExtractFrame: empty buffer', () => {
  it('returns null', () => {
    assert.equal(tryExtractFrame(new Uint8Array(0)), null);
  });
});

// -------------------------------------------------------
// tryExtractFrame: CRC error
// -------------------------------------------------------
describe('tryExtractFrame: CRC error', () => {
  it('returns error frame + consumed', () => {
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 1, seq: 0, payload: new Uint8Array([0x42]) });
    frame[kHeaderLen] ^= 0xff; // corrupt payload
    const r = tryExtractFrame(frame);
    assert.notEqual(r, null);
    assert.equal(r.frame.type, 'error');
    assert.equal(r.frame.error, 'crc_mismatch');
    assert.equal(r.consumed, frame.length);
  });
});

// -------------------------------------------------------
// frame size
// -------------------------------------------------------
describe('frame size', () => {
  for (const n of [0, 1, 10, 100, 255]) {
    it(`payload ${n} bytes → total ${12 + n}`, () => {
      const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: 0, payload: fillBytes(n) });
      assert.equal(frame.length, 12 + n);
    });
  }
});

// -------------------------------------------------------
// makeTransferId
// -------------------------------------------------------
describe('makeTransferId', () => {
  it('returns integer in 0–65535', () => {
    for (let i = 0; i < 100; i++) {
      const tid = makeTransferId();
      assert.equal(Number.isInteger(tid), true);
      assert.ok(tid >= 0 && tid <= 0xffff, `${tid} out of range`);
    }
  });
});

// -------------------------------------------------------
// bad type
// -------------------------------------------------------
describe('bad type', () => {
  it('type=0x07 throws on encode', () => {
    assert.throws(
      () => encodeFrame({ type: 0x07, transferId: 0, seq: 0 }),
      { message: 'bad_type' }
    );
  });

  it('type=0x00 throws on encode', () => {
    assert.throws(
      () => encodeFrame({ type: 0x00, transferId: 0, seq: 0 }),
      { message: 'bad_type' }
    );
  });

  it('type=0x07 in raw bytes → bad_type on decode', () => {
    const frame = encodeFrame({ type: kFrameType.CHUNK, transferId: 0, seq: 0, payload: new Uint8Array(0) });
    frame[2] = 0x07; // overwrite type
    const r = decodeFrame(frame);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_type');
  });
});

// -------------------------------------------------------
// crc32 exported and functional
// -------------------------------------------------------
describe('crc32', () => {
  it('is exported and returns correct value for known input', () => {
    // CRC32 of empty is 0x00000000
    assert.equal(crc32(new Uint8Array(0)), 0x00000000);
    // CRC32 of "123456789" is 0xCBF43926
    const input = enc.encode('123456789');
    assert.equal(crc32(input), 0xCBF43926);
  });
});
