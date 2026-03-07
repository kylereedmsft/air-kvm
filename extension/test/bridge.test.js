import test from 'node:test';
import assert from 'node:assert/strict';

import { __resetBleForTest, connectBle, postEvent } from '../src/bridge.js';

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
  assert.deepEqual(requested.filters, [{ services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] }]);
  assert.equal(writes.length, 1);
});

test('postEvent fails when BLE transport is unavailable', async () => {
  __resetBleForTest();
  const ok = await postEvent({ type: 'busy.changed', busy: true });
  assert.equal(ok, false);
});
