import { SCREENSHOT_CONTRACT } from './screenshot_contract.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'airkvm_send',
    description: 'Validate and forward a control command to the AirKVM device transport.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          properties: {
            type: { type: 'string' }
          },
          required: ['type']
        }
      },
      required: ['command']
    }
  },
  {
    name: 'airkvm_list_tabs',
    description: 'List automatable browser tabs available on the target extension.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_open_tab',
    description: 'Open a new browser tab on the target extension machine.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        url: { type: 'string', maxLength: 2048 },
        active: { type: 'boolean' }
      },
      required: ['request_id', 'url']
    }
  },
  {
    name: 'airkvm_dom_snapshot',
    description: 'Request a DOM snapshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' }
      },
      required: []
    }
  },
  {
    name: 'airkvm_exec_js_tab',
    description: 'Execute JavaScript in the target browser tab over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        script: { type: 'string', minLength: 1, maxLength: 600 },
        tab_id: { type: 'integer' },
        timeout_ms: { type: 'integer', minimum: 50, maximum: 2000 },
        max_result_chars: { type: 'integer', minimum: 64, maximum: 700 }
      },
      required: ['request_id', 'script']
    }
  },
  {
    name: 'airkvm_screenshot_tab',
    description: 'Request a tab screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: SCREENSHOT_CONTRACT.width.min, maximum: SCREENSHOT_CONTRACT.width.max },
        max_height: { type: 'integer', minimum: SCREENSHOT_CONTRACT.height.min, maximum: SCREENSHOT_CONTRACT.height.max },
        quality: { type: 'number', minimum: SCREENSHOT_CONTRACT.quality.min, maximum: SCREENSHOT_CONTRACT.quality.max },
        max_chars: { type: 'integer', minimum: SCREENSHOT_CONTRACT.maxChars.min, maximum: SCREENSHOT_CONTRACT.maxChars.max },
        tab_id: { type: 'integer' },
        encoding: { type: 'string', enum: [SCREENSHOT_CONTRACT.encoding] }
      },
      required: []
    }
  },
  {
    name: 'airkvm_screenshot_desktop',
    description: 'Request a desktop screenshot from the target extension over the AirKVM transport.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        max_width: { type: 'integer', minimum: SCREENSHOT_CONTRACT.width.min, maximum: SCREENSHOT_CONTRACT.width.max },
        max_height: { type: 'integer', minimum: SCREENSHOT_CONTRACT.height.min, maximum: SCREENSHOT_CONTRACT.height.max },
        quality: { type: 'number', minimum: SCREENSHOT_CONTRACT.quality.min, maximum: SCREENSHOT_CONTRACT.quality.max },
        max_chars: { type: 'integer', minimum: SCREENSHOT_CONTRACT.maxChars.min, maximum: SCREENSHOT_CONTRACT.maxChars.max },
        desktop_delay_ms: {
          type: 'integer',
          minimum: SCREENSHOT_CONTRACT.desktopDelayMs.min,
          maximum: SCREENSHOT_CONTRACT.desktopDelayMs.max
        },
        encoding: { type: 'string', enum: [SCREENSHOT_CONTRACT.encoding] }
      },
      required: []
    }
  }
];

