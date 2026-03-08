import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetBleForTest,
  connectBle,
  disconnectBle,
  getConnectedDeviceInfo,
  postEvent
} from '../src/bridge.js';

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

test('postEvent fails when BLE transport is unavailable', async () => {
  __resetBleForTest();
  const ok = await postEvent({ type: 'busy.changed', busy: true });
  assert.equal(ok, false);
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

test('connectBle reassembles ctrl.chunk notifications into one command', async () => {
  __resetBleForTest();
  let notifyHandler = null;
  const received = [];
  const rx = {
    writeValueWithoutResponse: async () => {}
  };
  const tx = {
    addEventListener: (_event, handler) => {
      notifyHandler = handler;
    },
    startNotifications: async () => {}
  };
  const service = {
    getCharacteristic: async (uuid) => (
      String(uuid).endsWith('03-b5a3-f393-e0a9-e50e24dccb01') ? tx : rx
    )
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

  const connected = await connectBle({
    navigatorLike,
    onCommand: (msg) => received.push(msg)
  });
  assert.equal(connected, true);
  assert.equal(typeof notifyHandler, 'function');

  const full = JSON.stringify({
    type: 'transfer.resume',
    request_id: 'r-1',
    transfer_id: 'tx_12345678',
    from_seq: 8
  });
  const frag0 = full.slice(0, Math.floor(full.length / 2));
  const frag1 = full.slice(Math.floor(full.length / 2));
  const chunk0 = `${JSON.stringify({ type: 'ctrl.chunk', chunk_id: 1, seq: 0, total: 2, frag: frag0 })}\n`;
  const chunk1 = `${JSON.stringify({ type: 'ctrl.chunk', chunk_id: 1, seq: 1, total: 2, frag: frag1 })}\n`;
  const encoder = new TextEncoder();

  notifyHandler({ target: { value: new DataView(encoder.encode(chunk0).buffer) } });
  notifyHandler({ target: { value: new DataView(encoder.encode(chunk1).buffer) } });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'transfer.resume');
  assert.equal(received[0].request_id, 'r-1');
  assert.equal(received[0].transfer_id, 'tx_12345678');
  assert.equal(received[0].from_seq, 8);
});
