import { dataUrlToMetaAndChunks, resolveScreenshotConfig } from './screenshot_protocol.js';
import { encodeTransferChunkFrame, makeTransferId } from './binary_frame.js';
const kBleBridgePagePath = 'src/ble_bridge.html';
const kDebugDefault = false;
const kDebugStorageKey = 'airkvmVerboseBridgeLog';
const kScreenshotCaptureTimeoutMs = 25000;
const kScreenshotStageTimeoutMs = 10000;
const kTransferAckWindow = 8;
const kTransferTtlMs = 2 * 60 * 1000;
const kJsExecScriptMinChars = 1;
const kJsExecScriptMaxChars = 600;
const kJsExecTimeoutMsMin = 50;
const kJsExecTimeoutMsMax = 2000;
const kJsExecTimeoutMsDefault = 750;
const kJsExecResultCharsMin = 64;
const kJsExecResultCharsMax = 700;
const kJsExecResultCharsDefault = 256;
const kJsExecErrorMaxChars = 300;
const kJsExecPostTimeoutHoldMs = 1000;
const kSwHeartbeatIntervalMs = 5000;
const kSwBreadcrumbStorageKey = 'airkvm_sw_breadcrumb';
let lastAutomationTabId = null;
let bridgeTraceSeq = 0;
let screenshotInFlight = false;
let jsExecInFlight = false;
const screenshotTransfers = new Map();
const kSwInstanceId = `sw_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
let debugEnabled = kDebugDefault;

try {
  chrome.storage?.local?.get(kDebugStorageKey).then((stored) => {
    debugEnabled = stored?.[kDebugStorageKey] === '1';
  }).catch(() => {});
} catch {
  // Non-fatal.
}

function debugLog(...args) {
  if (!debugEnabled) return;
  console.log('[airkvm-sw]', `[${kSwInstanceId}]`, ...args);
}

function activeTransferIds() {
  return Array.from(screenshotTransfers.keys());
}

async function writeSwBreadcrumb(event, detail = null) {
  if (!chrome?.storage?.session?.set) return;
  try {
    await chrome.storage.session.set({
      [kSwBreadcrumbStorageKey]: {
        instance_id: kSwInstanceId,
        ts: Date.now(),
        event,
        detail,
        active_transfer_ids: activeTransferIds()
      }
    });
  } catch {
    // Non-fatal diagnostics.
  }
}

async function readSwBreadcrumb() {
  if (!chrome?.storage?.session?.get) return null;
  try {
    const got = await chrome.storage.session.get(kSwBreadcrumbStorageKey);
    return got?.[kSwBreadcrumbStorageKey] || null;
  } catch {
    return null;
  }
}

function emitSwAliveHeartbeat() {
  chrome.runtime.sendMessage({
    type: 'ble.sw.alive',
    target: 'ble-page',
    instance_id: kSwInstanceId,
    ts: Date.now(),
    active_transfer_ids: activeTransferIds()
  }).catch(() => {});
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
  if (url.startsWith('edge://') || url.startsWith('chrome://') || url.startsWith('devtools://')) return false;
  if (
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge-extension://') ||
    url.startsWith('extension://')
  ) {
    return false;
  }
  return true;
}

function isTrustedBleCommandSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const expectedBridgeUrl = chrome.runtime.getURL(kBleBridgePagePath);
  const senderUrl = String(sender.url || sender?.tab?.url || '');
  return senderUrl === expectedBridgeUrl || senderUrl.startsWith(`${expectedBridgeUrl}#`);
}

