// Service worker: MV3 background context. Receives firmware commands from the
// bridge page as { type:'hp.message' } and dispatches to browser automation
// handlers (tabs, DOM snapshot, js.exec, screenshot, window bounds). Sends
// results back to firmware via sendViaHalfPipe() → { type:'hp.send' } to bridge.
// Also manages the ble_bridge.html tab lifecycle and CDP debugger sessions.
import { resolveScreenshotConfig } from './screenshot_protocol.js';
const kBleBridgePagePath = 'ble_bridge.html';
const kDebugDefault = false;
const kDebugStorageKey = 'airkvmVerboseBridgeLog';
const kScreenshotCaptureTimeoutMs = 25000;
const kScreenshotStageTimeoutMs = 10000;
const kJsExecScriptMinChars = 1;
const kJsExecScriptMaxChars = 12000;
const kJsExecTimeoutMsMin = 50;
const kJsExecTimeoutMsMax = 2000;
const kJsExecTimeoutMsDefault = 750;
const kJsExecResultCharsMin = 64;
const kJsExecResultCharsMax = 700;
const kJsExecResultCharsDefault = 256;
const kJsExecErrorMaxChars = 300;
const kJsExecPostTimeoutHoldMs = 1000;

const kCdpProtocolVersion = '1.3';
const kDomSnapshotActionableLimitPerFrame = 50;
const kDomSnapshotMaxTransferBytes = 2 * 1024 * 1024;
let lastAutomationTabId = null;
let jsExecInFlight = false;
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

function makeDebuggerTarget(tabId) {
  return { tabId };
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, kCdpProtocolVersion, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'cdp_attach_failed'));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'cdp_detach_failed'));
        return;
      }
      resolve();
    });
  });
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message || `cdp_${method}_failed`));
        return;
      }
      resolve(result || {});
    });
  });
}

async function withCdpSession(tabId, run) {
  if (!chrome?.debugger?.attach || !chrome?.debugger?.sendCommand || !chrome?.debugger?.detach) {
    throw new Error('cdp_unavailable');
  }
  const target = makeDebuggerTarget(tabId);
  await attachDebugger(target);
  try {
    return await run({
      sendCommand: (method, params) => sendDebuggerCommand(target, method, params)
    });
  } finally {
    try {
      await detachDebugger(target);
    } catch (err) {
      debugLog('cdp detach failed', { tabId, detail: String(err?.message || err) });
    }
  }
}

function collectFrameIds(frameTreeNode, out = []) {
  const frameId = frameTreeNode?.frame?.id;
  if (typeof frameId === 'string' && frameId.length > 0) {
    out.push(frameId);
  }
  const children = Array.isArray(frameTreeNode?.childFrames) ? frameTreeNode.childFrames : [];
  for (const child of children) {
    collectFrameIds(child, out);
  }
  return out;
}

function buildFrameSummaryExpression(maxActionable) {
  return `(() => {
    const __airkvm_dom_summary_limit = ${maxActionable};
    const __airkvm_els = Array.from(
      document.querySelectorAll('a,button,input,select,textarea,[role="button"]')
    ).slice(0, __airkvm_dom_summary_limit);
    const __airkvm_focus = document.activeElement;
    const __airkvm_focusTag = __airkvm_focus?.tagName ? String(__airkvm_focus.tagName).toLowerCase() : null;
    const __airkvm_focusId = __airkvm_focus?.id ? String(__airkvm_focus.id) : null;
    return {
      __airkvm_dom_summary: true,
      url: String(location.href || ''),
      title: String(document.title || ''),
      focus: { tag: __airkvm_focusTag, id: __airkvm_focusId },
      actionable: __airkvm_els.map((el) => ({
        tag: el?.tagName ? String(el.tagName).toLowerCase() : null,
        id: el?.id ? String(el.id) : null,
        role: el?.getAttribute ? (el.getAttribute('role') || null) : null,
        type: typeof el?.type === 'string' ? el.type : null,
        text: String(el?.innerText || el?.value || '').trim().slice(0, 120)
      }))
    };
  })()`;
}

