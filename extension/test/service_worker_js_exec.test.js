import test from 'node:test';
import assert from 'node:assert/strict';

const kTrustedSender = {
  id: 'test',
  url: 'chrome-extension://test/ble_bridge.html'
};

function makeHarness() {
  const postedPayloads = [];
  const postedControlPayloads = [];
  const postedBinary = [];
  const runtimeListeners = [];
  const cdpCommandCalls = [];
  const cdpAttachCalls = [];
  const cdpDetachCalls = [];
  const scriptingCalls = [];
  const createTabCalls = [];
  const createWindowCalls = [];
  const tabCaptureCalls = [];
  const desktopCaptureCalls = [];
  let jsExecEvalImpl = async () => ({ ok: true, value_type: 'number', value_json: '1', truncated: false });
  let jsInjectImpl = async () => ({ ok: true, value_type: 'number', value_json: '1', truncated: false });
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
    url,
    status: 'complete'
  });
  let blePostBinaryOk = true;
  let cdpWindowMethodMissing = false;
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
        if (msg?.type === 'hp.send') {
          postedPayloads.push(msg.payload);
          return { ok: blePostBinaryOk };
        }
        if (msg?.type === 'hp.sendControl') {
          postedControlPayloads.push({
            payload: msg.payload,
            control_target: msg.control_target
          });
          return { ok: blePostBinaryOk };
        }
        if (msg?.type === 'ble.postBinary') {
          // No longer used by service_worker; kept for completeness.
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
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      create: async (opts) => {
        createTabCalls.push(opts);
        return createTabImpl(opts);
      }
    },
    windows: {
      get: async (windowId) => getWindowImpl(windowId),
      create: async (opts) => {
        createWindowCalls.push(opts);
        return {
          id: 31,
          focused: opts.focused ?? true,
          type: opts.type || 'normal',
          left: 140,
          top: 90,
          width: opts.width ?? 900,
          height: opts.height ?? 700,
          state: 'normal',
          tabs: [{
            id: 52,
            windowId: 31,
            active: true,
            title: 'Window Tab',
            url: Array.isArray(opts.url) ? opts.url[0] : opts.url
          }]
        };
      }
    },
    scripting: {
      executeScript: async (opts) => {
        scriptingCalls.push(opts);
        if (typeof opts?.func === 'function' && Array.isArray(opts?.args) && opts.args.length === 2) {
          return [{ result: await jsInjectImpl(opts) }];
        }
        return [{
          result: {
            device_pixel_ratio: 2,
            screen: {
              width: 1512,
              height: 982
            },
            viewport: {
              inner_width: 757,
              inner_height: 727,
              outer_width: 765,
              outer_height: 817,
              screen_x: 9,
              screen_y: 57
            }
          }
        }];
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
    postedControlPayloads,
    postedBinary,
    runtimeListeners,
    cdpCommandCalls,
    cdpAttachCalls,
    cdpDetachCalls,
    scriptingCalls,
    createTabCalls,
    createWindowCalls,
    tabCaptureCalls,
    desktopCaptureCalls,
    setJsExecEvalImpl: (impl) => {
      jsExecEvalImpl = impl;
    },
    setJsInjectImpl: (impl) => {
      jsInjectImpl = impl;
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
    setBlePostBinaryOk: (ok) => {
      blePostBinaryOk = ok;
    },
    setCdpWindowMethodMissing: (missing) => {
      cdpWindowMethodMissing = missing;
    },
    setGetWindowImpl: (impl) => {
      getWindowImpl = impl;
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

async function callBleCommand(listener, command, sender = kTrustedSender) {
  return new Promise((resolve) => {
    let returned;
    returned = listener({ type: 'hp.message', msg: command }, sender, (msg) => {
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
    const out = candidate({ type: 'hp.message', msg: { type: 'unknown' } }, kTrustedSender, () => {
      called = true;
    });
    return out === true || called;
  });
  assert.equal(typeof listener, 'function');
  return listener;
}

function findBusyChangedListener(runtimeListeners) {
  const listener = runtimeListeners.find((candidate) => {
    let called = false;
    const out = candidate({ type: 'busy.changed', busy: true }, { tab: { id: 9 } }, () => {
      called = true;
    });
    return out === true || called;
  });
  assert.equal(typeof listener, 'function');
  return listener;
}

// Send a command to the service worker as a fully-assembled hp.message.
// (HalfPipe chunking/reassembly is now in ble_bridge.js, not service_worker.js.)
async function sendCommand(listener, command) {
  return callBleCommand(listener, command);
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

test('service worker handles js.inject.request and posts js.inject.result via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();

  harness.setJsInjectImpl(async () => ({
    ok: true,
    value_type: 'string',
    value_json: '"silent"',
    truncated: false
  }));

  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  const { returned, response } = await callBleCommand(listener, {
    type: 'js.inject.request',
    request_id: 'inj-1',
    script: JSON.stringify({ __airkvm_inject: true, op: 'hid_fixture.read' }),
    timeout_ms: 300,
    max_result_chars: 200
  });

  assert.equal(returned, true);
  assert.deepEqual(response, { ok: true });
  assert.equal(harness.cdpCommandCalls.filter((entry) => entry.method === 'Runtime.evaluate').length, 0);
  assert.equal(harness.scriptingCalls.length > 0, true);

  const resultPayload = harness.postedPayloads.find((payload) => payload?.type === 'js.inject.result');
  assert.equal(Boolean(resultPayload), true);
  assert.equal(resultPayload.request_id, 'inj-1');
  assert.equal(resultPayload.value_type, 'string');
  assert.equal(resultPayload.value_json, '"silent"');
  assert.equal(resultPayload.truncated, false);
});

test('service worker handles js.exec.request delivered via hp.message', async () => {
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

  await sendCommand(listener, command);

  await waitFor(() => harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  )));
  const payload = harness.postedPayloads.find((entry) => (
    entry?.type === 'js.exec.result' && entry?.request_id === 'js-xfer-1'
  ));
  assert.equal(payload?.type, 'js.exec.result');
});

test('service worker handles multiple sequential hp.message commands', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-seq-1',
    script: 'return 1;',
    timeout_ms: 300
  });
  await callBleCommand(listener, {
    type: 'js.exec.request',
    request_id: 'js-seq-2',
    script: 'return 2;',
    timeout_ms: 300
  });

  const p1 = harness.postedPayloads.find((e) => e?.request_id === 'js-seq-1');
  const p2 = harness.postedPayloads.find((e) => e?.request_id === 'js-seq-2');
  assert.equal(p1?.type, 'js.exec.result');
  assert.equal(p2?.type, 'js.exec.result');
});

test('service worker handles large js.exec.request dispatched as single hp.message', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  const command = {
    type: 'js.exec.request',
    request_id: 'js-multi-1',
    script: 'return ' + '"x".repeat(600)' + ';',
    timeout_ms: 300,
    max_result_chars: 200
  };

  await sendCommand(listener, command);

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
    type: 'hp.message',
    msg: {
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

test('service worker rejects hp.message from untrusted sender', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  let response = null;
  const returned = listener({
    type: 'hp.message',
    msg: { type: 'js.exec.request', request_id: 'js-u', script: 'return 1;' }
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

test('service worker rejects hp.message when sender id matches but sender url is malformed', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);

  let response = null;
  const returned = listener({
    type: 'hp.message',
    msg: { type: 'js.exec.request', request_id: 'js-malformed-url', script: 'return 1;' }
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

test('service worker returns invalid_js_inject_request for empty script', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'js.inject.request',
    request_id: 'inj-invalid',
    script: ''
  });

  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'inj-invalid');
  assert.equal(payload?.type, 'js.inject.error');
  assert.equal(payload?.error_code, 'invalid_js_inject_request');
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

test('service worker handles window.open.request and posts window.open via bridge', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBleCommandListener(harness.runtimeListeners, harness);
  await callBleCommand(listener, {
    type: 'window.open.request',
    request_id: 'win-open-1',
    url: 'https://example.com/new-window',
    focused: true,
    width: 900,
    height: 700,
    window_type: 'popup'
  });

  assert.equal(harness.createWindowCalls.length, 1);
  assert.deepEqual(harness.createWindowCalls[0], {
    url: 'https://example.com/new-window',
    focused: true,
    type: 'popup',
    width: 900,
    height: 700
  });
  const payload = harness.postedPayloads.find((entry) => entry?.request_id === 'win-open-1');
  assert.equal(payload?.type, 'window.open');
  assert.equal(payload?.window?.id, 31);
  assert.equal(payload?.tab?.window_id, 31);
  assert.equal(payload?.tab?.id, 52);
});

test('busy.changed routes state.set over hp.sendControl to firmware target', async () => {
  const harness = makeHarness();
  await importServiceWorkerFresh();
  const listener = findBusyChangedListener(harness.runtimeListeners);
  harness.postedPayloads.length = 0;
  harness.postedControlPayloads.length = 0;

  let response = null;
  const returned = listener(
    { type: 'busy.changed', busy: true },
    { tab: { id: 44 } },
    (msg) => { response = msg; }
  );

  assert.equal(returned, true);
  await waitFor(() => harness.postedControlPayloads.length > 0 ? harness.postedControlPayloads[0] : null);
  assert.deepEqual(response, { ok: true });
  assert.equal(harness.postedPayloads.length, 0);
  assert.equal(harness.postedControlPayloads[0].control_target, 'fw');
  assert.deepEqual(harness.postedControlPayloads[0].payload, { type: 'state.set', busy: true });
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
    left: 130,
    top: 70,
    width: 1200,
    height: 860,
    window_state: 'normal'
  });
  assert.equal(payload?.screen?.device_pixel_ratio, 2);
  assert.equal(payload?.screen?.screen?.width, 1512);
  assert.equal(payload?.screen?.screen?.height, 982);
  assert.equal(payload?.screen?.viewport?.screen_x, 9);
  assert.equal(payload?.screen?.viewport?.screen_y, 57);
  assert.equal(harness.scriptingCalls.length, 1);
  const cdpCall = harness.cdpCommandCalls.find((entry) => entry.method === 'Browser.getWindowForTarget');
  assert.equal(cdpCall, undefined);
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

  // hp.send path delivers dom.snapshot as JSON payload via sendViaHalfPipe.
  const snapshotPayload = harness.postedPayloads.find((entry) => entry?.type === 'dom.snapshot');
  assert.ok(snapshotPayload, 'dom.snapshot sent via hp.send');
  // No error should have been posted.
  const errorPayload = harness.postedPayloads.find((entry) => entry?.type === 'dom.snapshot.error');
  assert.equal(errorPayload, undefined);

  const payloadCountBeforeUnknown = harness.postedPayloads.length;
  await callBleCommand(listener, {
    type: 'does.not.exist'
  });
  assert.equal(harness.postedPayloads.length, payloadCountBeforeUnknown);
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

  // hp.send path delivers screenshot.response as JSON payload via sendViaHalfPipe.
  const inlinePayload = harness.postedPayloads.find((entry) =>
    entry?.type === 'screenshot.response' && entry?.request_id === 'shot-1'
  );
  assert.ok(inlinePayload, 'screenshot.response sent via hp.send');
  assert.equal(harness.desktopCaptureCalls.length, 1);
  assert.equal(inlinePayload.source, 'desktop');
  assert.equal(typeof inlinePayload.data, 'string');
  assert.equal(typeof inlinePayload.mime, 'string');
  assert.equal(inlinePayload.source_width, 64);
  assert.equal(inlinePayload.source_height, 48);

  // No error should have been posted.
  const errorPayload = harness.postedPayloads.find((entry) => entry?.type === 'screenshot.error');
  assert.equal(errorPayload, undefined);
});

test('service worker handles screenshot request when hp.send returns ok:false', async () => {
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

  // In the new arch, sendViaHalfPipe swallows the ok:false and the command handler completes normally.
  // The screenshot.response was attempted but hp.send signaled failure.
  assert.equal(response?.ok, true);
  const attemptedPayload = harness.postedPayloads.find((e) => e?.request_id === 'shot-nack');
  assert.ok(attemptedPayload, 'screenshot.response was attempted via hp.send');
});