async function resolveTargetTab(preferredTabId = null) {
  if (Number.isInteger(preferredTabId)) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (isAutomationCandidateTab(tab)) return tab;
    } catch {
      // fall through
    }
  }

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
  const anyWindowTabs = await chrome.tabs.query({});
  const crossWindowFallback = anyWindowTabs.find((tab) => isAutomationCandidateTab(tab));
  if (crossWindowFallback) {
    lastAutomationTabId = crossWindowFallback.id;
    return crossWindowFallback;
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

async function postEventOrThrow(payload, errorCode = 'bridge_post_failed') {
  const ok = await postEventViaBridge(payload);
  if (!ok) {
    throw new Error(errorCode);
  }
}

async function postBinaryViaBridge(bytes) {
  bridgeTraceSeq += 1;
  const traceId = `sw-${Date.now()}-${bridgeTraceSeq}`;
  debugLog('postBinaryViaBridge tx', { traceId, bytes: bytes?.length || 0 });
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ble.postBinary',
      target: 'ble-page',
      bytes: Array.from(bytes || []),
      traceId
    });
    debugLog('postBinaryViaBridge rx', { traceId, res });
    return Boolean(res?.ok);
  } catch {
    debugLog('postBinaryViaBridge failed', { traceId });
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'airkvm.debug.set') {
    debugEnabled = Boolean(msg.verbose);
    chrome.storage?.local?.set({ [kDebugStorageKey]: debugEnabled ? '1' : '0' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
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

function pruneScreenshotTransfers(nowTs = Date.now()) {
  for (const [transferId, session] of screenshotTransfers.entries()) {
    if (!session || nowTs - (session.updatedAt || 0) > kTransferTtlMs) {
      screenshotTransfers.delete(transferId);
    }
  }
}

function getSingleActiveTransfer() {
  pruneScreenshotTransfers();
  for (const [transferId, session] of screenshotTransfers.entries()) {
    if (session && transferId) return session;
  }
  return null;
}

function withTimeout(promise, ms, errorCode) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorCode)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clipText(value, maxChars = kJsExecErrorMaxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function normalizeJsExecCommand(command) {
  const script = typeof command?.script === 'string' ? command.script : '';
  if (script.length < kJsExecScriptMinChars || script.length > kJsExecScriptMaxChars) {
    throw new Error('invalid_js_exec_request');
  }
  return {
    requestId: command.request_id || makeRequestId(),
    script,
    tabId: Number.isInteger(command?.tab_id) ? command.tab_id : null,
    timeoutMs: clampInt(command?.timeout_ms, kJsExecTimeoutMsMin, kJsExecTimeoutMsMax, kJsExecTimeoutMsDefault),
    maxResultChars: clampInt(
      command?.max_result_chars,
      kJsExecResultCharsMin,
      kJsExecResultCharsMax,
      kJsExecResultCharsDefault
    )
  };
}

async function executeScriptInMainWorld(tabId, script, maxResultChars) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (userScript, maxChars) => {
      function valueTypeOf(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
      }

      function safeSerialize(value) {
        const seen = new WeakSet();
        const typedLiteral = (kind, payload = null) => JSON.stringify({
          __airkvm_type: kind,
          value: payload
        });
        if (typeof value === 'undefined') return typedLiteral('undefined');
        if (typeof value === 'function') return typedLiteral('function', value.name || null);
        if (typeof value === 'symbol') return typedLiteral('symbol', String(value));
        if (typeof value === 'bigint') return typedLiteral('bigint', value.toString());
        try {
          const encoded = JSON.stringify(value, (_key, candidate) => {
            if (typeof candidate === 'undefined') return { __airkvm_type: 'undefined' };
            if (typeof candidate === 'function') {
              return { __airkvm_type: 'function', value: candidate.name || null };
            }
            if (typeof candidate === 'symbol') return { __airkvm_type: 'symbol', value: String(candidate) };
            if (typeof candidate === 'bigint') return { __airkvm_type: 'bigint', value: candidate.toString() };
            if (candidate && typeof candidate === 'object') {
              if (seen.has(candidate)) return { __airkvm_type: 'circular' };
              seen.add(candidate);
            }
            return candidate;
          });
          return typeof encoded === 'string' ? encoded : 'null';
        } catch (err) {
          return typedLiteral('unserializable', String(err?.message || err));
        }
      }

      let compiled = null;
      try {
        compiled = new Function(userScript);
      } catch (err) {
        return {
          ok: false,
          error_code: 'js_exec_compile_error',
          error: String(err?.message || err)
        };
      }

      try {
        let value = compiled();
        if (value && typeof value.then === 'function') {
          value = await value;
        }
        let valueJson = safeSerialize(value);
        let truncated = false;
        if (valueJson.length > maxChars) {
          valueJson = valueJson.slice(0, maxChars);
          truncated = true;
        }
        return {
          ok: true,
          value_type: valueTypeOf(value),
          value_json: valueJson,
          truncated
        };
      } catch (err) {
        return {
          ok: false,
          error_code: 'js_exec_runtime_error',
          error: String(err?.message || err)
        };
      }
    },
    args: [script, maxResultChars]
  });
  return Array.isArray(results) && results.length > 0 ? results[0]?.result : null;
}

