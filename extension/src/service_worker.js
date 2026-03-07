import { dataUrlToMetaAndChunks, resolveScreenshotConfig } from './screenshot_protocol.js';
const kBleBridgePagePath = 'src/ble_bridge.html';
const kDebug = true;
let lastAutomationTabId = null;
let bridgeTraceSeq = 0;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-sw]', ...args);
}

function setBadge(text, color) {
  if (!chrome?.action?.setBadgeText || !chrome?.action?.setBadgeBackgroundColor) return;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadgeLater(ms = 5000) {
  setTimeout(() => {
    if (!chrome?.action?.setBadgeText) return;
    chrome.action.setBadgeText({ text: '' });
  }, ms);
}

async function ensureBleBridgePage() {
  if (!chrome?.tabs?.query || !chrome?.tabs?.create) return false;
  const url = chrome.runtime.getURL(kBleBridgePagePath);
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    debugLog('bridge page already open', { count: existing.length });
    return true;
  }
  debugLog('opening bridge page');
  await chrome.tabs.create({ url, active: true });
  return true;
}

function isAutomationCandidateTab(tab) {
  if (!tab?.id) return false;
  const url = String(tab.url || '');
  if (!url) return true;
  if (url.startsWith('edge://') || url.startsWith('chrome://')) return false;
  if (url.startsWith('chrome-extension://') || url.startsWith('edge-extension://')) return false;
  return true;
}

async function resolveTargetTab() {
  if (Number.isInteger(lastAutomationTabId)) {
    try {
      const tab = await chrome.tabs.get(lastAutomationTabId);
      if (isAutomationCandidateTab(tab)) return tab;
    } catch {
      // fall through
    }
  }

  const candidates = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = candidates.find((tab) => isAutomationCandidateTab(tab));
  if (active) {
    lastAutomationTabId = active.id;
    return active;
  }

  const all = await chrome.tabs.query({ lastFocusedWindow: true });
  const fallback = all.find((tab) => isAutomationCandidateTab(tab));
  if (fallback) {
    lastAutomationTabId = fallback.id;
    return fallback;
  }
  return null;
}

