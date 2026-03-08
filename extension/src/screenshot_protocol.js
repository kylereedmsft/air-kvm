export const kDefaultScreenshotConfig = {
  maxWidth: 960,
  maxHeight: 540,
  jpegQuality: 0.55,
  maxBase64Chars: 90000,
  maxAttempts: 4,
  downscaleFactor: 0.8,
  minJpegQuality: 0.45
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
    maxWidth: clampInt(command?.max_width, 160, 1920, base.maxWidth),
    maxHeight: clampInt(command?.max_height, 120, 1080, base.maxHeight),
    jpegQuality: clampNumber(command?.quality, 0.3, 0.9, base.jpegQuality),
    maxBase64Chars: clampInt(command?.max_chars, 20000, 200000, base.maxBase64Chars),
    encoding: 'bin',
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
