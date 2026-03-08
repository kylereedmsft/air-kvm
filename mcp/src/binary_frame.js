const kMagic0 = 0x41; // 'A'
const kMagic1 = 0x4b; // 'K'
const kVersion = 1;
const kFrameTypeTransferChunk = 1;
const kFrameTypeControlJson = 2;
const kFrameTypeLogText = 3;
const kFixedHeaderLen = 14;
const kCrcLen = 4;
const kMinFrameLen = kFixedHeaderLen + kCrcLen;
const kMaxPayloadLen = 4096;

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

export function parseTransferId(transferId) {
  const raw = String(transferId || '');
  const normalized = raw.startsWith('tx_') ? raw.slice(3) : raw;
  if (!/^[0-9a-fA-F]{1,8}$/.test(normalized)) {
    throw new Error('invalid_transfer_id');
  }
  return parseInt(normalized, 16) >>> 0;
}

export function formatTransferId(value) {
  const n = value >>> 0;
  return `tx_${n.toString(16).padStart(8, '0')}`;
}

export function encodeTransferChunkFrame({ transferId, seq, payload }) {
  if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffffffff) {
    throw new Error('invalid_transfer_id');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new Error('invalid_seq');
  }
  if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
    throw new Error('invalid_payload');
  }
  const payloadBytes = Buffer.from(payload);
  if (payloadBytes.length > kMaxPayloadLen) {
    throw new Error('payload_too_large');
  }

  const out = Buffer.alloc(kMinFrameLen + payloadBytes.length);
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = kVersion;
  out[3] = kFrameTypeTransferChunk;
  out.writeUInt32LE(transferId >>> 0, 4);
  out.writeUInt32LE(seq >>> 0, 8);
  out.writeUInt16LE(payloadBytes.length, 12);
  payloadBytes.copy(out, kFixedHeaderLen);
  const crc = crc32(out.subarray(2, kFixedHeaderLen + payloadBytes.length));
  out.writeUInt32LE(crc >>> 0, kFixedHeaderLen + payloadBytes.length);
  return out;
}

function encodeTextFrame({ frameType, text }) {
  if (frameType !== kFrameTypeControlJson && frameType !== kFrameTypeLogText) {
    throw new Error('invalid_frame_type');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('invalid_text');
  }
  const payloadBytes = Buffer.from(text, 'utf8');
  if (payloadBytes.length > kMaxPayloadLen) {
    throw new Error('payload_too_large');
  }
  const out = Buffer.alloc(kMinFrameLen + payloadBytes.length);
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = kVersion;
  out[3] = frameType;
  out.writeUInt32LE(0, 4);
  out.writeUInt32LE(0, 8);
  out.writeUInt16LE(payloadBytes.length, 12);
  payloadBytes.copy(out, kFixedHeaderLen);
  const crc = crc32(out.subarray(2, kFixedHeaderLen + payloadBytes.length));
  out.writeUInt32LE(crc >>> 0, kFixedHeaderLen + payloadBytes.length);
  return out;
}

export function encodeControlFrame(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('invalid_ctrl_msg');
  return encodeTextFrame({
    frameType: kFrameTypeControlJson,
    text: JSON.stringify(msg)
  });
}

export function encodeLogFrame(text) {
  return encodeTextFrame({
    frameType: kFrameTypeLogText,
    text
  });
}

export function decodeUartFrame(bytes) {
  const frame = Buffer.from(bytes);
  if (frame.length < kMinFrameLen) return { ok: false, error: 'frame_too_short' };
  if (frame[0] !== kMagic0 || frame[1] !== kMagic1) return { ok: false, error: 'bad_magic' };
  const version = frame[2];
  const frameType = frame[3];
  if (version !== kVersion) return { ok: false, error: 'bad_version' };

  const transferId = frame.readUInt32LE(4);
  const seq = frame.readUInt32LE(8);
  const payloadLen = frame.readUInt16LE(12);
  const expectedLen = kMinFrameLen + payloadLen;
  if (payloadLen > kMaxPayloadLen) {
    return { ok: false, error: 'payload_too_large', transferId, seq, payloadLen };
  }
  if (frame.length !== expectedLen) {
    return { ok: false, error: 'length_mismatch', transferId, seq, payloadLen };
  }
  const payload = frame.subarray(kFixedHeaderLen, kFixedHeaderLen + payloadLen);
  const gotCrc = frame.readUInt32LE(kFixedHeaderLen + payloadLen);
  const wantCrc = crc32(frame.subarray(2, kFixedHeaderLen + payloadLen));
  if (gotCrc !== wantCrc) {
    return { ok: false, error: 'crc_mismatch', frameType, transferId, seq, gotCrc, wantCrc };
  }

  if (frameType === kFrameTypeTransferChunk) {
    return {
      ok: true,
      frameType,
      transferId,
      seq,
      payload: Buffer.from(payload),
      payloadLen
    };
  }
  if (frameType === kFrameTypeControlJson) {
    try {
      const parsed = JSON.parse(payload.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: 'invalid_ctrl_json', frameType };
      }
      return {
        ok: true,
        frameType,
        payloadLen,
        msg: parsed
      };
    } catch {
      return { ok: false, error: 'invalid_ctrl_json', frameType };
    }
  }
  if (frameType === kFrameTypeLogText) {
    return {
      ok: true,
      frameType,
      payloadLen,
      text: payload.toString('utf8')
    };
  }
  return { ok: false, error: 'bad_type', frameType };
}

export function tryExtractFrameFromBuffer(buffer) {
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length >= 2 && buffer[0] === kMagic0 && buffer[1] === kMagic1) {
    if (buffer.length < kMinFrameLen) return null;
    const payloadLen = buffer.readUInt16LE(12);
    if (payloadLen > kMaxPayloadLen) {
      return {
        frame: { kind: 'bin_error', error: 'payload_too_large' },
        consumed: 1
      };
    }
    const totalLen = kMinFrameLen + payloadLen;
    if (buffer.length < totalLen) return null;
    const chunk = buffer.subarray(0, totalLen);
    const parsed = decodeUartFrame(chunk);
    if (!parsed.ok) {
      const errorFrame = { kind: 'bin_error', error: parsed.error };
      if (Number.isInteger(parsed.frameType)) {
        errorFrame.frame_type = parsed.frameType;
      }
      if (Number.isInteger(parsed.transferId)) {
        errorFrame.transfer_id = formatTransferId(parsed.transferId);
      }
      if (Number.isInteger(parsed.seq)) {
        errorFrame.seq = parsed.seq;
      }
      return {
        frame: errorFrame,
        consumed: totalLen
      };
    }
    if (parsed.frameType === kFrameTypeControlJson) {
      return {
        frame: {
          kind: 'ctrl',
          msg: parsed.msg
        },
        consumed: totalLen
      };
    }
    if (parsed.frameType === kFrameTypeLogText) {
      return {
        frame: {
          kind: 'log',
          msg: parsed.text
        },
        consumed: totalLen
      };
    }
    return {
      frame: {
        kind: 'bin',
        transfer_id: formatTransferId(parsed.transferId),
        seq: parsed.seq,
        payload: parsed.payload
      },
      consumed: totalLen
    };
  }
  return null;
}
