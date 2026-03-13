// Half-pipe transport (shared between MCP and extension).
//
// Provides send(obj) / onMessage(cb) over AK binary frame protocol.
// TX: serialize → chunk ≤255 bytes → send with ACK gating.
// RX: receive chunks via onFrame() → reassemble → JSON.parse → deliver.

import {
  kFrameType,
  kMaxPayload,
  encodeChunkFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
  makeTransferId,
} from './binary_frame.js';

const kDefaultAckTimeoutMs = 3000;
const kDefaultMaxRetries = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

const _encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const _decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function toUtf8(str) {
  if (_encoder) return _encoder.encode(str);
  // Fallback for environments without TextEncoder
  const arr = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { arr.push(c); }
    else if (c < 0x800) { arr.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else { arr.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(arr);
}

function fromUtf8(bytes) {
  if (_decoder) return _decoder.decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------------------------------------------------------------------------
// HalfPipe
// ---------------------------------------------------------------------------

export class HalfPipe {
  /**
   * @param {Object} opts
   * @param {Function} opts.writeFn - async (frameBytes: Uint8Array) => void
   * @param {number} [opts.ackTimeoutMs=3000]
   * @param {number} [opts.maxRetries=3]
   * @param {Function} [opts.log] - optional debug logger
   */
  constructor(opts) {
    if (typeof opts?.writeFn !== 'function') throw new Error('writeFn required');
    this._writeFn = opts.writeFn;
    this._ackTimeoutMs = opts.ackTimeoutMs ?? kDefaultAckTimeoutMs;
    this._maxRetries = opts.maxRetries ?? kDefaultMaxRetries;
    this._log = typeof opts.log === 'function' ? opts.log : null;

    // TX state
    this._txQueue = Promise.resolve();
    this._pendingAck = null;
    this._closed = false;

    // RX state
    this._rx = null; // { transferId, chunks: Uint8Array[], nextSeq }

    // Callbacks
    this._messageHandler = null;
    this._controlHandler = null;
    this._logHandler = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Send a JSON-serializable object. Queued, ack-gated. */
  send(obj) {
    if (this._closed) return Promise.reject(new Error('halfpipe_closed'));
    const run = () => this._sendObject(obj);
    const next = this._txQueue.then(run, run);
    this._txQueue = next.catch(() => {});
    return next;
  }

  /** Register callback for complete received messages. */
  onMessage(cb) {
    this._messageHandler = typeof cb === 'function' ? cb : null;
  }

  /** Register callback for control frames (type 0x02). */
  onControl(cb) {
    this._controlHandler = typeof cb === 'function' ? cb : null;
  }

  /** Register callback for log frames (type 0x03). */
  onLog(cb) {
    this._logHandler = typeof cb === 'function' ? cb : null;
  }

  /**
   * Feed a decoded AK frame. Called by transport layer.
   * @param {{ type: number, transferId: number, seq: number, payload: Uint8Array }} frame
   */
  onFrame(frame) {
    if (!frame || typeof frame.type !== 'number') return;
    switch (frame.type) {
      case kFrameType.CHUNK:
        this._handleChunk(frame);
        break;
      case kFrameType.ACK:
        this._handleAck(frame);
        break;
      case kFrameType.NACK:
        this._handleNack(frame);
        break;
      case kFrameType.RESET:
        this._handleReset();
        break;
      case kFrameType.CONTROL:
        this._handleControl(frame);
        break;
      case kFrameType.LOG:
        this._handleLog(frame);
        break;
      default:
        break;
    }
  }

  /** Send reset frame + clear all state. Pending send() rejects. */
  async reset() {
    const frame = encodeResetFrame({ transferId: 0 });
    this._clearTx('stream_reset');
    this._rx = null;
    await this._writeFn(frame);
  }

  /** Clean shutdown without sending reset. */
  close() {
    this._closed = true;
    this._clearTx('halfpipe_closed');
    this._rx = null;
  }

  // -------------------------------------------------------------------------
  // TX internals
  // -------------------------------------------------------------------------

  async _sendObject(obj) {
    if (this._closed) throw new Error('halfpipe_closed');

    const json = JSON.stringify(obj);
    const bytes = toUtf8(json);
    const transferId = makeTransferId();
    const chunks = this._splitChunks(bytes);

    this._debug(`TX start tid=${transferId} chunks=${chunks.length} bytes=${bytes.length}`);

    for (let seq = 0; seq < chunks.length; seq += 1) {
      await this._sendChunkWithRetry(transferId, seq, chunks[seq]);
    }

    this._debug(`TX complete tid=${transferId}`);
  }

  _splitChunks(bytes) {
    const chunks = [];
    if (bytes.length === 0) {
      chunks.push(new Uint8Array(0));
      return chunks;
    }
    for (let off = 0; off < bytes.length; off += kMaxPayload) {
      chunks.push(bytes.slice(off, off + kMaxPayload));
    }
    // If last chunk is exactly kMaxPayload, append zero-length terminator
    if (chunks[chunks.length - 1].length === kMaxPayload) {
      chunks.push(new Uint8Array(0));
    }
    return chunks;
  }

  async _sendChunkWithRetry(transferId, seq, payload) {
    const frame = encodeChunkFrame({ transferId, seq, payload });
    let lastError = null;

    for (let attempt = 0; attempt <= this._maxRetries; attempt += 1) {
      if (this._closed) throw new Error('halfpipe_closed');
      try {
        await this._writeFn(frame);
        await this._waitForAck(transferId, seq);
        return;
      } catch (err) {
        lastError = err;
        if (err.message === 'stream_reset' || err.message === 'halfpipe_closed') throw err;
        this._debug(`TX retry tid=${transferId} seq=${seq} attempt=${attempt} err=${err.message}`);
      }
    }
    throw new Error(`chunk_send_failed:seq=${seq}:${lastError?.message || 'unknown'}`);
  }

  _waitForAck(transferId, seq) {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error('halfpipe_closed')); return; }
      const timer = setTimeout(() => {
        if (this._pendingAck && this._pendingAck.transferId === transferId && this._pendingAck.seq === seq) {
          this._pendingAck = null;
          reject(new Error('ack_timeout'));
        }
      }, this._ackTimeoutMs);

      this._pendingAck = { resolve, reject, transferId, seq, timer };
    });
  }

  _handleAck(frame) {
    if (!this._pendingAck) return;
    if (this._pendingAck.transferId === frame.transferId && this._pendingAck.seq === frame.seq) {
      clearTimeout(this._pendingAck.timer);
      const { resolve } = this._pendingAck;
      this._pendingAck = null;
      resolve();
    }
  }

  _handleNack(frame) {
    if (!this._pendingAck) return;
    if (this._pendingAck.transferId === frame.transferId && this._pendingAck.seq === frame.seq) {
      clearTimeout(this._pendingAck.timer);
      const { reject } = this._pendingAck;
      this._pendingAck = null;
      reject(new Error('nack'));
    }
  }

  _handleReset() {
    this._clearTx('stream_reset');
    this._rx = null;
  }

  _clearTx(reason) {
    if (this._pendingAck) {
      clearTimeout(this._pendingAck.timer);
      const { reject } = this._pendingAck;
      this._pendingAck = null;
      reject(new Error(reason));
    }
  }

  // -------------------------------------------------------------------------
  // RX internals
  // -------------------------------------------------------------------------

  _handleChunk(frame) {
    const { transferId, seq, payload } = frame;

    // New or different transfer → start fresh
    if (!this._rx || this._rx.transferId !== transferId) {
      this._rx = { transferId, chunks: [], nextSeq: 0 };
    }

    // Validate seq
    if (seq !== this._rx.nextSeq) {
      this._debug(`RX bad seq: expected=${this._rx.nextSeq} got=${seq} tid=${transferId}`);
      this._sendNack(transferId, seq);
      return;
    }

    // Store chunk and send ACK
    this._rx.chunks.push(payload);
    this._rx.nextSeq = seq + 1;
    this._sendAck(transferId, seq);

    // Check for end-of-transfer: payload.length < kMaxPayload
    if (payload.length < kMaxPayload) {
      this._reassembleAndDeliver();
    }
  }

  _reassembleAndDeliver() {
    const rx = this._rx;
    this._rx = null;
    if (!rx) return;

    const assembled = concatBytes(rx.chunks);
    let parsed;
    try {
      parsed = JSON.parse(fromUtf8(assembled));
    } catch {
      this._debug(`RX json parse failed tid=${rx.transferId}`);
      return;
    }

    if (this._messageHandler) {
      try { this._messageHandler(parsed); } catch { /* app error */ }
    }
  }

  _sendAck(transferId, seq) {
    const frame = encodeAckFrame({ transferId, seq });
    this._writeFn(frame).catch(() => {});
  }

  _sendNack(transferId, seq) {
    const frame = encodeNackFrame({ transferId, seq });
    this._writeFn(frame).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Control / Log frames
  // -------------------------------------------------------------------------

  _handleControl(frame) {
    if (!this._controlHandler) return;
    try {
      const parsed = JSON.parse(fromUtf8(frame.payload));
      this._controlHandler(parsed);
    } catch { /* parse or handler error */ }
  }

  _handleLog(frame) {
    if (!this._logHandler) return;
    try {
      const text = fromUtf8(frame.payload);
      this._logHandler(text);
    } catch { /* handler error */ }
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  _debug(msg) {
    if (this._log) this._log(msg);
  }
}