async function postJsExecError(requestId, tabId, startedAt, errorCode, message) {
  await postEventViaBridge({
    type: 'js.exec.error',
    request_id: requestId || null,
    tab_id: Number.isInteger(tabId) ? tabId : null,
    duration_ms: Math.max(0, Date.now() - startedAt),
    error_code: errorCode,
    error: clipText(message || errorCode),
    ts: Date.now()
  });
}

async function sendJsExec(command) {
  const startedAt = Date.now();
  let requestId = command?.request_id || makeRequestId();
  let resolvedTabId = Number.isInteger(command?.tab_id) ? command.tab_id : null;
  let keepLockedUntilScriptSettles = false;
  let pendingExecution = null;
  if (jsExecInFlight) {
    await postJsExecError(requestId, resolvedTabId, startedAt, 'js_exec_busy', 'js_exec_busy');
    return;
  }
  jsExecInFlight = true;
  try {
    const normalized = normalizeJsExecCommand(command);
    requestId = normalized.requestId;
    resolvedTabId = normalized.tabId;
    const tab = await resolveTargetTab(normalized.tabId);
    if (!tab?.id) {
      throw new Error('active_tab_not_found');
    }
    resolvedTabId = tab.id;
    lastAutomationTabId = tab.id;
    const executionPromise = executeScriptInMainWorld(tab.id, normalized.script, normalized.maxResultChars);
    pendingExecution = executionPromise;
    const result = await withTimeout(
      executionPromise,
      normalized.timeoutMs,
      'js_exec_timeout'
    );
    if (!result || typeof result !== 'object') {
      throw new Error('js_exec_invalid_result');
    }
    if (result.ok !== true) {
      await postJsExecError(
        requestId,
        resolvedTabId,
        startedAt,
        result.error_code || 'js_exec_failed',
        result.error || result.error_code || 'js_exec_failed'
      );
      return;
    }
    await postEventViaBridge({
      type: 'js.exec.result',
      request_id: requestId,
      tab_id: resolvedTabId,
      duration_ms: Math.max(0, Date.now() - startedAt),
      value_type: typeof result.value_type === 'string' ? result.value_type : 'unknown',
      value_json: typeof result.value_json === 'string' ? result.value_json : 'null',
      truncated: Boolean(result.truncated),
      ts: Date.now()
    });
  } catch (err) {
    const detail = String(err?.message || err);
    if (detail === 'js_exec_timeout') {
      keepLockedUntilScriptSettles = true;
      let released = false;
      const releaseLock = () => {
        if (released) return;
        released = true;
        jsExecInFlight = false;
      };
      const holdTimer = setTimeout(() => {
        releaseLock();
      }, kJsExecPostTimeoutHoldMs);
      void pendingExecution?.finally(() => {
        clearTimeout(holdTimer);
        releaseLock();
      });
    }
    const code = detail === 'js_exec_timeout'
      ? 'js_exec_timeout'
      : detail === 'active_tab_not_found'
        ? 'js_exec_tab_not_found'
        : detail === 'invalid_js_exec_request'
          ? 'invalid_js_exec_request'
          : 'js_exec_failed';
    await postJsExecError(requestId, resolvedTabId, startedAt, code, detail);
  } finally {
    if (!keepLockedUntilScriptSettles) {
      jsExecInFlight = false;
    }
  }
}

async function postBinaryOrThrow(bytes) {
  const ok = await postBinaryViaBridge(bytes);
  if (!ok) {
    throw new Error('binary_send_failed');
  }
}

