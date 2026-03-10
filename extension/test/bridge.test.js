import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetBleForTest,
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postBinary,
  postEvent,
  setBleDebugLogger,
  setBleVerboseDebug
} from '../src/bridge.js';

function telemetryEvents(logged) {
  const events = [];
  for (const args of logged) {
    for (const value of args) {
      if (value && typeof value === 'object' && typeof value.evt === 'string') {
        events.push(value);
      }
    }
  }
  return events;
}

test('connectBle establishes UART RX characteristic via navigator.bluetooth', async () => {
  __resetBleForTest();
  let requested = null;
  const writes = [];
  const rx = {
    writeValueWithoutResponse: async (value) => writes.push(value)
  };
  const service = {
    getCharacteristic: async () => rx
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async (opts) => {
        requested = opts;
        return device;
      }
    }
  };

  const connected = await connectBle({ navigatorLike });
  const posted = await postEvent({ type: 'busy.changed', busy: true });

  assert.equal(connected, true);
  assert.equal(posted, true);
  assert.deepEqual(requested.filters, [{ services: ['6e400101-b5a3-f393-e0a9-e50e24dccb01'] }]);
  assert.equal(writes.length, 1);
});

test('connectBle emits structured connect-stage telemetry', async () => {
  __resetBleForTest();
  const logged = [];
  setBleVerboseDebug(true);
  setBleDebugLogger((...args) => logged.push(args));

  const rx = {
    uuid: '6e400102-b5a3-f393-e0a9-e50e24dccb01',
    writeValueWithoutResponse: async () => {}
  };
  const tx = {
    uuid: '6e400103-b5a3-f393-e0a9-e50e24dccb01',
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    uuid: '6e400101-b5a3-f393-e0a9-e50e24dccb01',
    getCharacteristic: async (uuid) => (
      String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx
    )
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    id: 'dev-telemetry',
    name: 'air-kvm-ctrl-cb01',
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);

  const events = telemetryEvents(logged);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage' && event.stage === 'requestDevice' && event.result === 'attempt'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage' && event.stage === 'requestDevice' && event.result === 'ok'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage' && event.stage === 'getPrimaryService' && event.result === 'ok'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage'
    && event.stage === 'getCharacteristic'
    && event.target === 'rx'
    && event.result === 'ok'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage'
    && event.stage === 'getCharacteristic'
    && event.target === 'tx'
    && event.result === 'ok'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage' && event.stage === 'startNotifications' && event.result === 'ok'
  )), true);
});

test('connectBle emits connect-stage failure telemetry when getPrimaryService fails', async () => {
  __resetBleForTest();
  const logged = [];
  setBleVerboseDebug(true);
  setBleDebugLogger((...args) => logged.push(args));

  const server = {
    connected: true,
    getPrimaryService: async () => {
      throw new Error('missing_service');
    }
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  await assert.rejects(async () => {
    await connectBle({ navigatorLike });
  }, /missing_service/);

  const events = telemetryEvents(logged);
  assert.equal(events.some((event) => (
    event.evt === 'ble.connect.stage'
    && event.stage === 'getPrimaryService'
    && event.result === 'fail'
    && event.error === 'missing_service'
  )), true);
});

test('postEvent fails when BLE transport is unavailable', async () => {
  __resetBleForTest();
  const ok = await postEvent({ type: 'busy.changed', busy: true });
  assert.equal(ok, false);
});

test('postEvent emits tx fallback telemetry and withResponse failure telemetry', async () => {
  __resetBleForTest();
  const logged = [];
  setBleVerboseDebug(true);
  setBleDebugLogger((...args) => logged.push(args));

  const rx = {
    writeValueWithoutResponse: async () => {
      throw new Error('wr_no_rsp_fail');
    },
    writeValueWithResponse: async () => {
      throw new Error('wr_rsp_fail');
    }
  };
  const tx = {
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx)
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);

  const ok = await postEvent({ type: 'state.request' }, { traceId: 'trace-1' });
  assert.equal(ok, false);

  const events = telemetryEvents(logged);
  assert.equal(events.some((event) => (
    event.evt === 'ble.tx'
    && event.op === 'writeValueWithoutResponse'
    && event.result === 'attempt'
    && event.trace_id === 'trace-1'
    && event.payload_type === 'state.request'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.tx'
    && event.op === 'writeValueWithoutResponse'
    && event.result === 'fallback'
    && event.trace_id === 'trace-1'
    && event.payload_type === 'state.request'
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.tx'
    && event.op === 'writeValueWithResponse'
    && event.result === 'fail'
    && event.trace_id === 'trace-1'
    && event.payload_type === 'state.request'
  )), true);
});

