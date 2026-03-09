import { SCREENSHOT_CONTRACT } from './screenshot_contract.js';

export const kDefaultScreenshotConfig = {
  maxWidth: SCREENSHOT_CONTRACT.width.default,
  maxHeight: SCREENSHOT_CONTRACT.height.default,
  jpegQuality: SCREENSHOT_CONTRACT.quality.default,
  maxBase64Chars: SCREENSHOT_CONTRACT.maxChars.default,
  desktopDelayMs: SCREENSHOT_CONTRACT.desktopDelayMs.default,
  maxAttempts: SCREENSHOT_CONTRACT.maxAttempts,
  downscaleFactor: SCREENSHOT_CONTRACT.downscaleFactor,
  minJpegQuality: SCREENSHOT_CONTRACT.quality.minEncode
};

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveScreenshotConfig(command, base = kDefaultScreenshotConfig) {
  return {
    maxWidth: clampInt(command?.max_width, SCREENSHOT_CONTRACT.width.min, SCREENSHOT_CONTRACT.width.max, base.maxWidth),
    maxHeight: clampInt(command?.max_height, SCREENSHOT_CONTRACT.height.min, SCREENSHOT_CONTRACT.height.max, base.maxHeight),
    jpegQuality: clampNumber(command?.quality, SCREENSHOT_CONTRACT.quality.min, SCREENSHOT_CONTRACT.quality.max, base.jpegQuality),
    maxBase64Chars: clampInt(command?.max_chars, SCREENSHOT_CONTRACT.maxChars.min, SCREENSHOT_CONTRACT.maxChars.max, base.maxBase64Chars),
    desktopDelayMs: clampInt(
      command?.desktop_delay_ms,
      SCREENSHOT_CONTRACT.desktopDelayMs.min,
      SCREENSHOT_CONTRACT.desktopDelayMs.max,
      base.desktopDelayMs
    ),
    encoding: SCREENSHOT_CONTRACT.encoding,
    maxAttempts: base.maxAttempts,
    downscaleFactor: base.downscaleFactor,
    minJpegQuality: base.minJpegQuality
  };
}

export function dataUrlToMetaAndChunks(dataUrl, requestId, source, transferId, _encodeStats = null, chunkSize = 160) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('screenshot_invalid_data_url');

  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
  const mime = mimeMatch?.[1] || 'application/octet-stream';
  const binary = atob(base64);
  const totalBytes = binary.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);

  const meta = {
    type: 'transfer.meta',
    request_id: requestId,
    transfer_id: transferId,
    source,
    mime,
    encoding: 'bin',
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    total_bytes: totalBytes
  };
  if (_encodeStats && typeof _encodeStats === 'object') {
    if (Number.isInteger(_encodeStats.encodedWidth)) {
      meta.encoded_width = _encodeStats.encodedWidth;
    }
    if (Number.isInteger(_encodeStats.encodedHeight)) {
      meta.encoded_height = _encodeStats.encodedHeight;
    }
    if (Number.isInteger(_encodeStats.sourceWidth)) {
      meta.source_width = _encodeStats.sourceWidth;
    }
    if (Number.isInteger(_encodeStats.sourceHeight)) {
      meta.source_height = _encodeStats.sourceHeight;
    }
    if (typeof _encodeStats.encodedQuality === 'number' && Number.isFinite(_encodeStats.encodedQuality)) {
      meta.encoded_quality = _encodeStats.encodedQuality;
    }
    if (Number.isInteger(_encodeStats.attempts)) {
      meta.encode_attempts = _encodeStats.attempts;
    }
  }

  const chunks = [];
  for (let seq = 0; seq < totalChunks; seq += 1) {
    const start = seq * chunkSize;
    const end = Math.min(totalBytes, start + chunkSize);
    const bytes = new Uint8Array(end - start);
    for (let i = start; i < end; i += 1) {
      bytes[i - start] = binary.charCodeAt(i);
    }
    chunks.push({
      seq,
      bytes
    });
  }

  return { meta, chunks };
}