async function pumpTransferSession(session) {
  if (!session) return;
  if (session.sending) {
    session.pumpRequested = true;
    return;
  }
  session.sending = true;
  try {
    while (session.nextSeqToSend < session.totalChunks) {
      const maxAllowedSeq = session.highestAckSeq + kTransferAckWindow;
      if (session.nextSeqToSend > maxAllowedSeq) {
        break;
      }
      const frame = session.framesBySeq.get(session.nextSeqToSend);
      session.nextSeqToSend += 1;
      if (!frame) continue;
      await postBinaryOrThrow(frame);
      session.updatedAt = Date.now();
    }
    if (session.nextSeqToSend >= session.totalChunks && !session.doneSent) {
      await postEventOrThrow({
        type: 'transfer.done',
        request_id: session.requestId,
        transfer_id: session.transferId,
        source: session.source,
        total_chunks: session.totalChunks
      }, 'transfer_done_send_failed');
      session.doneSent = true;
      session.updatedAt = Date.now();
      debugLog('transfer done sent', {
        requestId: session.requestId,
        transferId: session.transferId,
        highestAckSeq: session.highestAckSeq
      });
    }
  } finally {
    session.sending = false;
    if (session.pumpRequested) {
      session.pumpRequested = false;
      await pumpTransferSession(session);
    }
  }
}

async function captureTabPng(config) {
  const tab = await resolveTargetTab(config.tabId || null);
  if (!tab?.id) {
    throw new Error('active_tab_not_found');
  }
  if (!tab.active && chrome.tabs?.update) {
    await chrome.tabs.update(tab.id, { active: true });
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return compressDataUrlToJpeg(dataUrl, config);
}

async function captureDesktopPng(config) {
  const response = await chrome.runtime.sendMessage({
    type: 'desktop.capture.request',
    target: 'ble-page',
    desktop_delay_ms: config.desktopDelayMs
  });
  if (!response?.ok || typeof response.dataUrl !== 'string') {
    throw new Error(response?.error || 'desktop_capture_failed');
  }
  return compressDataUrlToJpeg(response.dataUrl, config);
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
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
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
    sourceWidth,
    sourceHeight,
    encodedWidth: size.width,
    encodedHeight: size.height,
    encodedQuality: quality,
    estimatedBase64Chars: bestEstimatedBase64Chars,
    attempts
  };
}

async function compressDataUrlToJpeg(dataUrl, config) {
  const response = await withTimeout(fetch(dataUrl), kScreenshotStageTimeoutMs, 'screenshot_fetch_timeout');
  const blob = await withTimeout(response.blob(), kScreenshotStageTimeoutMs, 'screenshot_blob_timeout');
  const bitmap = await withTimeout(createImageBitmap(blob), kScreenshotStageTimeoutMs, 'screenshot_bitmap_timeout');
  return withTimeout(
    encodeBitmapToJpegDataUrl(bitmap, config),
    kScreenshotStageTimeoutMs,
    'screenshot_encode_timeout'
  );
}

