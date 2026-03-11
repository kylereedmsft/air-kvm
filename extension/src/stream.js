// Stream layer for Extension (BLE side).
//
// Provides transparent chunked transport over the AK binary frame protocol.
// App code calls sender.send(obj) and receiver.onMessage(cb) — the stream
// handles chunking, ack tracking, timeout/retry, and reassembly.
//
// Mirror of mcp/src/stream.js but uses Uint8Array instead of Node Buffer.

import { encodeTransferChunkFrame, makeTransferId, parseTransferId } from './binary_frame.js';

const kDefaultChunkSize = 160;
const kInlineThreshold = 500;
const kAckTimeoutMs = 3000;
const kMaxRetries = 3;
const kSeqFinalBit = 0x80000000;

export { kDefaultChunkSize, kInlineThreshold, kAckTimeoutMs, kMaxRetries, kSeqFinalBit };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTransferId(n) {
  return `tx_${(n >>> 0).toString(16).padStart(8, '0')}`;
}

function seqNumber(raw) {
  return (raw & ~kSeqFinalBit) >>> 0;
}

function isFinal(raw) {
  return (raw & kSeqFinalBit) !== 0;
}

function encodeSeq(seq, final) {
  return ((seq >>> 0) | (final ? kSeqFinalBit : 0)) >>> 0;
}

function stringToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToString(bytes) {
  return new TextDecoder().decode(bytes);
}

function concatBytes(arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function chunkPayload(bytes, chunkSize = kDefaultChunkSize) {
  if (bytes.length === 0) return [{ seq: 0, payload: new Uint8Array(0), final: true }];
  const chunks = [];
  const total = Math.ceil(bytes.length / chunkSize);
  for (let i = 0; i < total; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(bytes.length, start + chunkSize);
    chunks.push({
      seq: i,
      payload: bytes.slice(start, end),
      final: i === total - 1,
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// StreamSender
// ---------------------------------------------------------------------------

export class StreamSender {
  constructor({ writeJsonFn, writeBinaryFn, chunkSize = kDefaultChunkSize, ackTimeoutMs = kAckTimeoutMs, maxRetries = kMaxRetries } = {}) {
    if (typeof writeJsonFn !== 'function') throw new Error('writeJsonFn required');
    if (typeof writeBinaryFn !== 'function') throw new Error('writeBinaryFn required');
    this._writeJsonFn = writeJsonFn;     // async (obj) => void — sends JSON control message
    this._writeBinaryFn = writeBinaryFn; // async (Uint8Array) => void — sends raw binary frame
    this._chunkSize = chunkSize;
    this._ackTimeoutMs = ackTimeoutMs;
    this._maxRetries = maxRetries;
    this._queue = Promise.resolve();
    this._pendingAck = null;
    this._currentTransferId = null;
  }

  send(obj) {
    const run = () => this._sendObject(obj);
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  onAck(msg) {
    if (!this._pendingAck) return;
    const transferId = typeof msg.transfer_id === 'string' ? msg.transfer_id : null;
    if (transferId && transferId !== this._currentTransferId) return;
    if (msg.type === 'stream.ack') {
      const ackSeq = typeof msg.seq === 'number' ? msg.seq : -1;
      if (ackSeq === this._pendingAck.seq) {
        this._resolveAck();
      }
    } else if (msg.type === 'stream.nack') {
      const nackSeq = typeof msg.seq === 'number' ? msg.seq : -1;
      if (nackSeq === this._pendingAck.seq) {
        this._rejectAck(new Error(msg.reason || 'nack'));
      }
    }
  }

  reset() {
    if (this._pendingAck) {
      clearTimeout(this._pendingAck.timer);
      this._pendingAck.reject(new Error('stream_reset'));
      this._pendingAck = null;
    }
    this._currentTransferId = null;
    this._queue = Promise.resolve();
  }

  async _sendObject(obj) {
    const json = JSON.stringify(obj);
    const bytes = stringToBytes(json);

    // Small message fast path: send as inline JSON, no chunking.
    if (bytes.length <= this._chunkSize) {
      await this._writeJsonFn(obj);
      return;
    }

    // Large message: chunk and send with ack gating.
    const tid = makeTransferId();
    this._currentTransferId = tid.string;
    const chunks = chunkPayload(bytes, this._chunkSize);

    for (const chunk of chunks) {
      await this._sendChunkWithRetry(tid, chunk);
    }
    this._currentTransferId = null;
  }

  async _sendChunkWithRetry(tid, chunk) {
    const frame = encodeTransferChunkFrame({
      transferIdNumeric: tid.numeric,
      seq: encodeSeq(chunk.seq, chunk.final),
      payloadBytes: chunk.payload,
    });

    let lastError = null;
    for (let attempt = 0; attempt <= this._maxRetries; attempt += 1) {
      try {
        await this._writeBinaryFn(frame);
        await this._waitForAck(tid.string, chunk.seq);
        return;
      } catch (err) {
        lastError = err;
        if (err.message === 'stream_reset') throw err;
      }
    }
    throw new Error(`chunk_send_failed:seq=${chunk.seq}:${lastError?.message || 'unknown'}`);
  }

  _waitForAck(transferId, seq) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingAck && this._pendingAck.seq === seq) {
          this._pendingAck = null;
          reject(new Error('ack_timeout'));
        }
      }, this._ackTimeoutMs);

      this._pendingAck = { resolve, reject, transferId, seq, timer };
    });
  }

  _resolveAck() {
    if (!this._pendingAck) return;
    clearTimeout(this._pendingAck.timer);
    const { resolve } = this._pendingAck;
    this._pendingAck = null;
    resolve();
  }

  _rejectAck(err) {
    if (!this._pendingAck) return;
    clearTimeout(this._pendingAck.timer);
    const { reject } = this._pendingAck;
    this._pendingAck = null;
    reject(err);
  }
}

