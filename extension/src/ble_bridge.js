import {
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postBinary,
  readBleTxSnapshot,
  setBleVerboseDebug,
  setBleDebugLogger
} from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const forgetBtn = document.getElementById('forget');
const reconnectBtn = document.getElementById('reconnect');
const clearLogBtn = document.getElementById('clear-log');
const toggleAutoscrollBtn = document.getElementById('toggle-autoscroll');
const toggleVerboseBtn = document.getElementById('toggle-verbose');
const logEl = document.getElementById('log');
const kDebug = true;
const kVerbosePrefStorageKey = 'airkvmVerboseBridgeLog';
const kHandshakeTimeoutMs = 6000;
const kHandshakeAttempts = 3;
const kPreferredDeviceStorageKey = 'blePreferredDeviceId';
const kPreferredDeviceNameStorageKey = 'blePreferredDeviceName';
const kMaxLogLines = 250;
const kHealthPingIntervalMs = 6000;
const kHealthPingTimeoutMs = 4000;
const kHealthMaxMisses = 4;
const kHealthSuspendMsDom = 15000;
const kHealthSuspendMsScreenshot = 45000;
let logLines = [];
let connectInFlight = false;
let disconnectInFlight = false;
let healthTimer = null;
let healthState = {
  misses: 0,
  pendingPingResolve: null,
  suspendedUntil: 0,
  lastActivityAt: 0
};
let lastSwInstanceId = null;
let lastCommandContext = null;
let autoScrollEnabled = true;
let verboseLoggingEnabled = false;
let connectState = { pendingHandshake: null };

function loadVerboseLoggingPref() {
  try {
    return globalThis.localStorage?.getItem(kVerbosePrefStorageKey) === '1';
  } catch {
    return false;
  }
}

function persistVerboseLoggingPref() {
  try {
    globalThis.localStorage?.setItem(kVerbosePrefStorageKey, verboseLoggingEnabled ? '1' : '0');
  } catch {
    // Non-fatal.
  }
}

function refreshAutoscrollButton() {
  if (!toggleAutoscrollBtn) return;
  toggleAutoscrollBtn.textContent = `Auto-scroll: ${autoScrollEnabled ? 'ON' : 'OFF'}`;
  toggleAutoscrollBtn.setAttribute('aria-pressed', autoScrollEnabled ? 'true' : 'false');
}

function refreshVerboseButton() {
  if (!toggleVerboseBtn) return;
  toggleVerboseBtn.textContent = `Verbose: ${verboseLoggingEnabled ? 'ON' : 'OFF'}`;
  toggleVerboseBtn.setAttribute('aria-pressed', verboseLoggingEnabled ? 'true' : 'false');
}