async function sendDomSnapshot(command) {
  debugLog('sendDomSnapshot start', command);
  const requestId = command.request_id || makeRequestId();
  const tab = await resolveTargetTab(command.tab_id || null);
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
  const activeTransfer = getSingleActiveTransfer();
  if (activeTransfer) {
    throw new Error(`screenshot_transfer_busy:${activeTransfer.transferId}`);
  }
  if (screenshotInFlight) {
    throw new Error('screenshot_busy');
  }
  screenshotInFlight = true;
  debugLog('sendScreenshot start', command);
  try {
    const source = command.source === 'desktop' ? 'desktop' : 'tab';
    const requestId = command.request_id || makeRequestId();
    const config = resolveScreenshotConfig(command);
    config.tabId = Number.isInteger(command?.tab_id) ? command.tab_id : null;
    debugLog('sendScreenshot capture begin', {
      source,
      requestId,
      tabId: config.tabId || null,
      encodingRequested: config.encoding
    });
    const encoded = await withTimeout(
      source === 'desktop' ? captureDesktopPng(config) : captureTabPng(config),
      kScreenshotCaptureTimeoutMs,
      'screenshot_capture_timeout'
    );
    debugLog('sendScreenshot capture done', {
      source,
      requestId,
      encodedWidth: encoded.encodedWidth,
      encodedHeight: encoded.encodedHeight,
      encodedQuality: encoded.encodedQuality
    });
    const transferIdMeta = makeTransferId();
    const { meta, chunks } = dataUrlToMetaAndChunks(
      encoded.dataUrl,
      requestId,
      source,
      transferIdMeta.string,
      encoded,
      160
    );
    debugLog('sendScreenshot encoded', {
      source,
      requestId,
      encoding: meta.encoding,
      chunks: chunks.length,
      totalBytes: meta.total_bytes
    });
    pruneScreenshotTransfers();
    const transferId = transferIdMeta.string;
    const transferIdNumeric = transferIdMeta.numeric;
    const framesBySeq = new Map();
    for (const chunk of chunks) {
      framesBySeq.set(
        chunk.seq,
        encodeTransferChunkFrame({
          transferIdNumeric,
          seq: chunk.seq,
          payloadBytes: chunk.bytes
        })
      );
    }
    const session = {
      transferId,
      transferIdNumeric,
      requestId,
      source,
      meta,
      framesBySeq,
      totalChunks: chunks.length,
      updatedAt: Date.now(),
      highestAckSeq: -1,
      nextSeqToSend: 0,
      doneSent: false,
      sending: false,
      pumpRequested: false
    };
    screenshotTransfers.set(transferId, session);
    debugLog('transfer session created', {
      requestId,
      transferId,
      totalChunks: chunks.length
    });
    void writeSwBreadcrumb('transfer_created', {
      request_id: requestId,
      transfer_id: transferId,
      total_chunks: chunks.length
    });

    await postEventOrThrow({
      type: 'transfer.meta',
      ...meta
    }, 'transfer_meta_send_failed');
    debugLog('transfer window start', {
      requestId,
      transferId,
      window: kTransferAckWindow
    });
    await pumpTransferSession(session);
  } finally {
    screenshotInFlight = false;
  }
}

async function sendTransferError(command, code, detail = null) {
  await postEventViaBridge({
    type: 'transfer.error',
    request_id: command?.request_id || null,
    transfer_id: command?.transfer_id || null,
    source: command?.source || null,
    code,
    detail,
    ts: Date.now()
  });
}

async function handleTransferResume(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    const breadcrumb = await readSwBreadcrumb();
    const detail = {
      instance_id: kSwInstanceId,
      active_transfer_ids: activeTransferIds(),
      last_breadcrumb: breadcrumb
    };
    debugLog('transfer resume missing session', {
      requestId: command?.request_id || null,
      transferId: transferId || null,
      detail
    });
    await sendTransferError(command, 'no_such_transfer', detail);
    return;
  }
  if (command?.request_id && session.requestId !== command.request_id) {
    await sendTransferError(command, 'request_id_mismatch');
    return;
  }
  const fromSeq = Number.isInteger(command?.from_seq)
    ? Math.max(0, command.from_seq)
    : Math.max(0, session.highestAckSeq + 1);
  session.nextSeqToSend = fromSeq;
  session.doneSent = false;
  session.updatedAt = Date.now();
  debugLog('transfer resume start', {
    requestId: session.requestId,
    transferId: session.transferId,
    fromSeq,
    totalChunks: session.totalChunks
  });
  void writeSwBreadcrumb('transfer_resume', {
    request_id: session.requestId,
    transfer_id: session.transferId,
    from_seq: fromSeq
  });
  await pumpTransferSession(session);
}

async function handleTransferAck(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  if (Number.isInteger(command?.highest_contiguous_seq)) {
    session.highestAckSeq = Math.max(session.highestAckSeq, command.highest_contiguous_seq);
  }
  session.updatedAt = Date.now();
  void writeSwBreadcrumb('transfer_ack', {
    request_id: session.requestId,
    transfer_id: session.transferId,
    highest_contiguous_seq: session.highestAckSeq
  });
  await pumpTransferSession(session);
}

