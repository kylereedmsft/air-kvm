const kMagic0 = 0x41; // 'A'
const kMagic1 = 0x4b; // 'K'
const kVersion = 1;
const kFrameTypeTransferChunk = 1;

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

function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function makeTransferId() {
  const n = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return {
    numeric: n,
    string: `tx_${n.toString(16).padStart(8, '0')}`
  };
}

export function parseTransferId(transferId) {
  const raw = String(transferId || '');
  const normalized = raw.startsWith('tx_') ? raw.slice(3) : raw;
  if (!/^[0-9a-fA-F]{1,8}$/.test(normalized)) {
    throw new Error('invalid_transfer_id');
  }
  return parseInt(normalized, 16) >>> 0;
}

export function encodeTransferChunkFrame({ transferIdNumeric, seq, payloadBytes }) {
  if (!Number.isInteger(transferIdNumeric) || transferIdNumeric < 0 || transferIdNumeric > 0xffffffff) {
    throw new Error('invalid_transfer_id');
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new Error('invalid_seq');
  }
  if (!(payloadBytes instanceof Uint8Array)) {
    throw new Error('invalid_payload');
  }
  // Extension sends binary frames over BLE to the firmware.  Each BLE write
  // is chunked at 160 bytes (kBleWriteChunkBytes in bridge.js).  We cap the
  // payload at 1024 to stay well within the firmware's kMaxBinaryFrameLen
  // (1400) after accounting for the 18-byte AK header + CRC overhead.
  if (payloadBytes.length > 1024) {
    throw new Error('payload_too_large');
  }

  const out = new Uint8Array(18 + payloadBytes.length);
  const view = new DataView(out.buffer);
  out[0] = kMagic0;
  out[1] = kMagic1;
  out[2] = kVersion;
  out[3] = kFrameTypeTransferChunk;
  view.setUint32(4, transferIdNumeric >>> 0, true);
  view.setUint32(8, seq >>> 0, true);
  view.setUint16(12, payloadBytes.length, true);
  out.set(payloadBytes, 14);
  const crc = crc32(out.subarray(2, 14 + payloadBytes.length));
  view.setUint32(14 + payloadBytes.length, crc >>> 0, true);
  return out;
}
