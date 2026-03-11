// ============================================================
// Shared constants
// ============================================================
export const kMagic0 = 0x41; // 'A'
export const kMagic1 = 0x4b; // 'K'

// ============================================================
// CRC-32 (IEEE 802.3)
// ============================================================
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ============================================================
// v2 constants
// ============================================================
export const kFrameType = {
  CHUNK:   0x01,
  CONTROL: 0x02,
  LOG:     0x03,
  ACK:     0x04,
  NACK:    0x05,
  RESET:   0x06,
};

const kValidTypes = new Set(Object.values(kFrameType));

export const kV2HeaderLen   = 8;  // magic(2) + type(1) + txid(2) + seq(2) + len(1)
export const kV2CrcLen      = 4;
export const kV2MinFrameLen = 12; // header + crc, zero payload
export const kV2MaxPayload  = 255;

// ============================================================
// v2 encoder
// ============================================================
export function encodeFrame({ type, transferId, seq, payload }) {
  if (!kValidTypes.has(type)) {
    throw new Error('bad_type');
  }
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffff) {
    throw new Error('invalid_transfer_id');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffff) {
    throw new Error('invalid_seq');
  }
  const p = payload || new Uint8Array(0);
  if (!(p instanceof Uint8Array)) {
    throw new Error('invalid_payload');
  }
  if (p.length > kV2MaxPayload) {
    throw new Error('payload_too_large');
  }

  const frameLen = kV2HeaderLen + p.length + kV2CrcLen;
  const out = new Uint8Array(frameLen);
  const view = new DataView(out.buffer);

  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = type;
  view.setUint16(3, transferId, true);
  view.setUint16(5, seq, true);
  out[7] = p.length;
  if (p.length > 0) {
    out.set(p, kV2HeaderLen);
  }

  // CRC covers bytes 2 .. end-of-payload (type + txid + seq + len + payload)
  const crcVal = crc32(out.subarray(2, kV2HeaderLen + p.length));
  view.setUint32(kV2HeaderLen + p.length, crcVal >>> 0, true);
  return out;
}

// ============================================================
// v2 decoder
// ============================================================
export function decodeFrame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < kV2MinFrameLen) {
    return { ok: false, error: 'frame_too_short' };
  }
  if (bytes[0] !== kMagic0 || bytes[1] !== kMagic1) {
    return { ok: false, error: 'bad_magic' };
  }
  const type = bytes[2];
  if (!kValidTypes.has(type)) {
    return { ok: false, error: 'bad_type', type };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const transferId = view.getUint16(3, true);
  const seq = view.getUint16(5, true);
  const len = bytes[7];

  const expectedLen = kV2HeaderLen + len + kV2CrcLen;
  if (bytes.length < expectedLen) {
    return { ok: false, error: 'length_mismatch', type, transferId, seq, len };
  }

  const payload = bytes.slice(kV2HeaderLen, kV2HeaderLen + len);

  // CRC check: covers bytes 2 .. end-of-payload
  const crcRegion = bytes.subarray(2, kV2HeaderLen + len);
  const gotCrc = view.getUint32(kV2HeaderLen + len, true) >>> 0;
  const wantCrc = crc32(crcRegion);
  if (gotCrc !== wantCrc) {
    return { ok: false, error: 'crc_mismatch', type, transferId, seq, gotCrc, wantCrc };
  }

  return { ok: true, type, transferId, seq, payload };
}

// ============================================================
// v2 stream extractor
// ============================================================
export function tryExtractV2Frame(buffer) {
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) {
    return null;
  }
  if (buffer[0] !== kMagic0 || buffer[1] !== kMagic1) {
    return null;
  }
  if (buffer.length < kV2MinFrameLen) {
    return null; // magic present but incomplete
  }

  const len = buffer[7];
  const frameLen = kV2HeaderLen + len + kV2CrcLen;
  if (buffer.length < frameLen) {
    return null; // incomplete frame
  }

  const frameBytes = buffer.slice(0, frameLen);
  const result = decodeFrame(frameBytes);
  if (!result.ok) {
    return { frame: { type: 'error', error: result.error }, consumed: frameLen };
  }
  return {
    frame: { type: result.type, transferId: result.transferId, seq: result.seq, payload: result.payload },
    consumed: frameLen,
  };
}

// ============================================================
// v2 transfer ID helper
// ============================================================
export function makeV2TransferId() {
  return Math.floor(Math.random() * 0x10000);
}

// ============================================================
// v2 convenience encoders
// ============================================================
export function encodeChunkFrame({ transferId, seq, payload }) {
  return encodeFrame({ type: kFrameType.CHUNK, transferId, seq, payload });
}

const _textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function toUtf8(str) {
  if (_textEncoder) return _textEncoder.encode(str);
  // Fallback (should not be needed in modern browsers or Node >=11)
  const arr = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { arr.push(c); }
    else if (c < 0x800) { arr.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else { arr.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(arr);
}

export function encodeControlFrameV2(msg) {
  const payload = toUtf8(JSON.stringify(msg));
  return encodeFrame({ type: kFrameType.CONTROL, transferId: 0, seq: 0, payload });
}

export function encodeLogFrameV2(text) {
  const payload = toUtf8(text);
  return encodeFrame({ type: kFrameType.LOG, transferId: 0, seq: 0, payload });
}

export function encodeAckFrame({ transferId, seq }) {
  return encodeFrame({ type: kFrameType.ACK, transferId, seq });
}

export function encodeNackFrame({ transferId, seq }) {
  return encodeFrame({ type: kFrameType.NACK, transferId, seq });
}

export function encodeResetFrame({ transferId }) {
  return encodeFrame({ type: kFrameType.RESET, transferId, seq: 0 });
}