async function handleTransferDoneAck(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  screenshotTransfers.delete(transferId);
  void writeSwBreadcrumb('transfer_done_ack', {
    request_id: session.requestId,
    transfer_id: transferId
  });
  debugLog('transfer done ack', {
    requestId: session.requestId,
    transferId
  });
}

async function handleTransferNack(command) {
  pruneScreenshotTransfers();
  const transferId = command?.transfer_id;
  const seq = command?.seq;
  const session = transferId ? screenshotTransfers.get(transferId) : null;
  if (!session) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  if (!Number.isInteger(seq) || seq < 0 || seq >= session.totalChunks) {
    await sendTransferError(command, 'invalid_seq');
    return;
  }
  const frame = session.framesBySeq.get(seq);
  if (!frame) {
    await sendTransferError(command, 'no_such_chunk');
    return;
  }
  session.updatedAt = Date.now();
  debugLog('transfer nack resend', {
    requestId: session.requestId,
    transferId,
    seq
  });
  await postBinaryOrThrow(frame);
  await pumpTransferSession(session);
}

async function handleTransferCancel(command) {
  const transferId = command?.transfer_id;
  if (!transferId || !screenshotTransfers.has(transferId)) {
    await sendTransferError(command, 'no_such_transfer');
    return;
  }
  screenshotTransfers.delete(transferId);
  void writeSwBreadcrumb('transfer_cancel', { transfer_id: transferId });
  await postEventViaBridge({
    type: 'transfer.cancel.ok',
    request_id: command?.request_id || null,
    transfer_id: transferId,
    ts: Date.now()
  });
}

async function handleTransferReset(command) {
  screenshotTransfers.clear();
  void writeSwBreadcrumb('transfer_reset', {
    request_id: command?.request_id || null
  });
  await postEventViaBridge({
    type: 'transfer.reset.ok',
    request_id: command?.request_id || null,
    ts: Date.now()
  });
}

async function sendTabsList(command) {
  const requestId = command.request_id || makeRequestId();
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const filtered = tabs
    .filter((tab) => isAutomationCandidateTab(tab))
    .map((tab) => ({
      id: tab.id,
      window_id: tab.windowId,
      active: Boolean(tab.active),
      title: tab.title || '',
      url: tab.url || ''
    }));
  await postEventOrThrow({
    type: 'tabs.list',
    request_id: requestId,
    tabs: filtered,
    ts: Date.now()
  }, 'tabs_list_send_failed');
}

async function sendOpenTab(command) {
  const requestId = command?.request_id || makeRequestId();
  const url = typeof command?.url === 'string' ? command.url : '';
  const active = typeof command?.active === 'boolean' ? command.active : true;

  if (!url || url.length > 2048 || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('invalid_tab_open_request');
  }

  const tab = await chrome.tabs.create({ url, active });
  const normalizedTab = {
    id: tab?.id ?? null,
    window_id: tab?.windowId ?? null,
    active: Boolean(tab?.active),
    title: tab?.title || '',
    url: tab?.url || url
  };
  if (isAutomationCandidateTab(tab) && Number.isInteger(tab?.id)) {
    lastAutomationTabId = tab.id;
  }
  await postEventViaBridge({
    type: 'tab.open',
    request_id: requestId,
    tab: normalizedTab,
    ts: Date.now()
  });
}

async function runBridgeHandler(command, label, handler, onError) {
  try {
    await handler(command);
  } catch (err) {
    const detail = String(err?.message || err);
    debugLog(`${label} error`, detail);
    await onError(command, detail);
  }
}