function appendLog(line) {
  if (!logEl) return;
  const kAutoScrollThresholdPx = 16;
  const wasNearBottom =
    logEl.scrollTop + logEl.clientHeight >= (logEl.scrollHeight - kAutoScrollThresholdPx);
  logLines.push(line);
  const row = document.createElement('div');
  row.className = 'log-row';
  row.textContent = line;
  logEl.appendChild(row);

  if (logLines.length > kMaxLogLines) {
    const overflow = logLines.length - kMaxLogLines;
    logLines = logLines.slice(overflow);
    for (let i = 0; i < overflow; i += 1) {
      if (logEl.firstChild) {
        logEl.removeChild(logEl.firstChild);
      }
    }
  }
  if (autoScrollEnabled && wasNearBottom) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function renderLogParts(parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
}

function appendStampedLog(prefix, parts) {
  const rendered = renderLogParts(parts);
  const line = prefix ? `${prefix} ${rendered}` : rendered;
  appendLog(`${new Date().toISOString()} ${line}`);
}

function debugLog(...args) {
  if (!verboseLoggingEnabled) return;
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
  appendStampedLog('', args);
}

function infoLog(...args) {
  appendStampedLog('', args);
}

function summarizeCommand(frame) {
  if (!frame || typeof frame !== 'object') return { type: 'unknown' };
  const inferredType = typeof frame.type === 'string'
    ? frame.type
    : (typeof frame.ok === 'boolean' ? 'ack' : 'unknown');
  return {
    type: inferredType,
    request_id: typeof frame.request_id === 'string' ? frame.request_id : undefined,
    transfer_id: typeof frame.transfer_id === 'string' ? frame.transfer_id : undefined,
    seq: Number.isInteger(frame.seq) ? frame.seq : undefined,
    from_seq: Number.isInteger(frame.from_seq) ? frame.from_seq : undefined,
    highest_contiguous_seq: Number.isInteger(frame.highest_contiguous_seq) ? frame.highest_contiguous_seq : undefined,
    ok: typeof frame.ok === 'boolean' ? frame.ok : undefined,
    error: typeof frame.error === 'string' ? frame.error : undefined
  };
}

function isVerboseOnlyCommand(frame) {
  if (!frame || typeof frame !== 'object') return true;
  if (typeof frame.type === 'string') {
    return frame.type === 'transfer.ack';
  }
  // Plain transport ACK frame like {"ok":true}
  if (typeof frame.ok === 'boolean') return true;
  return false;
}

function commandLog(direction, frame) {
  lastCommandContext = {
    direction,
    type: typeof frame?.type === 'string' ? frame.type : null,
    request_id: typeof frame?.request_id === 'string' ? frame.request_id : null,
    transfer_id: typeof frame?.transfer_id === 'string' ? frame.transfer_id : null,
    ts: Date.now()
  };
  if (!verboseLoggingEnabled && direction === 'SW->BLE') return;
  if (!verboseLoggingEnabled && isVerboseOnlyCommand(frame)) return;
  infoLog(`[cmd] ${direction}`, summarizeCommand(frame));
}

setBleDebugLogger((...args) => {
  if (!verboseLoggingEnabled) return;
  appendStampedLog('[ble]', args);
});

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setControlsDisabled(disabled) {
  if (connectBtn) connectBtn.disabled = disabled;
  if (reconnectBtn) reconnectBtn.disabled = disabled;
}

function stopHealthWatchdog() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (healthState.pendingPingResolve) {
    healthState.pendingPingResolve(false);
    healthState.pendingPingResolve = null;
  }
  healthState.misses = 0;
}

async function markDisconnected(reason) {
  if (disconnectInFlight) return;
  disconnectInFlight = true;
  const connectedInfo = getConnectedDeviceInfo();
  infoLog('[telemetry]', {
    evt: 'ble.disconnect.snapshot',
    reason: reason || null,
    gatt_connected: Boolean(connectedInfo.connected),
    health_misses: Number.isInteger(healthState.misses) ? healthState.misses : 0,
    last_activity_at: healthState.lastActivityAt || null,
    last_command_context: lastCommandContext
  });
  stopHealthWatchdog();
  disconnectBle();
  notifySw('disconnect', reason || null);
  setStatus(reason ? `Disconnected (${reason})` : 'Disconnected');
  disconnectInFlight = false;
}

function waitForHealthAck() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (healthState.pendingPingResolve) {
        healthState.pendingPingResolve = null;
      }
      resolve(false);
    }, kHealthPingTimeoutMs);
    healthState.pendingPingResolve = (ok) => {
      clearTimeout(timer);
      healthState.pendingPingResolve = null;
      resolve(Boolean(ok));
    };
  });
}

function markBridgeActivity(reason = 'activity') {
  healthState.lastActivityAt = Date.now();
  if (healthState.pendingPingResolve) {
    healthState.pendingPingResolve(true);
  }
  if (verboseLoggingEnabled) {
    debugLog('health activity', { reason });
  }
}

function noteControlFrameForHealth(unwrapped) {
  if (!unwrapped) return;
  markBridgeActivity(unwrapped.type || 'ctrl_frame');
  if (unwrapped.type === 'dom.snapshot.request') {
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthSuspendMsDom);
  } else if (unwrapped.type === 'screenshot.request') {
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthSuspendMsScreenshot);
  } else if (typeof unwrapped.type === 'string' && unwrapped.type.startsWith('transfer.')) {
    // Active transfer frames are proof-of-life; avoid watchdog false positives.
    healthState.suspendedUntil = Math.max(healthState.suspendedUntil, Date.now() + kHealthPingIntervalMs);
  }
  if (!healthState.pendingPingResolve) return;
  if (unwrapped.type === 'state' || typeof unwrapped.ok === 'boolean') {
    healthState.pendingPingResolve(true);
  }
}