// ---------------------------------------------------------------------------
// StreamReceiver
// ---------------------------------------------------------------------------

export class StreamReceiver {
  constructor({ writeJsonFn } = {}) {
    if (typeof writeJsonFn !== 'function') throw new Error('writeJsonFn required');
    this._writeJsonFn = writeJsonFn;
    this._messageHandler = null;
    this._errorHandler = null;
    this._rx = null; // { id, chunks: Uint8Array[], finalSeq }
  }

  onMessage(handler) {
    this._messageHandler = typeof handler === 'function' ? handler : null;
  }

  onError(handler) {
    this._errorHandler = typeof handler === 'function' ? handler : null;
  }

  onControlMessage(msg) {
    if (msg?.type === 'stream.ack' || msg?.type === 'stream.nack' || msg?.type === 'stream.reset') {
      return;
    }
    if (msg?.type === 'stream.data') {
      this._handleStreamData(msg);
      return;
    }
    if (this._messageHandler) {
      try { this._messageHandler(msg); } catch { /* app error */ }
    }
  }

  _handleStreamData(msg) {
    const transferId = typeof msg.transfer_id === 'string' ? msg.transfer_id : null;
    if (!transferId) return;
    const seq = typeof msg.seq === 'number' ? msg.seq : 0;
    const final = msg.is_final === true;
    const b64 = typeof msg.data_b64 === 'string' ? msg.data_b64 : '';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const rawSeq = encodeSeq(seq, final);
    this.onChunkFrame({ transfer_id: transferId, raw_seq: rawSeq, payload: bytes });
  }

  onChunkFrame(frame) {
    const transferId = typeof frame.transfer_id === 'string'
      ? frame.transfer_id
      : formatTransferId(frame.transferIdNumeric || 0);
    const rawSeq = typeof frame.raw_seq === 'number' ? frame.raw_seq : (frame.seq || 0);
    const seq = seqNumber(rawSeq);
    const final = isFinal(rawSeq);
    const payload = frame.payload;

    if (!(payload instanceof Uint8Array)) {
      this._sendNack(transferId, seq, 'invalid_payload');
      return;
    }

    // New transfer replaces any stale partial.
    if (!this._rx || this._rx.id !== transferId) {
      this._rx = { id: transferId, chunks: [], finalSeq: null };
    }

    if (!this._rx.chunks[seq]) {
      this._rx.chunks[seq] = new Uint8Array(payload);
    }
    if (final) {
      this._rx.finalSeq = seq;
    }

    this._sendAck(transferId, seq);

    if (this._rx.finalSeq !== null) {
      const expect = this._rx.finalSeq + 1;
      let have = 0;
      for (let i = 0; i < expect; i += 1) { if (this._rx.chunks[i]) have += 1; }
      if (have === expect) this._reassembleAndDeliver();
    }
  }

  reset() {
    this._rx = null;
  }

  _reassembleAndDeliver() {
    const rx = this._rx;
    this._rx = null;
    const ordered = [];
    for (let i = 0; i <= rx.finalSeq; i += 1) {
      const chunk = rx.chunks[i];
      if (!chunk) {
        this._emitError(rx.id, 'reassembly_gap', i);
        return;
      }
      ordered.push(chunk);
    }
    const assembled = concatBytes(ordered);
    let parsed;
    try {
      parsed = JSON.parse(bytesToString(assembled));
    } catch {
      this._emitError(rx.id, 'json_parse_failed');
      return;
    }
    if (this._messageHandler) {
      try { this._messageHandler(parsed); } catch { /* app error */ }
    }
  }

  _sendAck(transferId, seq) {
    this._writeJsonFn({ type: 'stream.ack', transfer_id: transferId, seq }).catch(() => {});
  }

  _sendNack(transferId, seq, reason) {
    this._writeJsonFn({ type: 'stream.nack', transfer_id: transferId, seq, reason }).catch(() => {});
  }

  _emitError(transferId, code, detail) {
    if (this._errorHandler) {
      try { this._errorHandler({ transfer_id: transferId, code, detail }); } catch { /* app error */ }
    }
  }
}