function buildJsExecExpression(script, maxResultChars) {
  const encodedScript = JSON.stringify(script);
  return `(() => {
    const __airkvm_script = ${encodedScript};
    const __airkvm_max_chars = ${maxResultChars};
    function __airkvm_value_type_of(value) {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      return typeof value;
    }
    function __airkvm_safe_serialize(value) {
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
    return (async () => {
      let compiled = null;
      try {
        compiled = new Function(__airkvm_script);
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
        let valueJson = __airkvm_safe_serialize(value);
        let truncated = false;
        if (valueJson.length > __airkvm_max_chars) {
          valueJson = valueJson.slice(0, __airkvm_max_chars);
          truncated = true;
        }
        return {
          ok: true,
          value_type: __airkvm_value_type_of(value),
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
    })();
  })()`;
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
  if (msg.type !== 'busy.changed') {
    debugLog('ignoring non-bridge content message', { type: msg.type });
    return;
  }
  debugLog('busy.changed from content', { busy: msg.busy, tabId: sender?.tab?.id ?? null });
  if (Number.isInteger(sender?.tab?.id)) {
    lastAutomationTabId = sender.tab.id;
  }

  // Translate busy.changed into a firmware state.set command.
  sendViaHalfPipe({ type: 'state.set', busy: Boolean(msg.busy) })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});

function makeRequestId() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
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