function startHealthWatchdog() {
  stopHealthWatchdog();
  healthTimer = setInterval(async () => {
    if (Date.now() < healthState.suspendedUntil) {
      return;
    }
    if (Date.now() - healthState.lastActivityAt < kHealthPingIntervalMs * 2) {
      healthState.misses = 0;
      return;
    }
    const info = getConnectedDeviceInfo();
    if (!info.connected) {
      debugLog('health disconnected at gatt layer');
      await markDisconnected('health:gatt_disconnected');
      return;
    }
    const ackWait = waitForHealthAck();
    const posted = await sendViaHalfPipe({ type: 'state.request' });
    if (!posted) {
      healthState.misses += 1;
      debugLog('health ping send failed', { misses: healthState.misses });
    } else {
      const ok = await ackWait;
      if (ok) {
        healthState.misses = 0;
      } else {
        healthState.misses += 1;
        debugLog('health ping timeout', { misses: healthState.misses });
      }
    }

    if (healthState.misses >= kHealthMaxMisses) {
      debugLog('health watchdog disconnecting', { misses: healthState.misses });
      await markDisconnected('health:timeout');
    }
  }, kHealthPingIntervalMs);
}

function notifySw(status, detail = null) {
  chrome.runtime.sendMessage({ type: 'ble.bridge.status', status, detail }).catch(() => {});
}

function loadPreferredDeviceLocalFallback() {
  try {
    const id = globalThis.localStorage?.getItem(kPreferredDeviceStorageKey) || null;
    const name = globalThis.localStorage?.getItem(kPreferredDeviceNameStorageKey) || null;
    return { id, name };
  } catch {
    return { id: null, name: null };
  }
}

function savePreferredDeviceLocalFallback(id, name) {
  try {
    if (id) globalThis.localStorage?.setItem(kPreferredDeviceStorageKey, id);
    if (name) globalThis.localStorage?.setItem(kPreferredDeviceNameStorageKey, name);
  } catch {
    // Non-fatal.
  }
}

function clearPreferredDeviceLocalFallback() {
  try {
    globalThis.localStorage?.removeItem(kPreferredDeviceStorageKey);
    globalThis.localStorage?.removeItem(kPreferredDeviceNameStorageKey);
  } catch {
    // Non-fatal.
  }
}

async function loadPreferredDevice() {
  try {
    const stored = await chrome.storage.local.get(kPreferredDeviceStorageKey);
    const storedName = await chrome.storage.local.get(kPreferredDeviceNameStorageKey);
    const id = typeof stored?.[kPreferredDeviceStorageKey] === 'string'
      ? stored[kPreferredDeviceStorageKey]
      : null;
    const name = typeof storedName?.[kPreferredDeviceNameStorageKey] === 'string'
      ? storedName[kPreferredDeviceNameStorageKey]
      : null;
    if (id || name) {
      debugLog('preferred device from chrome.storage', { id, name });
      return { id, name };
    }
    const fallback = loadPreferredDeviceLocalFallback();
    debugLog('preferred device from localStorage fallback', fallback);
    return fallback;
  } catch {
    const fallback = loadPreferredDeviceLocalFallback();
    debugLog('preferred device fallback after storage error', fallback);
    return fallback;
  }
}

async function savePreferredDevice(deviceId, deviceName) {
  if (!deviceId && !deviceName) return;
  debugLog('saving preferred device', { deviceId: deviceId || null, deviceName: deviceName || null });
  try {
    const payload = {};
    if (deviceId) payload[kPreferredDeviceStorageKey] = deviceId;
    if (deviceName) payload[kPreferredDeviceNameStorageKey] = deviceName;
    await chrome.storage.local.set(payload);
  } catch {
    // Non-fatal.
  }
  savePreferredDeviceLocalFallback(deviceId, deviceName);
}

async function clearPreferredDeviceId() {
  debugLog('clearing preferred device');
  try {
    await chrome.storage.local.remove([kPreferredDeviceStorageKey, kPreferredDeviceNameStorageKey]);
  } catch {
    // Non-fatal.
  }
  clearPreferredDeviceLocalFallback();
}

async function sendViaHalfPipe(payload) {
  return chrome.runtime.sendMessage({
    type: 'ble.command',
    command: { type: 'halfpipe.send', payload }
  });
}


function waitForControlHandshake(state) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingHandshake = null;
      resolve(false);
    }, kHandshakeTimeoutMs);
    state.pendingHandshake = () => {
      clearTimeout(timer);
      state.pendingHandshake = null;
      resolve(true);
    };
  });
}

