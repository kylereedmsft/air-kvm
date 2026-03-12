import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAckFrame,
  encodeChunkFrame,
  decodeFrame,
  kV2MaxPayload,
  makeV2TransferId,
} from '../src/binary_frame.js';

const kTrustedSender = {
  id: 'test',
  url: 'chrome-extension://test/ble_bridge.html'
};

function makeHarness() {
  const postedPayloads = [];
  const postedBinary = [];
  const runtimeListeners = [];
  const cdpCommandCalls = [];
  const cdpAttachCalls = [];
  const cdpDetachCalls = [];
  const createTabCalls = [];
  const tabCaptureCalls = [];
  const desktopCaptureCalls = [];
  let jsExecEvalImpl = async () => ({ ok: true, value_type: 'number', value_json: '1', truncated: false });
  let domSummaryEvalImpl = async () => ({
    __airkvm_dom_summary: true,
    url: 'https://example.com',
    title: 'Example Title',
    focus: { tag: null, id: null },
    actionable: []
  });
  let cdpCapturePngBase64 = 'QUJDRA==';
  let createTabImpl = async ({ url, active }) => ({
    id: 44,
    windowId: 1,
    active: Boolean(active),
    title: 'New Tab',
    url
  });
  let blePostOk = true;
  let blePostBinaryOk = true;
  let cdpWindowMethodMissing = false;
  let autoAckStreamFrames = true;
  let bleCommandListenerRef = null;
  const chunkBuffers = {};
  let getWindowImpl = async (windowId) => ({
    id: windowId,
    left: 130,
    top: 70,
    width: 1200,
    height: 860,
    state: 'normal'
  });

  globalThis.self = { addEventListener: () => {} };
  globalThis.setInterval = () => 0;
  globalThis.fetch = async () => ({
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  });
  globalThis.createImageBitmap = async () => ({ width: 64, height: 48 });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    getContext(type) {
      if (type !== '2d') return null;
      return {
        drawImage: () => {}
      };
    }

    async convertToBlob() {
      return new Blob([new Uint8Array([65, 66, 67, 68, 69])], { type: 'image/jpeg' });
    }
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {}
      },
      session: {
        set: async () => {},
        get: async () => ({})
      }
    },
    runtime: {
      id: 'test',
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (msg) => {
        if (msg?.type === 'ble.post') {
          postedPayloads.push(msg.payload);
          return { ok: blePostOk };
        }
        if (msg?.type === 'ble.postBinary') {
          postedBinary.push(msg.bytes);
          if (blePostBinaryOk && autoAckStreamFrames && bleCommandListenerRef) {
            const rawBytes = Uint8Array.from(msg.bytes || []);
            if (rawBytes.length >= 12 && rawBytes[0] === 0x41 && rawBytes[1] === 0x4B) {
              const decoded = decodeFrame(rawBytes);
              if (decoded && decoded.type === 1) { // CHUNK
                const ackFrame = encodeAckFrame({ transferId: decoded.transferId, seq: decoded.seq });
                const ref = bleCommandListenerRef;
                // Store chunk for reassembly
                const key = decoded.transferId;
                if (!chunkBuffers[key]) chunkBuffers[key] = [];
                chunkBuffers[key].push(decoded.payload);
                // If last chunk (payload < kV2MaxPayload), reassemble and push to postedPayloads
                if (decoded.payload.length < kV2MaxPayload) {
                  const total = chunkBuffers[key].reduce((s, c) => s + c.length, 0);
                  const assembled = new Uint8Array(total);
                  let off = 0;
                  for (const c of chunkBuffers[key]) { assembled.set(c, off); off += c.length; }
                  delete chunkBuffers[key];
                  try {
                    const parsed = JSON.parse(new TextDecoder().decode(assembled));
                    postedPayloads.push(parsed);
                  } catch { /* ignore parse error */ }
                }
                // Send ACK back via __ble_raw_bytes
                setTimeout(() => {
                  ref(
                    { type: 'ble.command', command: { type: '__ble_raw_bytes', bytes: Array.from(ackFrame) } },
                    kTrustedSender,
                    () => {}
                  );
                }, 0);
              }
            }
          }
          return { ok: blePostBinaryOk };
        }
        if (msg?.type === 'desktop.capture.request') {
          desktopCaptureCalls.push(msg);
          return {
            ok: true,
            dataUrl: 'data:image/png;base64,QUJDRA=='
          };
        }
        return { ok: true };
      },
      onMessage: {
        addListener: (fn) => runtimeListeners.push(fn)
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onSuspend: { addListener: () => {} },
      onSuspendCanceled: { addListener: () => {} }
    },
    tabs: {
      get: async (id) => ({ id, active: true, windowId: 1, url: 'https://example.com' }),
      query: async () => [{ id: 9, active: true, windowId: 1, url: 'https://example.com' }],
      update: async () => ({}),
      captureVisibleTab: async (windowId, opts) => {
        tabCaptureCalls.push({ windowId, opts });
        return 'data:image/png;base64,QUJDRA==';
      },
      sendMessage: async () => ({ type: 'dom.summary', title: 'Example Title', actionable: [] }),
      create: async (opts) => {
        createTabCalls.push(opts);
        return createTabImpl(opts);
      }
    },
    windows: {
      get: async (windowId) => getWindowImpl(windowId)
    },
    debugger: {
      attach: (_target, _version, cb) => {
        cdpAttachCalls.push(_target);
        cb();
      },
      detach: (_target, cb) => {
        cdpDetachCalls.push(_target);
        cb();
      },
      sendCommand: async (_target, method, params, cb) => {
        cdpCommandCalls.push({ target: _target, method, params: params || {} });
        if (method === 'Page.enable') {
          cb({});
          return;
        }
        if (method === 'Page.getFrameTree') {
          cb({
            frameTree: {
              frame: { id: 'frame-main' }
            }
          });
          return;
        }
        if (method === 'Page.createIsolatedWorld') {
          cb({ executionContextId: 7 });
          return;
        }
        if (method === 'Runtime.evaluate') {
          if (String(params?.expression || '').includes('__airkvm_dom_summary_limit')) {
            const value = await domSummaryEvalImpl({ target: _target, method, params });
            cb({ result: { value } });
            return;
          }
          const value = await jsExecEvalImpl({ target: _target, method, params });
          cb({ result: { value } });
          return;
        }
        if (method === 'Page.captureScreenshot') {
          tabCaptureCalls.push({ target: _target, method, params: params || {} });
          cb({ data: cdpCapturePngBase64 });
          return;
        }
        if (method === 'Browser.getWindowForTarget') {
          if (cdpWindowMethodMissing) {
            const methodMissingMessage = JSON.stringify({
              code: -32601,
              message: '\'Browser.getWindowForTarget\' wasn\'t found'
            });
            globalThis.chrome.runtime.lastError = {
              message: methodMissingMessage
            };
            cb(undefined);
            globalThis.chrome.runtime.lastError = null;
            return;
          }
          cb({
            windowId: 1,
            bounds: {
              left: 120,
              top: 60,
              width: 1280,
              height: 900,
              windowState: 'normal'
            }
          });
          return;
        }
        cb({});
      },
      onEvent: { addListener: () => {}, removeListener: () => {} },
      onDetach: { addListener: () => {}, removeListener: () => {} }
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      onClicked: { addListener: () => {} }
    }
  };

  return {
    postedPayloads,
    postedBinary,
    runtimeListeners,
    cdpCommandCalls,
    cdpAttachCalls,
    cdpDetachCalls,
    createTabCalls,
    tabCaptureCalls,
    desktopCaptureCalls,
    setJsExecEvalImpl: (impl) => {
      jsExecEvalImpl = impl;
    },
    setDomSummaryEvalImpl: (impl) => {
      domSummaryEvalImpl = impl;
    },
    setCdpCapturePngBase64: (value) => {
      cdpCapturePngBase64 = value;
    },
    setCreateTabImpl: (impl) => {
      createTabImpl = impl;
    },
    setBlePostOk: (ok) => {
      blePostOk = ok;
    },
    setBlePostBinaryOk: (ok) => {
      blePostBinaryOk = ok;
    },
    setCdpWindowMethodMissing: (missing) => {
      cdpWindowMethodMissing = missing;
    },
    setGetWindowImpl: (impl) => {
      getWindowImpl = impl;
    },
    setBleCommandListener: (listener) => {
      bleCommandListenerRef = listener;
    },
    setAutoAckStreamFrames: (v) => {
      autoAckStreamFrames = v;
    }
  };
}