export function makeRequestId() {
  return `req_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function base64LooksLikeMime(base64, mime) {
  try {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 4) return false;
    if (mime === 'image/jpeg') {
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (mime === 'image/png') {
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    }
    return true;
  } catch {
    return false;
  }
}

export function isKnownTool(name) {
  return TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

export function isStructuredTool(name) {
  return (
    name === 'airkvm_dom_snapshot' ||
    name === 'airkvm_list_tabs' ||
    name === 'airkvm_open_tab' ||
    name === 'airkvm_exec_js_tab' ||
    name === 'airkvm_screenshot_tab' ||
    name === 'airkvm_screenshot_desktop'
  );
}

export function buildCommandForTool(name, args = {}) {
  if (name === 'airkvm_send') {
    return args?.command;
  }

  const requestId =
    typeof args?.request_id === 'string' && args.request_id.length > 0
      ? args.request_id
      : makeRequestId();

  const screenshotOptions = {};
  if (Number.isInteger(args?.max_width)) screenshotOptions.max_width = args.max_width;
  if (Number.isInteger(args?.max_height)) screenshotOptions.max_height = args.max_height;
  if (typeof args?.quality === 'number') screenshotOptions.quality = args.quality;
  if (Number.isInteger(args?.max_chars)) screenshotOptions.max_chars = args.max_chars;
  if (Number.isInteger(args?.tab_id)) screenshotOptions.tab_id = args.tab_id;
  screenshotOptions.encoding = SCREENSHOT_CONTRACT.encoding;

  if (name === 'airkvm_list_tabs') {
    return { type: 'tabs.list.request', request_id: requestId };
  }
  if (name === 'airkvm_open_tab') {
    const command = {
      type: 'tab.open.request',
      request_id: requestId,
      url: typeof args?.url === 'string' ? args.url : '',
      active: typeof args?.active === 'boolean' ? args.active : true
    };
    return command;
  }
  if (name === 'airkvm_dom_snapshot') {
    return { type: 'dom.snapshot.request', request_id: requestId };
  }
  if (name === 'airkvm_exec_js_tab') {
    const command = {
      type: 'js.exec.request',
      request_id: requestId,
      script: typeof args?.script === 'string' ? args.script : ''
    };
    if (Number.isInteger(args?.tab_id)) command.tab_id = args.tab_id;
    if (Number.isInteger(args?.timeout_ms)) command.timeout_ms = args.timeout_ms;
    if (Number.isInteger(args?.max_result_chars)) command.max_result_chars = args.max_result_chars;
    return command;
  }
  if (name === 'airkvm_screenshot_tab') {
    return { type: 'screenshot.request', source: 'tab', request_id: requestId, ...screenshotOptions };
  }
  if (name === 'airkvm_screenshot_desktop') {
    const desktopOptions = { ...screenshotOptions };
    if (Number.isInteger(args?.desktop_delay_ms)) desktopOptions.desktop_delay_ms = args.desktop_delay_ms;
    return { type: 'screenshot.request', source: 'desktop', request_id: requestId, ...desktopOptions };
  }

  return null;
}

function isCorrelatedDeviceRejection(msg, requestId) {
  if (typeof msg?.ok !== 'boolean' || msg.ok !== false) return false;
  if (typeof requestId !== 'string' || requestId.length === 0) return true;
  const msgRequestId = msg?.request_id ?? msg?.rid ?? null;
  return typeof msgRequestId === 'string' && msgRequestId === requestId;
}

export function createResponseCollector(name, command) {
  if (name === 'airkvm_dom_snapshot') {
    const requestId = command.request_id;
    const chunksBySeq = new Map();
    let transferMeta = null;
    let transferId = null;
    let receivedBytes = 0;
    let highestContiguousSeq = -1;
    let lastAckSeq = -1;
    let pendingGapNackSeq = null;
    let timeoutRetries = 0;
    let preMetaTimeoutRetries = 0;
    let sawTransferDone = false;
    const kMaxDomRawBytes = 2 * 1024 * 1024;
    const kAckStride = 8;
    const kMaxTimeoutRetries = 3;
    const kMaxPreMetaTimeoutRetries = 6;
    const kPreMetaExtendMs = 5000;

    function computeHighestContiguousSeq() {
      let seq = -1;
      while (chunksBySeq.has(seq + 1)) {
        seq += 1;
      }
      return seq;
    }

    function maybeAck(force = false) {
      if (!transferId) return null;
      highestContiguousSeq = computeHighestContiguousSeq();
      if (!force && highestContiguousSeq < 0) return null;
      if (!force && highestContiguousSeq - lastAckSeq < kAckStride) return null;
      if (highestContiguousSeq === lastAckSeq) return null;
      lastAckSeq = highestContiguousSeq;
      return {
        type: 'transfer.ack',
        request_id: requestId,
        transfer_id: transferId,
        highest_contiguous_seq: highestContiguousSeq
      };
    }

    const onFrame = (msg, frame) => {
      if (frame?.kind === 'bin_error') {
        // Ignore pre-meta/mismatched binary errors to avoid poisoning a fresh request.
        if (!transferId || frame.transfer_id !== transferId) {
          return null;
        }
        if (Number.isInteger(frame.seq)) {
          return {
            done: false,
            outbound: [{
              type: 'transfer.nack',
              request_id: requestId,
              transfer_id: transferId,
              seq: frame.seq,
              reason: frame.error || 'chunk_error'
            }],
            extendTimeoutMs: 7000
          };
        }
        return null;
      }

      if (frame?.kind === 'bin') {
        if (!transferMeta || !transferId) return null;
        if (frame.transfer_id !== transferId) return null;
        if (!Number.isInteger(frame.seq) || !Buffer.isBuffer(frame.payload)) return null;

        const seq = frame.seq;
        const bytes = frame.payload;
        const beforeHighest = computeHighestContiguousSeq();
        if (!chunksBySeq.has(seq)) {
          receivedBytes += bytes.length;
        }
        if (receivedBytes > kMaxDomRawBytes) {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              error: 'dom_snapshot_response_too_large',
              detail: { received_bytes: receivedBytes, max_raw_bytes: kMaxDomRawBytes }
            }
          };
        }
        chunksBySeq.set(seq, bytes);
        const afterHighest = computeHighestContiguousSeq();
        const outbound = [];
        if (pendingGapNackSeq !== null && chunksBySeq.has(pendingGapNackSeq)) {
          pendingGapNackSeq = null;
        }
        if (seq > beforeHighest + 1) {
          const missingSeq = beforeHighest + 1;
          if (!chunksBySeq.has(missingSeq) && pendingGapNackSeq !== missingSeq) {
            pendingGapNackSeq = missingSeq;
            outbound.push({
              type: 'transfer.nack',
              request_id: requestId,
              transfer_id: transferId,
              seq: missingSeq,
              reason: 'missing_chunk'
            });
          }
        }
        highestContiguousSeq = afterHighest;
        const ack = maybeAck(false);
        if (ack) outbound.push(ack);
        if (outbound.length > 0) {
          return { done: false, outbound, extendTimeoutMs: 7000 };
        }
        return null;
      }

      if (!msg || typeof msg !== 'object') return null;
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'dom.snapshot' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: { request_id: requestId, snapshot: msg }
        };
      }
      if (msg?.type === 'dom.snapshot.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'dom_snapshot_error', detail: msg }
        };
      }
      if (msg?.type === 'transfer.error' && msg?.request_id === requestId) {
        const msgTransferId = msg.transfer_id || msg.tid || null;
        const code = msg.code || msg.error || 'transfer_error';
        if (!transferId) {
          // Pre-meta no_such_transfer can be caused by stale parse noise; ignore it.
          if (code === 'no_such_transfer') return null;
        } else if (msgTransferId && msgTransferId !== transferId) {
          return null;
        }
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: code,
            detail: msg
          }
        };
      }
      if (msg?.type === 'transfer.meta' && msg?.request_id === requestId) {
        const source = msg.source ?? msg.src;
        if (source !== 'dom') return null;
        transferMeta = msg;
        transferId = msg.transfer_id || msg.tid || transferId;
        const totalBytes = msg.total_bytes ?? msg.tb;
        if (Number.isInteger(totalBytes) && totalBytes > kMaxDomRawBytes) {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              error: 'dom_snapshot_response_too_large',
              detail: { total_bytes: totalBytes, max_raw_bytes: kMaxDomRawBytes }
            }
          };
        }
      } else if (msg?.type === 'transfer.done' && msg?.request_id === requestId) {
        const doneTransferId = msg.transfer_id || msg.tid || null;
        if (transferId && doneTransferId && doneTransferId !== transferId) {
          return null;
        }
        sawTransferDone = true;
      }

      const totalChunks = transferMeta ? (transferMeta.total_chunks ?? transferMeta.tc ?? transferMeta.total ?? transferMeta.t) : null;
      if (!transferMeta || !Number.isInteger(totalChunks) || totalChunks < 0) {
        return null;
      }
      if (!sawTransferDone) {
        return null;
      }
      if (chunksBySeq.size < totalChunks) {
        return null;
      }

      const ordered = [];
      for (let seq = 0; seq < totalChunks; seq += 1) {
        if (!chunksBySeq.has(seq)) {
          return null;
        }
        ordered.push(chunksBySeq.get(seq));
      }
      const rawBytes = Buffer.concat(ordered);
      if (rawBytes.length > kMaxDomRawBytes) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: 'dom_snapshot_response_too_large',
            detail: { received_bytes: rawBytes.length, max_raw_bytes: kMaxDomRawBytes }
          }
        };
      }
      let parsedSnapshot = null;
      try {
        parsedSnapshot = JSON.parse(rawBytes.toString('utf8'));
      } catch {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: 'dom_snapshot_decode_failed'
          }
        };
      }
      return {
        done: true,
        ok: true,
        outbound: transferId
          ? [{
            type: 'transfer.done.ack',
            request_id: requestId,
            transfer_id: transferId
          }]
          : undefined,
        data: {
          request_id: requestId,
          snapshot: parsedSnapshot
        }
      };
    };
    onFrame.onTimeout = () => {
      if (!transferId) {
        if (preMetaTimeoutRetries >= kMaxPreMetaTimeoutRetries) {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              error: 'dom_snapshot_meta_timeout',
              detail: {
                retries: preMetaTimeoutRetries
              }
            }
          };
        }
        preMetaTimeoutRetries += 1;
        return {
          done: false,
          extendTimeoutMs: kPreMetaExtendMs
        };
      }
      if (timeoutRetries >= kMaxTimeoutRetries) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: 'dom_snapshot_transfer_timeout',
            detail: {
              transfer_id: transferId,
              retries: timeoutRetries,
              highest_contiguous_seq: computeHighestContiguousSeq()
            }
          }
        };
      }
      timeoutRetries += 1;
      const fromSeq = computeHighestContiguousSeq() + 1;
      return {
        done: false,
        outbound: [{
          type: 'transfer.resume',
          request_id: requestId,
          transfer_id: transferId,
          from_seq: fromSeq
        }],
        extendTimeoutMs: 7000
      };
    };
    return onFrame;
  }

  if (name === 'airkvm_list_tabs') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'tabs.list' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: {
            request_id: requestId,
            tabs: Array.isArray(msg.tabs) ? msg.tabs : []
          }
        };
      }
      if (msg?.type === 'tabs.list.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'tabs_list_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_open_tab') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'tab.open' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: msg
        };
      }
      if (msg?.type === 'tab.open.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'tab_open_error', detail: msg }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_exec_js_tab') {
    const requestId = command.request_id;
    return (msg) => {
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msg?.type === 'js.exec.result' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: true,
          data: msg
        };
      }
      if (msg?.type === 'js.exec.error' && msg?.request_id === requestId) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            error: msg.error || msg.error_code || 'js_exec_error',
            detail: msg
          }
        };
      }
      return null;
    };
  }

  if (name === 'airkvm_screenshot_tab' || name === 'airkvm_screenshot_desktop') {
    const requestId = command.request_id;
    const maxChars = Number.isInteger(command.max_chars) ? command.max_chars : SCREENSHOT_CONTRACT.maxChars.max;
    const chunksBySeq = new Map();
    let meta = null;
    let receivedBytes = 0;
    let transferId = null;
    let highestContiguousSeq = -1;
    let lastAckSeq = -1;
    let pendingGapNackSeq = null;
    let timeoutRetries = 0;
    let preMetaTimeoutRetries = 0;
    let sawTransferDone = false;
    const kMaxTimeoutRetries = 3;
    const kMaxPreMetaTimeoutRetries = 6;
    const kAckStride = 8;
    const kPreMetaExtendMs = 5000;
    const maxRawBytes = Math.floor((maxChars * 3) / 4);

    function computeHighestContiguousSeq() {
      let seq = -1;
      while (chunksBySeq.has(seq + 1)) {
        seq += 1;
      }
      return seq;
    }

    function maybeAck(force = false) {
      if (!transferId) return null;
      highestContiguousSeq = computeHighestContiguousSeq();
      if (!force && highestContiguousSeq < 0) return null;
      if (!force && highestContiguousSeq - lastAckSeq < kAckStride) return null;
      if (highestContiguousSeq === lastAckSeq) return null;
      lastAckSeq = highestContiguousSeq;
      return {
        type: 'transfer.ack',
        request_id: requestId,
        transfer_id: transferId,
        highest_contiguous_seq: highestContiguousSeq
      };
    }

    const onFrame = (msg, frame) => {
      if (frame?.kind === 'bin_error') {
        if (typeof frame.transfer_id === 'string' && Number.isInteger(frame.seq)) {
          return {
            done: false,
            outbound: [{
              type: 'transfer.nack',
              request_id: requestId,
              transfer_id: frame.transfer_id,
              seq: frame.seq,
              reason: frame.error || 'chunk_error'
            }],
            extendTimeoutMs: 7000
          };
        }
        return null;
      }

      if (frame?.kind === 'bin') {
        if (!meta || !transferId) return null;
        if (frame.transfer_id !== transferId) return null;
        if (!Number.isInteger(frame.seq) || !Buffer.isBuffer(frame.payload)) return null;

        const seq = frame.seq;
        const bytes = frame.payload;
        const beforeHighest = computeHighestContiguousSeq();
        if (!chunksBySeq.has(seq)) {
          receivedBytes += bytes.length;
        }
        if (receivedBytes > maxRawBytes) {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              source: (meta.source ?? meta.src) || command.source,
              error: 'screenshot_response_too_large',
              detail: { received_bytes: receivedBytes, max_raw_bytes: maxRawBytes }
            }
          };
        }
        chunksBySeq.set(seq, bytes);
        const afterHighest = computeHighestContiguousSeq();
        const outbound = [];
        if (pendingGapNackSeq !== null && chunksBySeq.has(pendingGapNackSeq)) {
          pendingGapNackSeq = null;
        }
        if (seq > beforeHighest + 1) {
          const missingSeq = beforeHighest + 1;
          if (!chunksBySeq.has(missingSeq) && pendingGapNackSeq !== missingSeq) {
            pendingGapNackSeq = missingSeq;
            outbound.push({
              type: 'transfer.nack',
              request_id: requestId,
              transfer_id: transferId,
              seq: missingSeq,
              reason: 'missing_chunk'
            });
          }
        }
        highestContiguousSeq = afterHighest;
        const ack = maybeAck(false);
        if (ack) {
          outbound.push(ack);
        }
        if (outbound.length > 0) return { done: false, outbound, extendTimeoutMs: 7000 };
        return null;
      }

      if (!msg || typeof msg !== 'object') return null;
      const msgRequestId = msg?.request_id ?? msg?.rid;
      const msgSource = msg.source ?? msg.src;
      const msgError = msg.error ?? msg.e;
      if (isCorrelatedDeviceRejection(msg, requestId)) {
        return {
          done: true,
          ok: false,
          data: { request_id: requestId, error: msg.error || 'device_rejected', device: msg }
        };
      }
      if (msgRequestId !== requestId) {
        return null;
      }
      if (msg?.type === 'screenshot.error') {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: msgError || 'screenshot_error',
            detail: msg
          }
        };
      }
      if (msg?.type === 'transfer.error' && msgRequestId === requestId) {
        const code = msg.code || msgError || 'transfer_error';
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: code,
            detail: msg
          }
        };
      }
      if (msg?.type === 'transfer.meta') {
        meta = msg;
        transferId = msg.transfer_id || msg.tid || transferId;
      } else if (msg?.type === 'transfer.done') {
        const doneTransferId = msg.transfer_id || msg.tid || null;
        if (transferId && doneTransferId && doneTransferId !== transferId) {
          return null;
        }
        sawTransferDone = true;
      }

      const totalChunks = meta ? (meta.total_chunks ?? meta.tc ?? meta.total ?? meta.t) : null;
      const totalBytes = meta ? (meta.total_bytes ?? meta.tb) : null;
      const encoding = 'bin';
      if (!meta || !Number.isInteger(totalChunks) || totalChunks < 0) {
        return null;
      }
      if (Number.isInteger(totalBytes) && totalBytes > maxRawBytes) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: msgSource || command.source,
            error: 'screenshot_response_too_large',
            detail: { total_bytes: totalBytes, max_raw_bytes: maxRawBytes }
          }
        };
      }
      if (!sawTransferDone) {
        return null;
      }
      if (chunksBySeq.size < totalChunks) {
        return null;
      }

      const ordered = [];
      for (let seq = 0; seq < totalChunks; seq += 1) {
        if (!chunksBySeq.has(seq)) {
          return null;
        }
        ordered.push(chunksBySeq.get(seq));
      }

      const rawBytes = Buffer.concat(ordered);
      const normalizedBase64 = rawBytes.toString('base64');
      const mime = (meta.mime ?? meta.m) || 'application/octet-stream';
      if (!base64LooksLikeMime(normalizedBase64, mime)) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: (meta.source ?? meta.src) || command.source,
            error: 'screenshot_corrupt_payload',
            detail: { mime }
          }
        };
      }
      return {
        done: true,
        ok: true,
        outbound: transferId
          ? [{
            type: 'transfer.done.ack',
            request_id: requestId,
            transfer_id: transferId
          }]
          : undefined,
        data: {
          request_id: requestId,
          source: (meta.source ?? meta.src) || command.source,
          mime,
          total_chunks: totalChunks,
          total_chars: typeof (meta.total_chars ?? meta.tch) === 'number'
            ? (meta.total_chars ?? meta.tch)
            : normalizedBase64.length,
          encoding,
          base64: normalizedBase64
        }
      };
    };
    onFrame.onTimeout = () => {
      if (!transferId) {
        if (preMetaTimeoutRetries >= kMaxPreMetaTimeoutRetries) {
          return {
            done: true,
            ok: false,
            data: {
              request_id: requestId,
              source: command.source,
              error: 'screenshot_meta_timeout',
              detail: {
                retries: preMetaTimeoutRetries
              }
            }
          };
        }
        preMetaTimeoutRetries += 1;
        return {
          done: false,
          extendTimeoutMs: kPreMetaExtendMs
        };
      }
      if (timeoutRetries >= kMaxTimeoutRetries) {
        return {
          done: true,
          ok: false,
          data: {
            request_id: requestId,
            source: command.source,
            error: 'screenshot_transfer_timeout',
            detail: {
              transfer_id: transferId,
              retries: timeoutRetries,
              highest_contiguous_seq: computeHighestContiguousSeq()
            }
          }
        };
      }
      timeoutRetries += 1;
      const fromSeq = computeHighestContiguousSeq() + 1;
      return {
        done: false,
        outbound: [{
          type: 'transfer.resume',
          request_id: requestId,
          transfer_id: transferId,
          from_seq: fromSeq
        }],
        extendTimeoutMs: 7000
      };
    };
    return onFrame;
  }

  return null;
}