test('postBinary emits tx telemetry with binary payload type', async () => {
  __resetBleForTest();
  const logged = [];
  setBleVerboseDebug(true);
  setBleDebugLogger((...args) => logged.push(args));

  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const tx = {
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx)
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);
  const ok = await postBinary(Uint8Array.from([1, 2, 3]), { traceId: 'trace-bin-1' });
  assert.equal(ok, true);

  const events = telemetryEvents(logged);
  assert.equal(events.some((event) => (
    event.evt === 'ble.tx'
    && event.op === 'writeValueWithoutResponse'
    && event.result === 'attempt'
    && event.trace_id === 'trace-bin-1'
    && event.payload_type === 'binary'
    && event.bytes === 3
  )), true);
  assert.equal(events.some((event) => (
    event.evt === 'ble.tx'
    && event.op === 'writeValueWithoutResponse'
    && event.result === 'ok'
    && event.trace_id === 'trace-bin-1'
    && event.payload_type === 'binary'
    && event.bytes === 3
  )), true);
});

test('postEvent keeps control payload as one JSON line across BLE writes', async () => {
  __resetBleForTest();
  const writes = [];
  const rx = {
    writeValueWithoutResponse: async (value) => {
      writes.push(new Uint8Array(value));
    }
  };
  const tx = {
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx)
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);

  const bigTabs = [];
  for (let i = 0; i < 60; i += 1) {
    bigTabs.push({ id: i + 1, window_id: 1, active: i === 0, title: `Tab ${i}`, url: `https://example.com/${i}` });
  }
  const ok = await postEvent({ type: 'tabs.list', request_id: 'tabs-big-1', tabs: bigTabs }, { traceId: 'trace-big-1' });
  assert.equal(ok, true);
  assert.equal(writes.length > 1, true);

  const total = writes.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of writes) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  const mergedText = new TextDecoder().decode(merged);
  assert.equal(merged[merged.length - 1], 10); // '\n'
  assert.equal(mergedText.includes('"type":"tabs.list"'), true);
  assert.equal(mergedText.includes('"request_id":"tabs-big-1"'), true);
});

test('disconnectBle clears connected device metadata', async () => {
  __resetBleForTest();
  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const service = {
    getCharacteristic: async () => rx
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const gatt = {
    connected: true,
    connect: async () => server,
    disconnect: () => {
      gatt.connected = false;
    }
  };
  const device = {
    id: 'dev-1',
    name: 'air-kvm-ctrl-cb01',
    gatt,
    addEventListener: () => {}
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({ navigatorLike });
  assert.equal(connected, true);
  assert.equal(getConnectedDeviceInfo().id, 'dev-1');
  disconnectBle();
  assert.deepEqual(getConnectedDeviceInfo(), { id: null, name: null, connected: false });
});

test('connectBle invokes onDisconnect callback on gatt disconnection', async () => {
  __resetBleForTest();
  let disconnectHandler = null;
  let disconnectCalls = 0;
  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const tx = {
    addEventListener: () => {},
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx)
  };
  const server = {
    connected: true,
    getPrimaryService: async () => service
  };
  const device = {
    gatt: { connected: true, connect: async () => server },
    addEventListener: (event, handler) => {
      if (event === 'gattserverdisconnected') {
        disconnectHandler = handler;
      }
    }
  };
  const navigatorLike = {
    bluetooth: {
      requestDevice: async () => device
    }
  };

  const connected = await connectBle({
    navigatorLike,
    onDisconnect: () => {
      disconnectCalls += 1;
    }
  });
  assert.equal(connected, true);
  assert.equal(typeof disconnectHandler, 'function');
  disconnectHandler();
  assert.equal(disconnectCalls, 1);
});