async function postEventViaBridge(payload) {
  bridgeTraceSeq += 1;
  const traceId = `sw-${Date.now()}-${bridgeTraceSeq}`;
  debugLog('postEventViaBridge tx', {
    traceId,
    type: payload?.type,
    keys: Object.keys(payload || {}),
    bytes: JSON.stringify(payload || {}).length
  });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ble.post',
      target: 'ble-page',
      payload,
      traceId
    });
    debugLog('postEventViaBridge rx', { traceId, res });
    return Boolean(res?.ok);
  } catch {
    debugLog('postEventViaBridge failed', { traceId });
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'ble.bridge.status') {
    debugLog('bridge status', { status: msg.status, detail: msg.detail ?? null, tabId: sender?.tab?.id ?? null });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type.startsWith('ble.')) {
    // Internal bridge control messages are handled by dedicated listeners below.
    return;
  }
  if (msg.target === 'ble-page') return;
  if (msg.type !== 'busy.changed' && msg.type !== 'dom.summary') {
    debugLog('ignoring non-bridge content message', { type: msg.type });
    return;
  }
  debugLog('runtime message from content', { type: msg.type, tabId: sender?.tab?.id ?? null });
  if (Number.isInteger(sender?.tab?.id)) {
    lastAutomationTabId = sender.tab.id;
  }

  postEventViaBridge({ ...msg, tabId: sender?.tab?.id ?? null })
    .then((ok) => sendResponse({ ok }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

function makeRequestId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function captureTabPng(config) {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  return compressDataUrlToJpeg(dataUrl, config);
}

async function captureDesktopPng(config) {
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
    return encodeBitmapToJpegDataUrl(bitmap, config);
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

async function encodeBitmapToJpegDataUrl(bitmap, config) {
  let size = fitWithin(bitmap.width, bitmap.height, config.maxWidth, config.maxHeight);
  let quality = config.jpegQuality;
  let bestBlob = null;
  let bestEstimatedBase64Chars = Number.POSITIVE_INFINITY;
  let attempts = 0;

  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    attempts = attempt + 1;
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas_2d_unavailable');
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    bestBlob = blob;

    const estimatedBase64Chars = Math.ceil((blob.size * 4) / 3);
    bestEstimatedBase64Chars = estimatedBase64Chars;
    if (estimatedBase64Chars <= config.maxBase64Chars) {
      break;
    }

    const nextWidth = Math.max(1, Math.round(size.width * config.downscaleFactor));
    const nextHeight = Math.max(1, Math.round(size.height * config.downscaleFactor));
    size = { width: nextWidth, height: nextHeight };
    quality = Math.max(config.minJpegQuality, quality - 0.1);
  }

  if (!bestBlob) {
    throw new Error('screenshot_encode_failed');
  }
  if (bestEstimatedBase64Chars > config.maxBase64Chars) {
    throw new Error('screenshot_too_large');
  }
  const dataUrl = await blobToDataUrl(bestBlob);
  return {
    dataUrl,
    encodedWidth: size.width,
    encodedHeight: size.height,
    encodedQuality: quality,
    estimatedBase64Chars: bestEstimatedBase64Chars,
    attempts
  };
}

async function compressDataUrlToJpeg(dataUrl, config) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return encodeBitmapToJpegDataUrl(bitmap, config);
}

async function sendDomSnapshot(command) {
  debugLog('sendDomSnapshot start', command);
  const requestId = command.request_id || makeRequestId();
  const tab = await resolveTargetTab();
  if (!tab?.id) throw new Error('active_tab_not_found');
  let summary = null;
  try {
    summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
  } catch (err) {
    debugLog('sendDomSnapshot tab message failed', String(err?.message || err));
  }
  const title = summary?.title || tab.title || '';
  const normalizedSummary = summary && typeof summary === 'object'
    ? { ...summary, title: summary.title || title }
    : { type: 'dom.summary', ts: Date.now(), url: tab.url || '', title, focus: { tag: null, id: null }, actionable: [] };
  debugLog('sendDomSnapshot got summary', { tabId: tab.id, title: normalizedSummary?.title ?? null });
  await postEventViaBridge({
    type: 'dom.snapshot',
    request_id: requestId,
    tabId: tab.id,
    ts: Date.now(),
    summary: normalizedSummary
  });
}

async function sendScreenshot(command) {
  debugLog('sendScreenshot start', command);
  const source = command.source === 'desktop' ? 'desktop' : 'tab';
  const requestId = command.request_id || makeRequestId();
  const config = resolveScreenshotConfig(command);
  const encoded = source === 'desktop' ? await captureDesktopPng(config) : await captureTabPng(config);
  const { meta, chunks } = dataUrlToMetaAndChunks(encoded.dataUrl, requestId, source, encoded);
  debugLog('sendScreenshot encoded', { source, requestId, chunks: chunks.length, totalChars: meta.tch });
  await postEventViaBridge(meta);
  for (const chunk of chunks) {
    // BLE payloads are chunked to reduce risk of exceeding negotiated MTU.
    await postEventViaBridge(chunk);
  }
}

async function handleBleCommand(command) {
  debugLog('handleBleCommand', command);
  if (!command || typeof command.type !== 'string') return;
  if (command.type === 'dom.snapshot.request') {
    try {
      await sendDomSnapshot(command);
    } catch (err) {
      debugLog('sendDomSnapshot error', String(err?.message || err));
      await postEventViaBridge({
        type: 'dom.snapshot.error',
        request_id: command.request_id || null,
        error: String(err?.message || err),
        ts: Date.now()
      });
    }
    return;
  }
  if (command.type === 'screenshot.request') {
    try {
      await sendScreenshot(command);
    } catch (err) {
      debugLog('sendScreenshot error', String(err?.message || err));
      await postEventViaBridge({
        type: 'screenshot.error',
        request_id: command.request_id || null,
        source: command.source || 'tab',
        error: String(err?.message || err),
        ts: Date.now()
      });
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.command') return;
  debugLog('runtime ble.command', msg.command);
  handleBleCommand(msg.command)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  debugLog('action clicked', { tabId: tab?.id ?? null });
  if (isAutomationCandidateTab(tab)) {
    lastAutomationTabId = tab.id;
  }
  setBadge('...', '#5B6CFF');
  try {
    await ensureBleBridgePage();
    setBadge('TAB', '#9E9E9E');
    if (!tab.id) {
      clearBadgeLater();
      return;
    }
    const summary = await chrome.tabs.sendMessage(tab.id, { type: 'request.dom.summary' });
    await postEventViaBridge({ ...summary, tabId: tab.id });
    clearBadgeLater();
  } catch {
    setBadge('ERR', '#D93025');
    clearBadgeLater();
  }
});
