import {
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postEvent,
  readBleTxSnapshot,
  setBleDebugLogger
} from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const forgetBtn = document.getElementById('forget');
const reconnectBtn = document.getElementById('reconnect');
const clearLogBtn = document.getElementById('clear-log');
const logEl = document.getElementById('log');
const kDebug = true;
const kHandshakeTimeoutMs = 6000;
const kHandshakeAttempts = 3;
const kPreferredDeviceStorageKey = 'blePreferredDeviceId';
const kMaxLogLines = 250;
let logLines = [];

function appendLog(line) {
  if (!logEl) return;
  logLines.push(line);
  if (logLines.length > kMaxLogLines) {
    logLines = logLines.slice(logLines.length - kMaxLogLines);
  }
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
  const rendered = args.map((part) => {
    if (typeof part === 'string') return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
  appendLog(`${new Date().toISOString()} ${rendered}`);
}

setBleDebugLogger((...args) => {
  const rendered = args.map((part) => {
    if (typeof part === 'string') return part;
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
  appendLog(`${new Date().toISOString()} [ble] ${rendered}`);
});

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function notifySw(status, detail = null) {
  chrome.runtime.sendMessage({ type: 'ble.bridge.status', status, detail }).catch(() => {});
}

async function loadPreferredDeviceId() {
  try {
    const stored = await chrome.storage.local.get(kPreferredDeviceStorageKey);
    return typeof stored?.[kPreferredDeviceStorageKey] === 'string'
      ? stored[kPreferredDeviceStorageKey]
      : null;
  } catch {
    return null;
  }
}

async function savePreferredDeviceId(deviceId) {
  if (!deviceId) return;
  try {
    await chrome.storage.local.set({ [kPreferredDeviceStorageKey]: deviceId });
  } catch {
    // Non-fatal.
  }
}

async function clearPreferredDeviceId() {
  try {
    await chrome.storage.local.remove(kPreferredDeviceStorageKey);
  } catch {
    // Non-fatal.
  }
}

function unwrapCommand(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (typeof frame.type === 'string') return frame;
  if (frame.ch === 'ctrl' && frame.msg && typeof frame.msg === 'object') return frame.msg;
  return null;
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

async function connectAndBind() {
  debugLog('connect click');
  notifySw('connect_click');
  setStatus('Connecting...');
  const state = { pendingHandshake: null };
  const preferredDeviceId = await loadPreferredDeviceId();
  debugLog('preferred device', preferredDeviceId);
  try {
    const ok = await connectBle({
      preferredDeviceId,
      requestOptions: {
        filters: [{ services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'], namePrefix: 'air-kvm' }],
        optionalServices: ['6e400101-b5a3-f393-e0a9-e50e24dccb01']
      },
      onCommand: async (command) => {
        const unwrapped = unwrapCommand(command);
        debugLog('rx command from BLE', { raw: command, unwrapped });
        if (!unwrapped) return;
        if (state.pendingHandshake && (unwrapped.type === 'state' || typeof unwrapped.ok === 'boolean')) {
          state.pendingHandshake();
        }
        if (typeof unwrapped.type !== 'string') return;
        try {
          await chrome.runtime.sendMessage({ type: 'ble.command', command: unwrapped });
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
    debugLog('connect success');
    debugLog('connected device', getConnectedDeviceInfo());
    let handshakeOk = false;
    for (let attempt = 1; attempt <= kHandshakeAttempts; attempt += 1) {
      const handshakePending = waitForControlHandshake(state);
      await postEvent({ type: 'state.request' }, { traceId: `bridge-handshake-${attempt}` });
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
      debugLog('handshake attempt timed out', { attempt });
    }
    if (!handshakeOk) {
      debugLog('connect invalid stream (no JSON control response)');
      disconnectBle();
      await clearPreferredDeviceId();
      notifySw('connect_invalid_stream');
      setStatus('Invalid stream (not AirKVM control)');
      return;
    }
    const info = getConnectedDeviceInfo();
    debugLog('connected device info', info);
    await savePreferredDeviceId(info.id);
    notifySw('connect_success');
    setStatus('Connected');
  } catch (err) {
    debugLog('connect error', String(err?.message || err));
    notifySw('connect_error', String(err?.message || err));
    setStatus(`Error: ${String(err?.message || err)}`);
  }
}

async function disconnectAndReport(detail = null) {
  disconnectBle();
  notifySw('disconnect', detail);
  setStatus('Disconnected');
}

connectBtn?.addEventListener('click', () => {
  connectAndBind();
});

disconnectBtn?.addEventListener('click', () => {
  debugLog('disconnect click');
  disconnectAndReport();
});

forgetBtn?.addEventListener('click', async () => {
  debugLog('forget click');
  await clearPreferredDeviceId();
  notifySw('forget_device');
  setStatus('Saved device cleared');
});

reconnectBtn?.addEventListener('click', async () => {
  debugLog('reconnect chooser click');
  await disconnectAndReport('reconnect_start');
  await clearPreferredDeviceId();
  await connectAndBind();
});

clearLogBtn?.addEventListener('click', () => {
  logLines = [];
  if (logEl) logEl.textContent = '';
});

notifySw('bridge_loaded');
debugLog('bridge_loaded');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ble.post' || msg.target !== 'ble-page') return;
  debugLog('ble.post from service worker', {
    traceId: msg.traceId || null,
    type: msg?.payload?.type,
    bytes: JSON.stringify(msg?.payload || {}).length
  });
  postEvent(msg.payload, { traceId: msg.traceId || null })
    .then((ok) => {
      debugLog('ble.post result', { traceId: msg.traceId || null, ok });
      sendResponse({ ok });
    })
    .catch((err) => {
      const error = String(err?.message || err);
      debugLog('ble.post error', { traceId: msg.traceId || null, error });
      sendResponse({ ok: false, error });
    });
  return true;
});
