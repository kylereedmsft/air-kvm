import { connectBle, postEvent } from './bridge.js';

const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect');
const kDebug = true;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-bridge]', ...args);
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function notifySw(status, detail = null) {
  chrome.runtime.sendMessage({ type: 'ble.bridge.status', status, detail }).catch(() => {});
}

function unwrapCommand(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (typeof frame.type === 'string') return frame;
  if (frame.ch === 'ctrl' && frame.msg && typeof frame.msg === 'object') return frame.msg;
  return null;
}

async function connectAndBind() {
  debugLog('connect click');
  notifySw('connect_click');
  setStatus('Connecting...');
  try {
    const ok = await connectBle({
      onCommand: async (command) => {
        const unwrapped = unwrapCommand(command);
        debugLog('rx command from BLE', { raw: command, unwrapped });
        if (!unwrapped || typeof unwrapped.type !== 'string') return;
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
    notifySw('connect_success');
    setStatus('Connected');
  } catch (err) {
    debugLog('connect error', String(err?.message || err));
    notifySw('connect_error', String(err?.message || err));
    setStatus(`Error: ${String(err?.message || err)}`);
  }
}

connectBtn?.addEventListener('click', () => {
  connectAndBind();
});

notifySw('bridge_loaded');

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
