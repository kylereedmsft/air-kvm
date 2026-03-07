import { connectBle, postEvent, setBleCommandHandler } from './bridge.js';

const kScreenshotConfig = {
  maxWidth: 960,
  maxHeight: 540,
  jpegQuality: 0.55,
  maxBase64Chars: 90000,
  maxAttempts: 4,
  downscaleFactor: 0.8,
  minJpegQuality: 0.45
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  postEvent({ ...msg, tabId: sender?.tab?.id ?? null })
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

function makeRequestId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function captureTabPng() {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  return compressDataUrlToJpeg(dataUrl);
}

async function captureDesktopPng() {
  if (!chrome.desktopCapture?.chooseDesktopMedia) {
    throw new Error('desktop_capture_unavailable');
  }

  const streamId = await new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(['screen', 'window'], (id) => {
      if (!id) {
        reject(new Error('desktop_capture_denied'));
        return;
      }
      resolve(id);
    });
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId
      }
    }
  });

  try {
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error('desktop_capture_no_track');
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();
    return encodeBitmapToJpegDataUrl(bitmap);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

function fitWithin(width, height, maxWidth, maxHeight) {
  if (width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function blobToDataUrl(blob) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function encodeBitmapToJpegDataUrl(bitmap) {
  let size = fitWithin(bitmap.width, bitmap.height, kScreenshotConfig.maxWidth, kScreenshotConfig.maxHeight);
  let quality = kScreenshotConfig.jpegQuality;
  let bestBlob = null;
  let bestEstimatedBase64Chars = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < kScreenshotConfig.maxAttempts; attempt += 1) {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_2d_unavailable');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    bestBlob = blob;

    const estimatedBase64Chars = Math.ceil((blob.size * 4) / 3);
    bestEstimatedBase64Chars = estimatedBase64Chars;
    if (estimatedBase64Chars <= kScreenshotConfig.maxBase64Chars) {
      break;
    }

    const nextWidth = Math.max(1, Math.round(size.width * kScreenshotConfig.downscaleFactor));
    const nextHeight = Math.max(1, Math.round(size.height * kScreenshotConfig.downscaleFactor));
    size = { width: nextWidth, height: nextHeight };
    quality = Math.max(kScreenshotConfig.minJpegQuality, quality - 0.1);
  }

  if (!bestBlob) {
    throw new Error('screenshot_encode_failed');
  }
  if (bestEstimatedBase64Chars > kScreenshotConfig.maxBase64Chars) {
    throw new Error('screenshot_too_large');
  }
  return blobToDataUrl(bestBlob);
}

async function compressDataUrlToJpeg(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return encodeBitmapToJpegDataUrl(bitmap);
}

function dataUrlToMetaAndChunks(dataUrl, requestId, source) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('screenshot_invalid_data_url');
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
  const mime = mimeMatch?.[1] || 'application/octet-stream';
  const chunkSize = 120;
  const totalChunks = Math.ceil(base64.length / chunkSize);
  const meta = {
    type: 'screenshot.meta',
    request_id: requestId,
    source,
    mime,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    total_chars: base64.length,
    ts: Date.now()
  };
  const chunks = [];
  for (let seq = 0; seq < totalChunks; seq += 1) {
    chunks.push({
      type: 'screenshot.chunk',
      request_id: requestId,
      source,
      seq,
      data: base64.slice(seq * chunkSize, (seq + 1) * chunkSize),
      ts: Date.now()
    });
  }
  return { meta, chunks };
}

async function sendDomSnapshot(command) {
  const requestId = command.request_id || makeRequestId();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('active_tab_not_found');
  const summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
  await postEvent({
    type: 'dom.snapshot',
    request_id: requestId,
    tabId: tab.id,
    ts: Date.now(),
    summary
  });
}

async function sendScreenshot(command) {
  const source = command.source === 'desktop' ? 'desktop' : 'tab';
  const requestId = command.request_id || makeRequestId();
  const dataUrl = source === 'desktop' ? await captureDesktopPng() : await captureTabPng();
  const { meta, chunks } = dataUrlToMetaAndChunks(dataUrl, requestId, source);
  await postEvent(meta);
  for (const chunk of chunks) {
    // BLE payloads are chunked to reduce risk of exceeding negotiated MTU.
    await postEvent(chunk);
  }
}

setBleCommandHandler((command) => {
  if (!command || typeof command.type !== 'string') return;
  if (command.type === 'dom.snapshot.request') {
    sendDomSnapshot(command).catch(async (err) => {
      await postEvent({
        type: 'dom.snapshot.error',
        request_id: command.request_id || null,
        error: String(err?.message || err),
        ts: Date.now()
      });
    });
    return;
  }
  if (command.type === 'screenshot.request') {
    sendScreenshot(command).catch(async (err) => {
      await postEvent({
        type: 'screenshot.error',
        request_id: command.request_id || null,
        source: command.source || 'tab',
        error: String(err?.message || err),
        ts: Date.now()
      });
    });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await connectBle();
    const summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
    await postEvent({ ...summary, tabId: tab.id });
  } catch {
    // No content script or unavailable tab context.
  }
});
