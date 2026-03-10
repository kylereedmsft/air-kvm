// Stream layer for MCP (UART side).
//
// Provides transparent chunked transport over the AK binary frame protocol.
// App code calls sender.send(obj) and receiver.onMessage(cb) — the stream
// handles chunking, ack tracking, timeout/retry, and reassembly.
//
// Two independent concerns:
//   - Sending: serialize → chunk → send one at a time → wait for ack → next
//   - Receiving: accept chunks → reassemble → deliver complete object
//
// Uses writeJsonFn for inline JSON and writeBinaryFn for binary chunk frames.
// This matches the firmware's dual path: JSON goes through text UART,
// binary goes through the AK framed path.

import {
  formatTransferId,
  encodeTransferChunkFrame,
} from './binary_frame.js';

const kDefaultChunkSize = 160;
const kAckTimeoutMs = 3000;
const kMaxRetries = 3;
const kSeqFinalBit = 0x80000000;

export { kDefaultChunkSize, kAckTimeoutMs, kMaxRetries, kSeqFinalBit };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransferId() {
  const n = (Math.random() * 0xffffffff) >>> 0;
  return { numeric: n, string: formatTransferId(n) };
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

function chunkPayload(buf, chunkSize = kDefaultChunkSize) {
  if (buf.length === 0) return [{ seq: 0, payload: Buffer.alloc(0), final: true }];
  const chunks = [];
  const totalChunks = Math.ceil(buf.length / chunkSize);
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(buf.length, start + chunkSize);
    chunks.push({
      seq: i,
      payload: buf.subarray(start, end),
      final: i === totalChunks - 1,
    });
  }
  return chunks;
}

export { seqNumber, isFinal, encodeSeq, chunkPayload };

// ---------------------------------------------------------------------------
// StreamSender — sends objects, handles chunking and ack tracking
// ---------------------------------------------------------------------------

export class StreamSender {
  constructor({ writeJsonFn, writeBinaryFn, chunkSize = kDefaultChunkSize, ackTimeoutMs = kAckTimeoutMs, maxRetries = kMaxRetries } = {}) {
    if (typeof writeJsonFn !== 'function') throw new Error('writeJsonFn required');
    if (typeof writeBinaryFn !== 'function') throw new Error('writeBinaryFn required');
    this._writeJsonFn = writeJsonFn;       // async (obj) => void — sends JSON text
    this._writeBinaryFn = writeBinaryFn;   // async (Buffer) => void — sends binary frame
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
    const bytes = Buffer.from(json, 'utf8');

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
      transferId: tid.numeric,
      seq: encodeSeq(chunk.seq, chunk.final),
      payload: chunk.payload,
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
// StreamReceiver — receives chunks, reassembles, delivers objects
// ---------------------------------------------------------------------------

export class StreamReceiver {
  constructor({ writeJsonFn } = {}) {
    if (typeof writeJsonFn !== 'function') throw new Error('writeJsonFn required');
    this._writeJsonFn = writeJsonFn;   // async (obj) => void — sends ack/nack JSON
    this._messageHandler = null;
    this._errorHandler = null;
    this._rx = null; // { id, chunks: Buffer[], finalSeq }
  }

  onMessage(handler) {
    this._messageHandler = typeof handler === 'function' ? handler : null;
  }

  onError(handler) {
    this._errorHandler = typeof handler === 'function' ? handler : null;
  }

  onControlFrame(msg) {
    if (msg?.type === 'stream.ack' || msg?.type === 'stream.nack' || msg?.type === 'stream.reset') {
      return;
    }
    if (this._messageHandler) {
      try { this._messageHandler(msg); } catch { /* app error */ }
    }
  }

  onChunkFrame(frame) {
    const transferId = typeof frame.transfer_id === 'string'
      ? frame.transfer_id
      : formatTransferId(frame.transferId || 0);
    const rawSeq = typeof frame.raw_seq === 'number' ? frame.raw_seq : (frame.seq || 0);
    const seq = seqNumber(rawSeq);
    const final = isFinal(rawSeq);
    const payload = frame.payload;

    if (!(payload instanceof Uint8Array)) {
      this._sendNack(transferId, seq, 'invalid_payload');
      return;
    }

    if (!this._rx || this._rx.id !== transferId) {
      this._rx = { id: transferId, chunks: [], finalSeq: null };
    }

    if (!this._rx.chunks[seq]) {
      this._rx.chunks[seq] = Buffer.from(payload);
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
    const assembled = Buffer.concat(ordered);
    let parsed;
    try {
      parsed = JSON.parse(assembled.toString('utf8'));
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