const kBleCommandHandlers = {
  'dom.snapshot.request': (command) => runBridgeHandler(
    command,
    'sendDomSnapshot',
    sendDomSnapshot,
    async (cmd, detail) => {
      await postEventViaBridge({
        type: 'dom.snapshot.error',
        request_id: cmd.request_id || null,
        error: detail,
        ts: Date.now()
      });
    }
  ),
  'screenshot.request': (command) => runBridgeHandler(
    command,
    'sendScreenshot',
    sendScreenshot,
    async (cmd, detail) => {
      await postEventViaBridge({
        type: 'screenshot.error',
        request_id: cmd.request_id || null,
        source: cmd.source || 'tab',
        error: detail,
        ts: Date.now()
      });
    }
  ),
  'tabs.list.request': (command) => runBridgeHandler(
    command,
    'sendTabsList',
    sendTabsList,
    async (cmd, detail) => {
      await postEventViaBridge({
        type: 'tabs.list.error',
        request_id: cmd.request_id || null,
        error: detail,
        ts: Date.now()
      });
    }
  ),
  'tab.open.request': (command) => runBridgeHandler(
    command,
    'sendOpenTab',
    sendOpenTab,
    async (cmd, detail) => {
      await postEventViaBridge({
        type: 'tab.open.error',
        request_id: cmd?.request_id || null,
        error: clipText(detail || 'tab_open_failed'),
        ts: Date.now()
      });
    }
  ),
  'js.exec.request': (command) => runBridgeHandler(
    command,
    'sendJsExec',
    sendJsExec,
    async (cmd, detail) => {
      await postEventViaBridge({
        type: 'js.exec.error',
        request_id: cmd?.request_id || null,
        tab_id: Number.isInteger(cmd?.tab_id) ? cmd.tab_id : null,
        duration_ms: 0,
        error_code: 'js_exec_failed',
        error: clipText(detail || 'js_exec_failed'),
        ts: Date.now()
      });
    }
  ),
  'transfer.resume': (command) => runBridgeHandler(
    command,
    'handleTransferResume',
    handleTransferResume,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_resume_failed', detail)
  ),
  'transfer.ack': (command) => runBridgeHandler(
    command,
    'handleTransferAck',
    handleTransferAck,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_ack_failed', detail)
  ),
  'transfer.done.ack': (command) => runBridgeHandler(
    command,
    'handleTransferDoneAck',
    handleTransferDoneAck,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_done_ack_failed', detail)
  ),
  'transfer.nack': (command) => runBridgeHandler(
    command,
    'handleTransferNack',
    handleTransferNack,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_nack_failed', detail)
  ),
  'transfer.cancel': (command) => runBridgeHandler(
    command,
    'handleTransferCancel',
    handleTransferCancel,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_cancel_failed', detail)
  ),
  'transfer.reset': (command) => runBridgeHandler(
    command,
    'handleTransferReset',
    handleTransferReset,
    async (cmd, detail) => sendTransferError(cmd, 'transfer_reset_failed', detail)
  )
};

async function handleBleCommand(command) {
  debugLog('handleBleCommand', command);
  if (!command || typeof command.type !== 'string') {
    debugLog('handleBleCommand ignore non-command payload', command);
    return;
  }
  const handler = kBleCommandHandlers[command.type];
  if (!handler) return;
  await handler(command);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.command') return;
  if (!isTrustedBleCommandSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return true;
  }
  debugLog('runtime ble.command', msg.command);
  handleBleCommand(msg.command)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled?.addListener((details) => {
  debugLog('lifecycle onInstalled', details || null);
  void writeSwBreadcrumb('lifecycle_onInstalled', details || null);
});

chrome.runtime.onStartup?.addListener(() => {
  debugLog('lifecycle onStartup');
  void writeSwBreadcrumb('lifecycle_onStartup');
});

if (typeof self?.addEventListener === 'function') {
  self.addEventListener('activate', () => {
    debugLog('lifecycle activate');
    void writeSwBreadcrumb('lifecycle_activate');
  });
}

if (chrome.runtime?.onSuspend?.addListener) {
  chrome.runtime.onSuspend.addListener(() => {
    debugLog('lifecycle onSuspend');
    void writeSwBreadcrumb('lifecycle_onSuspend');
  });
}

if (chrome.runtime?.onSuspendCanceled?.addListener) {
  chrome.runtime.onSuspendCanceled.addListener(() => {
    debugLog('lifecycle onSuspendCanceled');
    void writeSwBreadcrumb('lifecycle_onSuspendCanceled');
  });
}

debugLog('boot', { instance_id: kSwInstanceId });
void writeSwBreadcrumb('boot', { instance_id: kSwInstanceId });
setInterval(() => {
  emitSwAliveHeartbeat();
}, kSwHeartbeatIntervalMs);

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