function decodeBase64ToBytes(text) {
  const raw = atob(String(text || ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

async function executeScriptViaCdp(tabId, script, maxResultChars) {
  return withCdpSession(tabId, async ({ sendCommand }) => {
    await sendCommand('Page.enable');
    const frameTree = await sendCommand('Page.getFrameTree');
    const mainFrameId = frameTree?.frameTree?.frame?.id || null;
    let contextId = null;
    if (typeof mainFrameId === 'string' && mainFrameId.length > 0) {
      try {
        const world = await sendCommand('Page.createIsolatedWorld', {
          frameId: mainFrameId,
          worldName: 'airkvm_js_exec'
        });
        contextId = Number.isInteger(world?.executionContextId) ? world.executionContextId : null;
      } catch {
        contextId = null;
      }
    }

    const evalResult = await sendCommand('Runtime.evaluate', {
      expression: buildJsExecExpression(script, maxResultChars),
      awaitPromise: true,
      returnByValue: true,
      ...(Number.isInteger(contextId) ? { contextId } : {})
    });
    if (evalResult?.exceptionDetails) {
      const detail = String(
        evalResult.exceptionDetails?.text
          || evalResult.result?.description
          || 'cdp_runtime_evaluate_failed'
      );
      return {
        ok: false,
        error_code: 'js_exec_runtime_error',
        error: detail
      };
    }
    if (evalResult?.result && Object.prototype.hasOwnProperty.call(evalResult.result, 'value')) {
      return evalResult.result.value;
    }
    return null;
  });
}

async function postJsExecError(requestId, tabId, startedAt, errorCode, message) {
  await sendViaHalfPipe({
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
    const script = typeof command?.script === 'string' ? command.script : '';
    if (!script) throw new Error('invalid_js_exec_request');
    const normalized = normalizeJsExecCommand({ ...command, script });
    requestId = normalized.requestId;
    resolvedTabId = normalized.tabId;
    const tab = await resolveTargetTab(normalized.tabId);
    if (!tab?.id) {
      throw new Error('active_tab_not_found');
    }
    resolvedTabId = tab.id;
    lastAutomationTabId = tab.id;
    const executionPromise = executeScriptViaCdp(tab.id, normalized.script, normalized.maxResultChars);
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
    await sendViaHalfPipe({
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

async function captureTabPng(config) {
  const tab = await resolveTargetTab(config.tabId || null);
  if (!tab?.id) {
    throw new Error('active_tab_not_found');
  }
  lastAutomationTabId = tab.id;
  const data = await withCdpSession(tab.id, async ({ sendCommand }) => {
    await sendCommand('Page.enable');
    const shot = await sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true
    });
    if (typeof shot?.data !== 'string' || shot.data.length === 0) {
      throw new Error('screenshot_capture_failed');
    }
    return shot.data;
  });
  const dataUrl = `data:image/png;base64,${data}`;
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
  lastAutomationTabId = tab.id;

  const frameSummaries = await withCdpSession(tab.id, async ({ sendCommand }) => {
    await sendCommand('Page.enable');
    const frameTreeResult = await sendCommand('Page.getFrameTree');
    const frameIds = collectFrameIds(frameTreeResult?.frameTree);
    const summaries = [];
    for (const frameId of frameIds) {
      try {
        const world = await sendCommand('Page.createIsolatedWorld', {
          frameId,
          worldName: 'airkvm_dom_snapshot'
        });
        const contextId = world?.executionContextId;
        if (!Number.isInteger(contextId)) {
          continue;
        }
        const evalResult = await sendCommand('Runtime.evaluate', {
          contextId,
          expression: buildFrameSummaryExpression(kDomSnapshotActionableLimitPerFrame),
          returnByValue: true,
          awaitPromise: true
        });
        if (evalResult?.exceptionDetails) {
          summaries.push({
            frame_id: frameId,
            error: String(evalResult.exceptionDetails?.text || 'cdp_frame_eval_failed')
          });
          continue;
        }
        const value = evalResult?.result?.value;
        if (value && typeof value === 'object' && value.__airkvm_dom_summary === true) {
          summaries.push({ frame_id: frameId, ...value });
        } else {
          summaries.push({
            frame_id: frameId,
            error: 'cdp_frame_eval_invalid_result'
          });
        }
      } catch (err) {
        summaries.push({
          frame_id: frameId,
          error: String(err?.message || err)
        });
      }
    }
    return summaries;
  });

  const primary = frameSummaries.find((entry) => !entry?.error) || null;
  const actionable = [];
  for (const frame of frameSummaries) {
    const items = Array.isArray(frame?.actionable) ? frame.actionable : [];
    for (const item of items) {
      actionable.push({
        frame_id: frame.frame_id || null,
        ...item
      });
    }
  }
  const normalizedSummary = {
    type: 'dom.summary',
    ts: Date.now(),
    url: primary?.url || tab.url || '',
    title: primary?.title || tab.title || '',
    focus: primary?.focus || { tag: null, id: null },
    actionable,
    frame_count: frameSummaries.length,
    frames: frameSummaries.map((frame) => ({
      frame_id: frame.frame_id || null,
      url: frame.url || null,
      title: frame.title || null,
      actionable_count: Array.isArray(frame.actionable) ? frame.actionable.length : 0,
      error: frame.error || null
    }))
  };
  debugLog('sendDomSnapshot got summary', { tabId: tab.id, title: normalizedSummary?.title ?? null });
  const snapshotPayload = {
    type: 'dom.snapshot',
    request_id: requestId,
    tabId: tab.id,
    ts: Date.now(),
    summary: normalizedSummary
  };
  const snapshotJson = JSON.stringify(snapshotPayload);
  const snapshotBytes = new TextEncoder().encode(snapshotJson);
  if (snapshotBytes.length === 0) {
    throw new Error('dom_snapshot_empty');
  }
  if (snapshotBytes.length > kDomSnapshotMaxTransferBytes) {
    throw new Error('dom_snapshot_too_large');
  }

  await sendViaHalfPipe(snapshotPayload);
}

async function sendScreenshot(command) {
  debugLog('sendScreenshot start', command);
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

  const comma = encoded.dataUrl.indexOf(',');
  if (comma === -1) throw new Error('screenshot_invalid_data_url');
  const header = encoded.dataUrl.slice(0, comma);
  const base64Data = encoded.dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(header);
  const mime = mimeMatch?.[1] || 'image/jpeg';

  await sendViaHalfPipe({
    type: 'screenshot.response',
    request_id: requestId,
    source,
    mime,
    data: base64Data,
    encoded_width: encoded.encodedWidth,
    encoded_height: encoded.encodedHeight,
    source_width: encoded.sourceWidth,
    source_height: encoded.sourceHeight,
    encoded_quality: encoded.encodedQuality,
    encode_attempts: encoded.attempts,
    ts: Date.now(),
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
  await sendViaHalfPipe({
    type: 'tabs.list',
    request_id: requestId,
    tabs: filtered,
    ts: Date.now()
  });
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
  await sendViaHalfPipe({
    type: 'tab.open',
    request_id: requestId,
    tab: normalizedTab,
    ts: Date.now()
  });
}

function normalizeWindowBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    return null;
  }
  const normalized = {};
  if (typeof bounds.windowState === 'string') normalized.window_state = bounds.windowState;
  if (typeof bounds.left === 'number' && Number.isFinite(bounds.left)) normalized.left = Math.round(bounds.left);
  if (typeof bounds.top === 'number' && Number.isFinite(bounds.top)) normalized.top = Math.round(bounds.top);
  if (typeof bounds.width === 'number' && Number.isFinite(bounds.width)) normalized.width = Math.round(bounds.width);
  if (typeof bounds.height === 'number' && Number.isFinite(bounds.height)) normalized.height = Math.round(bounds.height);
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function isMissingCdpMethodError(err, methodName) {
  const text = String(err?.message || err || '');
  if (text.includes(`'${methodName}' wasn't found`) || text.includes(`${methodName} wasn't found`)) {
    return true;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed?.code === -32601 && String(parsed?.message || '').includes(methodName);
  } catch {
    return false;
  }
}

async function getWindowBoundsViaWindowsApi(tab) {
  if (!chrome?.windows?.get || !Number.isInteger(tab?.windowId)) {
    throw new Error('window_bounds_unavailable');
  }
  const windowInfo = await chrome.windows.get(tab.windowId);
  return {
    window_id: Number.isInteger(windowInfo?.id) ? windowInfo.id : tab.windowId,
    bounds: normalizeWindowBounds({
      windowState: windowInfo?.state,
      left: windowInfo?.left,
      top: windowInfo?.top,
      width: windowInfo?.width,
      height: windowInfo?.height
    })
  };
}

async function sendWindowBounds(command) {
  const requestId = command?.request_id || makeRequestId();
  const preferredTabId = Number.isInteger(command?.tab_id) ? command.tab_id : null;
  const tab = await resolveTargetTab(preferredTabId);
  if (!tab?.id) {
    throw new Error('active_tab_not_found');
  }
  lastAutomationTabId = tab.id;
  let targetInfo = null;
  try {
    targetInfo = await withCdpSession(tab.id, async ({ sendCommand }) => {
      const result = await sendCommand('Browser.getWindowForTarget');
      return {
        window_id: Number.isInteger(result?.windowId) ? result.windowId : null,
        bounds: normalizeWindowBounds(result?.bounds || null)
      };
    });
  } catch (err) {
    if (!isMissingCdpMethodError(err, 'Browser.getWindowForTarget')) {
      throw err;
    }
    targetInfo = await getWindowBoundsViaWindowsApi(tab);
  }

  await sendViaHalfPipe({
    type: 'window.bounds',
    request_id: requestId,
    tab_id: tab.id,
    window_id: targetInfo?.window_id ?? null,
    bounds: targetInfo?.bounds ?? null,
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
      await sendViaHalfPipe({
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
      await sendViaHalfPipe({
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
      await sendViaHalfPipe({
        type: 'tabs.list.error',
        request_id: cmd.request_id || null,
        error: detail,
        ts: Date.now()
      });
    }
  ),
  'window.bounds.request': (command) => runBridgeHandler(
    command,
    'sendWindowBounds',
    sendWindowBounds,
    async (cmd, detail) => {
      await sendViaHalfPipe({
        type: 'window.bounds.error',
        request_id: cmd?.request_id || null,
        tab_id: Number.isInteger(cmd?.tab_id) ? cmd.tab_id : null,
        error: clipText(detail || 'window_bounds_failed'),
        ts: Date.now()
      });
    }
  ),
  'tab.open.request': (command) => runBridgeHandler(
    command,
    'sendOpenTab',
    sendOpenTab,
    async (cmd, detail) => {
      await sendViaHalfPipe({
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
      await sendViaHalfPipe({
        type: 'js.exec.error',
        request_id: cmd?.request_id || null,
        tab_id: Number.isInteger(cmd?.tab_id) ? cmd.tab_id : null,
        duration_ms: 0,
        error_code: 'js_exec_failed',
        error: clipText(detail || 'js_exec_failed'),
        ts: Date.now()
      });
    }
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

// Serialize all outbound HalfPipe sends so only one BLE CHUNK transaction is
// in-flight at a time. chrome.runtime.sendMessage to the bridge page is not
// re-entrant — a second call while the first is awaiting BLE ACKs will be
// dropped or time out.
let _sendQueue = Promise.resolve();
function sendViaHalfPipe(payload) {
  _sendQueue = _sendQueue.then(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'hp.send', target: 'ble-page', payload });
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  });
  return _sendQueue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hp.message') return;
  if (!isTrustedBleCommandSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return true;
  }
  handleBleCommand(msg.msg)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.runtime.onInstalled?.addListener((details) => {
  debugLog('lifecycle onInstalled', details || null);
});

chrome.runtime.onStartup?.addListener(() => {
  debugLog('lifecycle onStartup');
});

if (typeof self?.addEventListener === 'function') {
  self.addEventListener('activate', () => {
    debugLog('lifecycle activate');
  });
}

if (chrome.runtime?.onSuspend?.addListener) {
  chrome.runtime.onSuspend.addListener(() => {
    debugLog('lifecycle onSuspend');
  });
}

if (chrome.runtime?.onSuspendCanceled?.addListener) {
  chrome.runtime.onSuspendCanceled.addListener(() => {
    debugLog('lifecycle onSuspendCanceled');
  });
}

debugLog('boot', { instance_id: kSwInstanceId });

chrome.action.onClicked.addListener(async (tab) => {
  debugLog('action clicked', { tabId: tab?.id ?? null });
  if (isAutomationCandidateTab(tab)) {
    lastAutomationTabId = tab.id;
  }
  setBadge('...', '#5B6CFF');
  try {
    await ensureBleBridgePage();
    setBadge('TAB', '#9E9E9E');
    clearBadgeLater();
  } catch {
    setBadge('ERR', '#D93025');
    clearBadgeLater();
  }
});
