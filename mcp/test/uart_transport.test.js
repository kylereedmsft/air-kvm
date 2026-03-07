import test from 'node:test';
import assert from 'node:assert/strict';

import { UartTransport } from '../src/uart.js';

function makeTestTransport(commandTimeoutMs = 100) {
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    baudRate: 115200,
    commandTimeoutMs
  });

  transport.open = async function openStub() {
    this.opened = true;
    this.serialPort = {
      write: (_line, cb) => cb(),
      drain: (cb) => cb(),
      isOpen: false,
      close: (cb) => cb?.()
    };
  };

  return transport;
}

test('sendCommand resolves when ctrl ack is received', async () => {
  const transport = makeTestTransport(200);
  const pending = transport.sendCommand({ type: 'state.request' });

  setTimeout(() => {
    transport.onData(Buffer.from('{"ch":"ctrl","msg":{"ok":true}}\n', 'utf8'));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.msg, { ok: true });
  transport.close();
});

test('sendCommand resolves state.request when state frame arrives before ack', async () => {
  const transport = makeTestTransport(200);
  const pending = transport.sendCommand({ type: 'state.request' });

  setTimeout(() => {
    transport.onData(Buffer.from('{"ch":"ctrl","msg":{"type":"state","busy":false}}\n', 'utf8'));
  }, 10);

  const result = await pending;
  assert.equal(result.msg.type, 'state');
  assert.equal(result.msg.busy, false);
  transport.close();
});

test('sendCommand times out when device does not respond', async () => {
  const transport = makeTestTransport(20);
  await assert.rejects(
    () => transport.sendCommand({ type: 'state.request' }),
    /device_timeout/
  );
  transport.close();
});

test('sendCommand with collector ignores generic ack and resolves on matching payload', async () => {
  const transport = makeTestTransport(200);
  const requestId = 'req-test-1';
  const pending = transport.sendCommand(
    { type: 'dom.snapshot.request', request_id: requestId },
    (msg) => {
      if (msg.type === 'dom.snapshot' && msg.request_id === requestId) {
        return { done: true, ok: true, data: { request_id: requestId, snapshot: msg } };
      }
      return null;
    }
  );

  setTimeout(() => {
    transport.onData(Buffer.from('{"ch":"ctrl","msg":{"ok":true}}\n', 'utf8'));
    transport.onData(Buffer.from('{"ch":"ctrl","msg":{"type":"dom.snapshot","request_id":"req-test-1","summary":{"title":"x"}}}\n', 'utf8'));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.request_id, requestId);
  assert.equal(result.data.snapshot.type, 'dom.snapshot');
  transport.close();
});
