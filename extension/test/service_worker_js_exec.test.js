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
      getURL: (path) => `chrome-extension://test/${path}`,
      sendMessage: async (msg) => {
        if (msg?.type === 'ble.post') {
          postedPayloads.push(msg.payload);
          return { ok: blePostOk };
        }
        if (msg?.type === 'ble.postBinary') {
          postedBinary.push(msg.bytes);
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

test('service worker dispatches dom snapshot requests and ignores unknown commands', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  await callBleCommand(listener, {
    type: 'dom.snapshot.request',
    request_id: 'dom-1'
  });

  const metaPayload = harness.postedPayloads.find((entry) => entry?.type === 'transfer.meta' && entry?.request_id === 'dom-1');
  assert.equal(Boolean(metaPayload), true);
  assert.equal(metaPayload?.source, 'dom');
  assert.equal(metaPayload?.mime, 'application/json');
  assert.equal(metaPayload?.encoding, 'bin');
  assert.equal(metaPayload?.total_chunks > 0, true);
  assert.equal(harness.postedBinary.length, metaPayload.total_chunks);
  const donePayload = harness.postedPayloads.find((entry) => entry?.type === 'transfer.done' && entry?.request_id === 'dom-1');
  assert.equal(Boolean(donePayload), true);
  assert.equal(donePayload?.transfer_id, metaPayload?.transfer_id);

  const payloadCountBeforeUnknown = harness.postedPayloads.length;
  await callBleCommand(listener, {
    type: 'does.not.exist'
  });
  assert.equal(harness.postedPayloads.length, payloadCountBeforeUnknown);
});

test('service worker transfer lifecycle posts meta/chunks/done then clears on done ack', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  await callBleCommand(listener, {
    type: 'screenshot.request',
    request_id: 'shot-1',
    source: 'desktop',
    max_chars: 20000
  });

  const metaPayload = harness.postedPayloads.find((entry) => entry?.type === 'transfer.meta' && entry?.request_id === 'shot-1');
  assert.equal(Boolean(metaPayload), true);
  assert.equal(String(metaPayload?.transfer_id || '').startsWith('tx_'), true);
  assert.equal(metaPayload?.encoding, 'bin');
  assert.equal(metaPayload?.chunk_size, 160);
  assert.equal(metaPayload?.total_bytes, 5);
  assert.equal(metaPayload?.total_chunks, 1);
  assert.equal(metaPayload?.source_width, 64);
  assert.equal(metaPayload?.source_height, 48);
  assert.equal(metaPayload?.encoded_width, 64);
  assert.equal(metaPayload?.encoded_height, 48);
  assert.equal(metaPayload?.encoded_quality, 0.55);
  assert.equal(metaPayload?.encode_attempts, 1);
  assert.equal(harness.desktopCaptureCalls.length, 1);
  assert.equal(harness.postedBinary.length, metaPayload.total_chunks);

  const transferIdNumeric = Number.parseInt(metaPayload.transfer_id.slice(3), 16) >>> 0;
  const firstFrame = parseTransferChunkFrame(harness.postedBinary[0]);
  assert.equal(firstFrame?.magic0, 0x41);
  assert.equal(firstFrame?.magic1, 0x4b);
  assert.equal(firstFrame?.version, 1);
  assert.equal(firstFrame?.frameType, 1);
  assert.equal(firstFrame?.transferIdNumeric, transferIdNumeric);
  assert.equal(firstFrame?.seq, 0);
  assert.equal(firstFrame?.payloadLength, 5);
  assert.equal(firstFrame?.totalLength, 23);

  const donePayload = harness.postedPayloads.find((entry) => entry?.type === 'transfer.done' && entry?.request_id === 'shot-1');
  assert.equal(donePayload?.transfer_id, metaPayload.transfer_id);
  assert.equal(donePayload?.total_chunks, metaPayload.total_chunks);

  await callBleCommand(listener, {
    type: 'transfer.done.ack',
    request_id: 'shot-1',
    transfer_id: metaPayload.transfer_id
  });

  await callBleCommand(listener, {
    type: 'transfer.resume',
    request_id: 'shot-1',
    transfer_id: metaPayload.transfer_id
  });

  const missingPayload = harness.postedPayloads.find((entry) => (
    entry?.type === 'transfer.error'
    && entry?.request_id === 'shot-1'
    && entry?.code === 'no_such_transfer'
  ));
  assert.equal(Boolean(missingPayload), true);
});

test('service worker reports transfer_nack_failed when bridge binary post fails', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners);
  await callBleCommand(listener, {
    type: 'screenshot.request',
    request_id: 'shot-nack',
    source: 'desktop',
    max_chars: 20000
  });

  const metaPayload = harness.postedPayloads.find((entry) => (
    entry?.type === 'transfer.meta' && entry?.request_id === 'shot-nack'
  ));
  assert.equal(Boolean(metaPayload), true);

  harness.setBlePostBinaryOk(false);
  await callBleCommand(listener, {
    type: 'transfer.nack',
    request_id: 'shot-nack',
    transfer_id: metaPayload.transfer_id,
    seq: 0
  });

  const errorPayload = harness.postedPayloads.find((entry) => (
    entry?.type === 'transfer.error'
    && entry?.request_id === 'shot-nack'
    && entry?.code === 'transfer_nack_failed'
  ));
  assert.equal(Boolean(errorPayload), true);
  assert.equal(errorPayload?.detail, 'binary_send_failed');
});