async function importServiceWorkerFresh() {
  return import(`../src/service_worker.js?t=${Date.now()}-${Math.random()}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(checkFn, { timeoutMs = 1500, intervalMs = 10 } = {}) {
  const start = Date.now();
  while (true) {
    const value = await checkFn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error('wait_timeout');
    }
    await sleep(intervalMs);
  }
}

function parseTransferChunkFrame(raw) {
  const bytes = Uint8Array.from(raw || []);
  if (bytes.length < 12) return null;
  const decoded = decodeFrame(bytes);
  if (!decoded) return null;
  return {
    magic0: bytes[0],
    magic1: bytes[1],
    frameType: decoded.type,
    transferId: decoded.transferId,
    seq: decoded.seq,
    payloadLength: decoded.payload?.length || 0,
    totalLength: bytes.length
  };
}

async function callBleCommand(listener, command, sender = kTrustedSender) {
  return new Promise((resolve) => {
    let returned;
    returned = listener({ type: 'ble.command', command }, sender, (msg) => {
      resolve({ returned, response: msg });
    });
    if (returned !== true) {
      resolve({ returned, response: null });
    }
  });
}

function findBleCommandListener(runtimeListeners, harness = null) {
  const listener = runtimeListeners.find((candidate) => {
    let called = false;
    const out = candidate({ type: 'ble.command', command: { type: 'unknown' } }, kTrustedSender, () => {
      called = true;
    });
    return out === true || called;
  });
  assert.equal(typeof listener, 'function');
  if (harness && typeof harness.setBleCommandListener === 'function') {
    harness.setBleCommandListener(listener);
  }
  return listener;
}

// Send a JSON command to the service worker as v2 binary CHUNK frames via __ble_raw_bytes.
async function sendV2Command(listener, command) {
  const json = JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  const transferId = makeV2TransferId();
  const chunks = [];
  for (let off = 0; off < bytes.length; off += kV2MaxPayload) {
    chunks.push(bytes.slice(off, off + kV2MaxPayload));
  }
  if (chunks.length > 0 && chunks[chunks.length - 1].length === kV2MaxPayload) {
    chunks.push(new Uint8Array(0));
  }
  if (chunks.length === 0) {
    chunks.push(new Uint8Array(0));
  }
  for (let seq = 0; seq < chunks.length; seq += 1) {
    const frame = encodeChunkFrame({ transferId, seq, payload: chunks[seq] });
    await callBleCommand(listener, { type: '__ble_raw_bytes', bytes: Array.from(frame) });
  }
  return { transferId };
}

test('service worker handles js.exec.request and posts js.exec.result via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  harness.setJsExecEvalImpl(async () => ({
    ok: true,
    value_type: 'string',
    value_json: '"ok"',
    truncated: false
  }));

  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  const { returned, response } = await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-1',
    script: 'return "ok";',
    timeout_ms: 300,
    max_result_chars: 200
  });

  assert.equal(returned, true);
  assert.deepEqual(response, { ok: true });
  const evalCalls = harness.cdpCommandCalls.filter((entry) => entry.method === 'Runtime.evaluate');
  assert.equal(evalCalls.length, 1);

  const resultPayload = harness.postedPayloads.find((payload) => payload?.type === 'js.exec.result');
  assert.equal(Boolean(resultPayload), true);
  assert.equal(resultPayload.request_id, 'js-1');
  assert.equal(resultPayload.value_type, 'string');
  assert.equal(resultPayload.value_json, '"ok"');
  assert.equal(resultPayload.truncated, false);
});

test('service worker handles js.exec.request delivered via v2 half-pipe chunks', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  const command = {
    type: 'js.exec.request',
    request_id: 'js-xfer-1',
    script: 'return document.title;',
    timeout_ms: 300,
    max_result_chars: 200
  };

  // Single-transfer v2 chunk delivery via __ble_raw_bytes
  await sendV2Command(listener, command);

  await waitFor(() => harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  )));
  const payload = harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  ));
  assert.equal(payload?.type, 'js.exec.result');
});

test('service worker emits v2 ACK frames while receiving v2 CHUNK frames', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  const command = {
    type: 'js.exec.request',
    request_id: 'js-ack-1',
    script: 'return "ok";',
    timeout_ms: 300,
    max_result_chars: 200
  };
  const json = JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  const transferId = makeV2TransferId();
  const mid = Math.floor(bytes.length / 2);

  // Send two v2 CHUNK frames
  const frame0 = encodeChunkFrame({ transferId, seq: 0, payload: bytes.slice(0, mid) });
  await callBleCommand(listener, { type: '__ble_raw_bytes', bytes: Array.from(frame0) });
  const frame1 = encodeChunkFrame({ transferId, seq: 1, payload: bytes.slice(mid) });
  await callBleCommand(listener, { type: '__ble_raw_bytes', bytes: Array.from(frame1) });

  // Half-pipe sends ACK frames as binary via ble.postBinary
  const ackFrames = harness.postedBinary
    .map((raw) => decodeFrame(Uint8Array.from(raw)))
    .filter((f) => f && f.type === 4); // kFrameType.ACK
  assert.ok(ackFrames.length >= 1, 'at least one ACK frame sent');
  assert.equal(ackFrames[0].transferId, transferId);
});

test('service worker handles v2 half-pipe with multi-chunk reassembly and dispatches command', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  // Build a command large enough to span multiple 255-byte v2 chunks
  const command = {
    type: 'js.exec.request',
    request_id: 'js-multi-1',
    script: 'return ' + 'x'.repeat(600) + ';',
    timeout_ms: 300,
    max_result_chars: 200
  };

  // sendV2Command splits into proper kV2MaxPayload-sized chunks
  await sendV2Command(listener, command);

  await waitFor(() => harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-multi-1'
  )));
  const payload = harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-multi-1'
  ));
  assert.equal(payload?.type, 'js.exec.result');
});

test('service worker returns js_exec_busy when a js exec request is already in flight', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  let resolveFirst = null;
  harness.setJsExecEvalImpl(() => new Promise((resolve) => {
    resolveFirst = () => resolve({ ok: true, value_type: 'number', value_json: '1', truncated: false });
  }));

  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  listener({
    type: 'ble.command',
    command: {
      type: 'js.exec.request',
      request_id: 'js-a',
      script: 'return 1;',
      timeout_ms: 2000
    }
  }, kTrustedSender, () => {});

  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-b',
    script: 'return 2;'
  });

  await waitFor(() => harness.postedPayloads.find((payload) => (
    payload?.type === 'js.exec.error' && payload.request_id === 'js-b'
  )));
  const busyPayload = harness.postedPayloads.find((payload) => payload?.type === 'js.exec.error' && payload.request_id === 'js-b');
  assert.equal(Boolean(busyPayload), true);
  assert.equal(busyPayload.error_code, 'js_exec_busy');

  resolveFirst();
  await waitFor(() => harness.postedPayloads.find((payload) => (
    payload?.type === 'js.exec.result' && payload.request_id === 'js-a'
  )));
});

test('service worker rejects ble.command from untrusted sender', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  let response = null;
  const returned = listener({
    type: 'ble.command',
    command: { type: 'js.exec.request', request_id: 'js-u', script: 'return 1;' }
  }, {
    id: 'other-extension-id',
    url: 'chrome-extension://other/src/ble_bridge.html'
  }, (msg) => {
    response = msg;
  });

  assert.equal(returned, true);
  assert.deepEqual(response, { ok: false, error: 'untrusted_sender' });
  const evalCalls = harness.cdpCommandCalls.filter((entry) => entry.method === 'Runtime.evaluate');
  assert.equal(evalCalls.length, 0);
});

test('service worker rejects ble.command when sender id matches but sender url is malformed', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  let response = null;
  const returned = listener({
    type: 'ble.command',
    command: { type: 'js.exec.request', request_id: 'js-malformed-url', script: 'return 1;' }
  }, {
    id: 'test',
    url: 'chrome-extension://test/src/not_bridge.html'
  }, (msg) => {
    response = msg;
  });

  assert.equal(returned, true);
  assert.deepEqual(response, { ok: false, error: 'untrusted_sender' });
  const evalCalls = harness.cdpCommandCalls.filter((entry) => entry.method === 'Runtime.evaluate');
  assert.equal(evalCalls.length, 0);
});

test('service worker releases js exec lock after bounded post-timeout hold', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  let callCount = 0;
  harness.setJsExecEvalImpl(() => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise(() => {});
    }
    return Promise.resolve({ ok: true, value_type: 'number', value_json: '2', truncated: false });
  });

  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-timeout-a',
    script: 'return 1;',
    timeout_ms: 50
  });

  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-timeout-b',
    script: 'return 2;'
  });

  const timeoutPayload = harness.postedPayloads.find((payload) => payload?.request_id === 'js-timeout-a');
  assert.equal(timeoutPayload?.type, 'js.exec.error');
  assert.equal(timeoutPayload?.error_code, 'js_exec_timeout');

  const busyPayload = harness.postedPayloads.find((payload) => payload?.request_id === 'js-timeout-b');
  assert.equal(busyPayload?.type, 'js.exec.error');
  assert.equal(busyPayload?.error_code, 'js_exec_busy');

  await waitFor(async () => {
    const probeId = `js-timeout-probe-${Date.now()}`;
    await callBleCommand(listener, {
      type: 'js.exec.request',
      request_id: probeId,
      script: 'return 3;'
    });
    const payload = harness.postedPayloads.find((entry) => entry?.request_id === probeId);
    return payload?.type === 'js.exec.result' ? payload : null;
  }, { timeoutMs: 2000, intervalMs: 50 });

  const finalPayload = harness.postedPayloads.find((payload) => (
    String(payload?.request_id || '').startsWith('js-timeout-probe-')
    && payload?.type === 'js.exec.result'
  ));
  assert.equal(Boolean(finalPayload), true);
});

test('service worker returns invalid_js_exec_request for empty script', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-invalid',
    script: ''
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'js-invalid');
  assert.equal(payload?.type, 'js.exec.error');
  assert.equal(payload?.error_code, 'invalid_js_exec_request');
});

test('service worker maps runtime script failures to js_exec_runtime_error', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  harness.setJsExecEvalImpl(async () => ({
    ok: false,
    error_code: 'js_exec_runtime_error',
    error: 'boom'
  }));
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-runtime',
    script: 'throw new Error("boom");'
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'js-runtime');
  assert.equal(payload?.type, 'js.exec.error');
  assert.equal(payload?.error_code, 'js_exec_runtime_error');
});

test('service worker handles tab.open.request and posts tab.open via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'tab.open.request',
    request_id: 'open-1',
    url: 'https://example.com/new',
    active: false
  });

  assert.equal(harness.createTabCalls.length, 1);
  assert.deepEqual(harness.createTabCalls[0], { url: 'https://example.com/new', active: false });
  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'open-1');
  assert.equal(payload?.type, 'tab.open');
  assert.equal(payload?.tab?.url, 'https://example.com/new');
  assert.equal(payload?.tab?.active, false);
});

test('service worker returns tab.open.error when chrome.tabs.create fails', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  harness.setCreateTabImpl(async () => {
    throw new Error('tabs_create_failed');
  });
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'tab.open.request',
    request_id: 'open-err',
    url: 'https://example.com/new'
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'open-err');
  assert.equal(payload?.type, 'tab.open.error');
  assert.equal(payload?.error, 'tabs_create_failed');
});

test('service worker handles window.bounds.request and posts window.bounds via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'window.bounds.request',
    request_id: 'wb-1'
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'wb-1');
  assert.equal(payload?.type, 'window.bounds');
  assert.equal(payload?.tab_id, 9);
  assert.equal(payload?.window_id, 1);
  assert.deepEqual(payload?.bounds, {
    left: 120,
    top: 60,
    width: 1280,
    height: 900,
    window_state: 'normal'
  });
  const cdpCall = harness.cdpCommandCalls.find((entry) => entry.method === 'Browser.getWindowForTarget');
  assert.equal(Boolean(cdpCall), true);
});

test('service worker falls back to chrome.windows.get when Browser.getWindowForTarget is unavailable', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  harness.setCdpWindowMethodMissing(true);
  harness.setGetWindowImpl(async (windowId) => ({
    id: windowId,
    left: 240,
    top: 120,
    width: 1440,
    height: 900,
    state: 'normal'
  }));
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'window.bounds.request',
    request_id: 'wb-fallback-1'
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'wb-fallback-1');
  assert.equal(payload?.type, 'window.bounds');
  assert.equal(payload?.window_id, 1);
  assert.deepEqual(payload?.bounds, {
    left: 240,
    top: 120,
    width: 1440,
    height: 900,
    window_state: 'normal'
  });
});

test('service worker returns window.bounds.error when target tab is unavailable', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  globalThis.chrome.tabs.query = async () => [];
  globalThis.chrome.tabs.get = async () => {
    throw new Error('no_such_tab');
  };
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'window.bounds.request',
    request_id: 'wb-err'
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'wb-err');
  assert.equal(payload?.type, 'window.bounds.error');
  assert.equal(payload?.error, 'active_tab_not_found');
});

test('service worker dispatches dom snapshot requests and ignores unknown commands', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'dom.snapshot.request',
    request_id: 'dom-1'
  });

  // Stream path sends binary frames (payload > 160 bytes chunk threshold).
  assert.ok(harness.postedBinary.length > 0, 'binary frames sent via stream');
  // No error should have been posted.
  const errorPayload = harness.postedPayloads.find((entry) => entry?.type === 'dom.snapshot.error');
  assert.equal(errorPayload, undefined);

  const payloadCountBeforeUnknown = harness.postedPayloads.length;
  const binaryCountBeforeUnknown = harness.postedBinary.length;
  await callBleCommand(listener, {
    type: 'does.not.exist'
  });
  assert.equal(harness.postedPayloads.length, payloadCountBeforeUnknown);
  assert.equal(harness.postedBinary.length, binaryCountBeforeUnknown);
});

test('service worker sends screenshot via stream and verifies capture', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'screenshot.request',
    request_id: 'shot-1',
    source: 'desktop',
    max_chars: 20000
  });

  // Stream path sends the screenshot.response as binary frames or inline JSON.
  const inlinePayload = harness.postedPayloads.find((entry) =>
    entry?.type === 'screenshot.response' && entry?.request_id === 'shot-1'
  );
  const hasBinaryFrames = harness.postedBinary.length > 0;
  assert.ok(inlinePayload || hasBinaryFrames, 'screenshot sent via stream');
  assert.equal(harness.desktopCaptureCalls.length, 1);

  // If sent inline, verify key fields.
  if (inlinePayload) {
    assert.equal(inlinePayload.source, 'desktop');
    assert.equal(typeof inlinePayload.data, 'string');
    assert.equal(typeof inlinePayload.mime, 'string');
    assert.equal(inlinePayload.source_width, 64);
    assert.equal(inlinePayload.source_height, 48);
  }

  // If sent as binary frames, verify AK frame structure.
  if (hasBinaryFrames) {
    const firstFrame = parseTransferChunkFrame(harness.postedBinary[0]);
    assert.equal(firstFrame?.magic0, 0x41);
    assert.equal(firstFrame?.magic1, 0x4b);
    assert.equal(firstFrame?.frameType, 1); // CHUNK
  }

  // No error should have been posted.
  const errorPayload = harness.postedPayloads.find((entry) => entry?.type === 'screenshot.error');
  assert.equal(errorPayload, undefined);
});

test('service worker reports screenshot.error when stream binary send fails', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  harness.setBlePostBinaryOk(false);

  const { response } = await callBleCommand(listener, {
    type: 'screenshot.request',
    request_id: 'shot-nack',
    source: 'desktop',
    max_chars: 20000
  });

  // When binary send fails, both the response and error paths fail through halfpipe.
  // The error propagates back as a failed ble.command response.
  assert.equal(response?.ok, false);
  assert.equal(typeof response?.error, 'string');
});
