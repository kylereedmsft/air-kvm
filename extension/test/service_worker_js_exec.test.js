import test from 'node:test';
import assert from 'node:assert/strict';

const kTrustedSender = {
  id: 'test',
  url: 'chrome-extension://test/src/ble_bridge.html'
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
            if (rawBytes.length >= 18 && rawBytes[0] === 0x41 && rawBytes[1] === 0x4B) {
              const dv = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
              const tidNum = dv.getUint32(4, true);
              const rawSeq = dv.getUint32(8, true);
              const seq = rawSeq & 0x7FFFFFFF;
              const tid = `tx_${(tidNum >>> 0).toString(16).padStart(8, '0')}`;
              const ref = bleCommandListenerRef;
              setTimeout(() => {
                ref({ type: 'ble.command', command: { type: 'stream.ack', transfer_id: tid, seq } }, kTrustedSender, () => {});
              }, 0);
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
  if (bytes.length < 18) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic0: bytes[0],
    magic1: bytes[1],
    version: bytes[2],
    frameType: bytes[3],
    transferIdNumeric: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    payloadLength: view.getUint16(12, true),
    totalLength: bytes.length
  };
}

async function callBleCommand(listener, command, sender = kTrustedSender) {
  return new Promise((resolve) => {
    const returned = listener({ type: 'ble.command', command }, sender, (msg) => {
      resolve({ returned, response: msg });
    });
    if (returned !== true) {
      resolve({ returned, response: null });
    }
  });
}

function findBleCommandListener(runtimeListeners) {
  const listener = runtimeListeners.find((candidate) => {
    let called = false;
    const out = candidate({ type: 'ble.command', command: { type: 'unknown' } }, kTrustedSender, () => {
      called = true;
    });
    return out === true || called;
  });
  assert.equal(typeof listener, 'function');
  return listener;
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

  const listener = findBleCommandListener(harness.runtimeListeners);
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

test('service worker handles js.exec.request delivered via stream.data chunks', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  const transferId = 'tx_abcdef01';
  const command = {
    type: 'js.exec.request',
    request_id: 'js-xfer-1',
    script: 'return document.title;',
    timeout_ms: 300,
    max_result_chars: 200
  };
  const json = JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  const dataB64 = Buffer.from(bytes).toString('base64');

  // Single-chunk stream.data delivery
  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 0,
    is_final: true,
    data_b64: dataB64
  });

  await waitFor(() => harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  )));
  const payload = harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  ));
  assert.equal(payload?.type, 'js.exec.result');
});

test('service worker emits stream.ack while receiving stream.data chunks', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  const transferId = 'tx_ack_abcd';
  const command = {
    type: 'js.exec.request',
    request_id: 'js-ack-1',
    script: 'return "ok";',
    timeout_ms: 300,
    max_result_chars: 200
  };
  const json = JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  const mid = Math.floor(bytes.length / 2);
  const chunk0B64 = Buffer.from(bytes.slice(0, mid)).toString('base64');
  const chunk1B64 = Buffer.from(bytes.slice(mid)).toString('base64');

  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 0,
    is_final: false,
    data_b64: chunk0B64
  });
  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 1,
    is_final: true,
    data_b64: chunk1B64
  });

  const ack = harness.postedPayloads.find((payload) => (
    payload?.type === 'stream.ack' && payload?.transfer_id === transferId
  ));
  assert.equal(Boolean(ack), true);
  assert.equal(typeof ack?.seq, 'number');
});

test('service worker handles stream.data with multi-chunk reassembly and dispatches command', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  const transferId = 'tx_multi_abcd';
  const command = {
    type: 'js.exec.request',
    request_id: 'js-multi-1',
    script: 'return 42;',
    timeout_ms: 300,
    max_result_chars: 200
  };
  const json = JSON.stringify(command);
  const bytes = new TextEncoder().encode(json);
  // Split into 3 chunks
  const third = Math.floor(bytes.length / 3);
  const chunk0B64 = Buffer.from(bytes.slice(0, third)).toString('base64');
  const chunk1B64 = Buffer.from(bytes.slice(third, third * 2)).toString('base64');
  const chunk2B64 = Buffer.from(bytes.slice(third * 2)).toString('base64');

  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 0,
    is_final: false,
    data_b64: chunk0B64
  });
  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 1,
    is_final: false,
    data_b64: chunk1B64
  });
  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: transferId,
    seq: 2,
    is_final: true,
    data_b64: chunk2B64
  });

  await waitFor(() => harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-multi-1'
  )));
  const payload = harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-multi-1'
  ));
  assert.equal(payload?.type, 'js.exec.result');
});

test('service worker transfer.reset clears inbound script transfers', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);

  // Send a partial stream.data chunk (no is_final), then reset
  await callBleCommand(listener, {
    type: 'stream.data',
    transfer_id: 'tx_reset_abcd',
    seq: 0,
    is_final: false,
    data_b64: Buffer.from('partial').toString('base64')
  });
  await callBleCommand(listener, {
    type: 'transfer.reset',
    request_id: 'reset-all-1'
  });

  const resetAck = harness.postedPayloads.find((payload) => (
    payload?.type === 'transfer.reset.ok' && payload?.request_id === 'reset-all-1'
  ));
  assert.equal(Boolean(resetAck), true);
});

test('service worker returns js_exec_busy when a js exec request is already in flight', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  let resolveFirst = null;
  harness.setJsExecEvalImpl(() => new Promise((resolve) => {
    resolveFirst = () => resolve({ ok: true, value_type: 'number', value_json: '1', truncated: false });
  }));

  const listener = findBleCommandListener(harness.runtimeListeners);

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
  const listener = findBleCommandListener(harness.runtimeListeners);

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
  const listener = findBleCommandListener(harness.runtimeListeners);

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

  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
  harness.setBleCommandListener(listener);
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
  const listener = findBleCommandListener(harness.runtimeListeners);
  harness.setBleCommandListener(listener);
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
    assert.equal(firstFrame?.version, 1);
    assert.equal(firstFrame?.frameType, 1);
  }

  // No error should have been posted.
  const errorPayload = harness.postedPayloads.find((entry) => entry?.type === 'screenshot.error');
  assert.equal(errorPayload, undefined);
});

test('service worker reports screenshot.error when stream binary send fails', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  harness.setBlePostBinaryOk(false);

  await callBleCommand(listener, {
    type: 'screenshot.request',
    request_id: 'shot-nack',
    source: 'desktop',
    max_chars: 20000
  });

  const errorPayload = harness.postedPayloads.find((entry) => (
    entry?.type === 'screenshot.error'
    && entry?.request_id === 'shot-nack'
  ));
  assert.ok(errorPayload, 'screenshot error posted when stream binary send fails');
  assert.ok(errorPayload.error.includes('chunk_send_failed') || errorPayload.error.includes('binary_send_failed'),
    'error detail references binary send failure');
});