async function connectAndBind(options = {}) {
  const allowChooserFallback = options.allowChooserFallback !== false;
  const trigger = options.trigger || 'manual';
  if (connectInFlight) {
    infoLog('connect ignored: already in progress');
    return;
  }
  connectInFlight = true;
  setControlsDisabled(true);
  infoLog('connect start', { trigger, allowChooserFallback });
  notifySw(trigger === 'auto' ? 'connect_auto_start' : 'connect_click');
  setStatus(trigger === 'auto' ? 'Auto-connecting...' : 'Connecting...');
  connectState.pendingHandshake = null;
  const state = connectState;
  const preferred = await loadPreferredDevice();
  if (trigger === 'auto' && typeof globalThis.navigator?.bluetooth?.getDevices === 'function') {
    try {
      const known = await globalThis.navigator.bluetooth.getDevices();
      infoLog('auto-connect known devices', known.map((d) => ({ id: d?.id || null, name: d?.name || null })));
    } catch (err) {
      infoLog('auto-connect known devices error', String(err?.message || err));
    }
  }
  debugLog('preferred device', preferred);
  try {
    const ok = await connectBle({
      preferredDeviceId: preferred.id,
      preferredDeviceName: preferred.name,
      allowChooserFallback,
      onDisconnect: () => {
      infoLog('gattserverdisconnected');
      void markDisconnected('gatt_disconnected');
    },
      requestOptions: {
        filters: [
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'], name: 'air-kvm-ctrl-cb01' },
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'], name: 'air-kvm-poc' },
          { services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'] }
        ],
        optionalServices: ['6e400101-b5a3-f393-e0a9-e50e24dccb01']
      },
      onCommand: async (command) => {
        debugLog('rx command from BLE', { raw: command });
        try {
          await chrome.runtime.sendMessage({ type: 'ble.command', command });
          debugLog('forwarded ble.command to service worker');
        } catch {
          debugLog('failed to forward ble.command');
          // Background may be unavailable transiently.
        }
      }
    });
    if (!ok) {
      debugLog('connect unavailable in context');
      notifySw('connect_unavailable');
      setStatus('Web Bluetooth unavailable in this context');
      return;
    }
    infoLog('connect success');
    infoLog('connected device', getConnectedDeviceInfo());
    let handshakeOk = false;
    for (let attempt = 1; attempt <= kHandshakeAttempts; attempt += 1) {
      const handshakePending = waitForControlHandshake(state);
      await sendViaHalfPipe({ type: 'state.request' });
      const okAttempt = await handshakePending;
      if (okAttempt) {
        handshakeOk = true;
        break;
      }
      try {
        const snapshot = await readBleTxSnapshot();
        debugLog('handshake snapshot', { attempt, snapshot });
      } catch (err) {
        debugLog('handshake snapshot failed', { attempt, error: String(err?.message || err) });
      }
      infoLog('handshake attempt timed out', { attempt });
    }
    if (!handshakeOk) {
      infoLog('connect invalid stream (no JSON control response)');
      disconnectBle();
      await clearPreferredDeviceId();
      notifySw('connect_invalid_stream');
      setStatus('Invalid stream (not AirKVM control)');
      return;
    }
    const info = getConnectedDeviceInfo();
    infoLog('connected device info', info);
    await savePreferredDevice(info.id, info.name);
    notifySw('connect_success');
    setStatus('Connected');
    startHealthWatchdog();
  } catch (err) {
    const msg = String(err?.message || err);
    infoLog('connect error', msg);
    if (trigger === 'auto' && (msg === 'preferred_device_not_found' || msg === 'preferred_device_not_set')) {
      notifySw('connect_auto_no_saved_match', msg);
      setStatus('Saved device not found. Click Connect to choose.');
      return;
    }
    notifySw('connect_error', msg);
    setStatus(`Error: ${msg}`);
  } finally {
    connectInFlight = false;
    setControlsDisabled(false);
  }
}

async function disconnectAndReport(detail = null) {
  await markDisconnected(detail);
}

connectBtn?.addEventListener('click', () => {
  connectAndBind({ allowChooserFallback: true, trigger: 'manual' });
});

disconnectBtn?.addEventListener('click', () => {
  infoLog('disconnect click');
  disconnectAndReport();
});

forgetBtn?.addEventListener('click', async () => {
  infoLog('forget click');
  await clearPreferredDeviceId();
  notifySw('forget_device');
  setStatus('Saved device cleared');
});

reconnectBtn?.addEventListener('click', async () => {
  infoLog('reconnect chooser click');
  await disconnectAndReport('reconnect_start');
  await clearPreferredDeviceId();
  await connectAndBind({ allowChooserFallback: true, trigger: 'manual' });
});

clearLogBtn?.addEventListener('click', () => {
  logLines = [];
  if (logEl) logEl.replaceChildren();
});

toggleAutoscrollBtn?.addEventListener('click', () => {
  autoScrollEnabled = !autoScrollEnabled;
  refreshAutoscrollButton();
});

toggleVerboseBtn?.addEventListener('click', async () => {
  verboseLoggingEnabled = !verboseLoggingEnabled;
  setBleVerboseDebug(verboseLoggingEnabled);
  persistVerboseLoggingPref();
  refreshVerboseButton();
  infoLog('verbose logging', { enabled: verboseLoggingEnabled });
  try {
    await chrome.runtime.sendMessage({
      type: 'airkvm.debug.set',
      verbose: verboseLoggingEnabled
    });
  } catch {
    // Non-fatal.
  }
});

verboseLoggingEnabled = loadVerboseLoggingPref();
setBleVerboseDebug(verboseLoggingEnabled);
notifySw('bridge_loaded');
infoLog('bridge_loaded');
refreshAutoscrollButton();
refreshVerboseButton();


chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ble.sw.alive' && msg.target === 'ble-page') {
    const instanceId = msg.instance_id || null;
    if (instanceId && lastSwInstanceId && instanceId !== lastSwInstanceId) {
      debugLog('sw instance changed', {
        previous: lastSwInstanceId,
        current: instanceId
      });
    }
    if (instanceId) {
      lastSwInstanceId = instanceId;
    }
    debugLog('sw alive', {
      instance_id: instanceId,
      active_transfer_ids: Array.isArray(msg.active_transfer_ids) ? msg.active_transfer_ids : [],
      ts: msg.ts || null
    });
    markBridgeActivity('sw_alive');
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'desktop.capture.request' && msg.target === 'ble-page') {
    debugLog('desktop.capture.request');
    captureDesktopDataUrl({
      desktopDelayMs: Number.isInteger(msg.desktop_delay_ms) ? msg.desktop_delay_ms : null
    })
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === 'ble.control') {
    const command = msg.command;
    commandLog('BLE->SW (ctrl)', command);
    noteControlFrameForHealth(command);
    if (connectState.pendingHandshake && (command?.type === 'state' || command?.type === 'boot' || typeof command?.ok === 'boolean')) {
      connectState.pendingHandshake();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (!msg || msg.target !== 'ble-page') return;
  if (msg.type === 'ble.postBinary') {
    const bytes = Array.isArray(msg.bytes) ? Uint8Array.from(msg.bytes) : null;
    debugLog('ble.postBinary from service worker', {
      traceId: msg.traceId || null,
      bytes: bytes?.length || 0
    });
    markBridgeActivity('sw_post_binary');
    postBinary(bytes, { traceId: msg.traceId || null })
      .then((ok) => {
        debugLog('ble.postBinary result', { traceId: msg.traceId || null, ok });
        sendResponse({ ok });
      })
      .catch((err) => {
        const error = String(err?.message || err);
        debugLog('ble.postBinary error', { traceId: msg.traceId || null, error });
        sendResponse({ ok: false, error });
      });
    return true;
  }
});

async function captureDesktopDataUrl(options = {}) {
  const delayMs = Number.isInteger(options.desktopDelayMs)
    ? Math.max(0, Math.min(5000, options.desktopDelayMs))
    : 0;
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

  const stream = await getUserMediaCompat({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId
      }
    }
  });

  try {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error('desktop_capture_no_track');
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('desktop_capture_canvas_unavailable');
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

function getUserMediaCompat(constraints) {
  const modern = globalThis.navigator?.mediaDevices?.getUserMedia;
  if (typeof modern === 'function') {
    return modern.call(globalThis.navigator.mediaDevices, constraints);
  }
  const legacy = globalThis.navigator?.getUserMedia
    || globalThis.navigator?.webkitGetUserMedia
    || globalThis.navigator?.mozGetUserMedia;
  if (typeof legacy !== 'function') {
    throw new Error('desktop_capture_media_unavailable');
  }
  return new Promise((resolve, reject) => {
    legacy.call(globalThis.navigator, constraints, resolve, reject);
  });
}
