// Content script: injected into every browser tab. Tracks and reports busy state
// (DOM mutation activity) to the service worker, which translates it into a
// firmware state.set command so the controller knows when the page is settling.
import { busyEvent } from './messages.js';

let busy = false;
let pendingTimer = null;

function notify(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // Service worker might be sleeping; ignore in POC.
  });
}

function setBusy(nextBusy) {
  if (busy === nextBusy) return;
  busy = nextBusy;
  notify(busyEvent(busy));
}

function scheduleIdle() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => setBusy(false), 400);
}

const observer = new MutationObserver(() => {
  setBusy(true);
  scheduleIdle();
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: false
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'request.busy') {
    sendResponse(busyEvent(busy));
    return true;
  }
  return false;
});
