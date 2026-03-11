// Half-pipe transport for MCP (UART side).
//
// Provides send(obj) / onMessage(cb) over AK v2 binary frames.
// TX: serialize → chunk (≤255 bytes) → send with per-chunk ACK gating.
// RX: reassemble chunks → JSON.parse → deliver.
// Flow control via ACK / NACK / RESET frames.
//
// Does NOT own the physical transport. Receives decoded frames via onFrame()
// and sends raw frame bytes via writeFn callback.

import {
  kFrameType,
  kV2MaxPayload,
  encodeChunkFrame,
  encodeAckFrame,
  encodeNackFrame,
  encodeResetFrame,
  makeV2TransferId,
} from './binary_frame.js';

export class HalfPipe {
  /**
   * @param {Object} opts
   * @param {Function} opts.writeFn - async (frameBytes: Buffer) => void
   * @param {number} [opts.ackTimeoutMs=3000]
   * @param {number} [opts.maxRetries=3]
   * @param {Function} [opts.log]
   */
  constructor({ writeFn, ackTimeoutMs = 3000, maxRetries = 3, log } = {}) {
    if (typeof writeFn !== 'function') throw new Error('writeFn required');
    this._writeFn = writeFn;
    this._ackTimeoutMs = ackTimeoutMs;
    this._maxRetries = maxRetries;
    this._log = typeof log === 'function' ? log : null;

    this._messageCb = null;
    this._controlCb = null;
    this._logCb = null;

    // TX state
    this._queue = Promise.resolve();
    this._pendingAck = null;   // { resolve, reject, transferId, seq, timer }
    this._txTransferId = null;
    this._closed = false;

    // RX state
    this._rx = null; // { transferId, chunks: Buffer[], nextSeq }
  }

  // ── Public API ──────────────────────────────────────────────────────

  async send(obj) {
    const run = () => this._sendObject(obj);
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  onMessage(cb) {
    this._messageCb = typeof cb === 'function' ? cb : null;
  }

  onControl(cb) {
    this._controlCb = typeof cb === 'function' ? cb : null;
  }

  onLog(cb) {
    this._logCb = typeof cb === 'function' ? cb : null;
  }

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
        this._deliverControl(frame);
        break;
      case kFrameType.LOG:
        this._deliverLog(frame);
        break;
    }
  }

  async reset() {
    const tid = this._txTransferId ?? 0;
    this._clearTxState('stream_reset');
    this._rx = null;
    await this._writeFn(encodeResetFrame({ transferId: tid }));
  }

  close() {
    this._closed = true;
    this._clearTxState('halfpipe_closed');
    this._rx = null;
    this._messageCb = null;
    this._controlCb = null;
    this._logCb = null;
  }

  // ── TX internals ────────────────────────────────────────────────────

  async _sendObject(obj) {
    if (this._closed) throw new Error('halfpipe_closed');

    const json = JSON.stringify(obj);
    const bytes = Buffer.from(json, 'utf8');
    const transferId = makeV2TransferId();
    this._txTransferId = transferId;

    // Split into ≤255 byte chunks
    const chunks = [];
    for (let off = 0; off < bytes.length; off += kV2MaxPayload) {
      chunks.push(bytes.subarray(off, Math.min(off + kV2MaxPayload, bytes.length)));
    }

    // If total is exact multiple of 255, append zero-length terminator
    if (bytes.length > 0 && bytes.length % kV2MaxPayload === 0) {
      chunks.push(Buffer.alloc(0));
    }

    // Edge case: empty JSON (shouldn't happen, but handle gracefully)
    if (chunks.length === 0) {
      chunks.push(Buffer.alloc(0));
    }

    for (let seq = 0; seq < chunks.length; seq += 1) {
      await this._sendChunkWithRetry(transferId, seq, chunks[seq]);
    }

    this._txTransferId = null;
  }

  async _sendChunkWithRetry(transferId, seq, payload) {
    const frameBytes = encodeChunkFrame({ transferId, seq, payload });
    let lastError = null;

    for (let attempt = 0; attempt <= this._maxRetries; attempt += 1) {
      if (this._closed) throw new Error('halfpipe_closed');
      try {
        this._debug(`TX chunk tid=${transferId} seq=${seq} len=${payload.length} attempt=${attempt}`);
        await this._writeFn(frameBytes);
        await this._waitForAck(transferId, seq);
        return;
      } catch (err) {
        lastError = err;
        if (err.message === 'stream_reset' || err.message === 'halfpipe_closed') throw err;
        this._debug(`TX retry tid=${transferId} seq=${seq}: ${err.message}`);
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
    if (frame.transferId !== this._pendingAck.transferId) return;
    if (frame.seq !== this._pendingAck.seq) return;
    clearTimeout(this._pendingAck.timer);
    const { resolve } = this._pendingAck;
    this._pendingAck = null;
    resolve();
  }

  _handleNack(frame) {
    if (!this._pendingAck) return;
    if (frame.transferId !== this._pendingAck.transferId) return;
    if (frame.seq !== this._pendingAck.seq) return;
    clearTimeout(this._pendingAck.timer);
    const { reject } = this._pendingAck;
    this._pendingAck = null;
    reject(new Error('nack'));
  }

  _handleReset() {
    this._clearTxState('stream_reset');
    this._rx = null;
    this._debug('RX reset');
  }

  _clearTxState(reason) {
    if (this._pendingAck) {
      clearTimeout(this._pendingAck.timer);
      this._pendingAck.reject(new Error(reason));
      this._pendingAck = null;
    }
    this._txTransferId = null;
  }

  // ── RX internals ────────────────────────────────────────────────────

  _handleChunk(frame) {
    const { transferId, seq, payload } = frame;

    // New transfer or different transferId → start fresh
    if (!this._rx || this._rx.transferId !== transferId) {
      this._rx = { transferId, chunks: [], nextSeq: 0 };
    }

    // Validate sequence
    if (seq !== this._rx.nextSeq) {
      this._debug(`RX seq mismatch: got=${seq} want=${this._rx.nextSeq}`);
      this._writeFn(encodeNackFrame({ transferId, seq })).catch(() => {});
      return;
    }

    // Store chunk and send ACK
    this._rx.chunks.push(Buffer.from(payload));
    this._rx.nextSeq = seq + 1;
    this._writeFn(encodeAckFrame({ transferId, seq })).catch(() => {});

    // Check for transfer completion: last chunk has len < 255
    if (payload.length < kV2MaxPayload) {
      this._reassembleAndDeliver();
    }
  }

  _reassembleAndDeliver() {
    const rx = this._rx;
    this._rx = null;
    if (!rx) return;

    const assembled = Buffer.concat(rx.chunks);
    if (assembled.length === 0) return;

    let parsed;
    try {
      parsed = JSON.parse(assembled.toString('utf8'));
    } catch (err) {
      this._debug(`RX JSON parse error: ${err.message}`);
      return;
    }

    if (this._messageCb) {
      try { this._messageCb(parsed); } catch { /* app error */ }
    }
  }

  // ── Control / Log passthrough ───────────────────────────────────────

  _deliverControl(frame) {
    if (!this._controlCb) return;
    let parsed;
    try {
      parsed = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      return;
    }
    try { this._controlCb(parsed); } catch { /* app error */ }
  }

  _deliverLog(frame) {
    if (!this._logCb) return;
    const text = frame.payload.toString('utf8');
    try { this._logCb(text); } catch { /* app error */ }
  }

  // ── Debug ───────────────────────────────────────────────────────────

  _debug(msg) {
    if (this._log) this._log(msg);
  }
}
