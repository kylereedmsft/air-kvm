import test from 'node:test';
import assert from 'node:assert/strict';

import { UartTransport } from '../src/uart.js';
import { encodeControlFrame, encodeLogFrame } from '../src/binary_frame.js';

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
    transport.onData(encodeControlFrame({ ok: true }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.msg, { ok: true });
  transport.close();
});

test('sendCommand resolves when framed ctrl ack is received', async () => {
  const transport = makeTestTransport(200);
  const pending = transport.sendCommand({ type: 'state.request' });

  setTimeout(() => {
    transport.onData(encodeControlFrame({ ok: true }));
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
    transport.onData(encodeControlFrame({ type: 'state', busy: false }));
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
    transport.onData(encodeControlFrame({ ok: true }));
    transport.onData(encodeControlFrame({
      type: 'dom.snapshot',
      request_id: 'req-test-1',
      summary: { title: 'x' }
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.request_id, requestId);
  assert.equal(result.data.snapshot.type, 'dom.snapshot');
  transport.close();
});

test('sendCommand ignores framed log and resolves on framed ctrl payload', async () => {
  const transport = makeTestTransport(200);
  const requestId = 'req-framed-1';
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
    transport.onData(encodeLogFrame('rx.ble something'));
    transport.onData(encodeControlFrame({
      type: 'dom.snapshot',
      request_id: 'req-framed-1',
      summary: { title: 'framed' }
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.request_id, requestId);
  assert.equal(result.data.snapshot.summary.title, 'framed');
  transport.close();
});

test('sendCommand forwards collector outbound commands and completes', async () => {
  const writes = [];
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    baudRate: 115200,
    commandTimeoutMs: 200
  });
  transport.open = async function openStub() {
    this.opened = true;
    this.serialPort = {
      write: (line, cb) => {
        writes.push(String(line).trim());
        cb();
      },
      drain: (cb) => cb(),
      isOpen: false,
      close: (cb) => cb?.()
    };
  };

  const pending = transport.sendCommand(
    { type: 'screenshot.request', request_id: 'r-out', source: 'tab' },
    (msg) => {
      if (msg.type === 'transfer.chunk') {
        return {
          done: false,
          outbound: [{ type: 'transfer.ack', request_id: 'r-out', transfer_id: 'tx-1', highest_contiguous_seq: 0 }],
          extendTimeoutMs: 200
        };
      }
      if (msg.type === 'transfer.done') {
        return { done: true, ok: true, data: { request_id: 'r-out' } };
      }
      return null;
    }
  );

  setTimeout(() => {
    transport.onData(encodeControlFrame({
      type: 'transfer.chunk',
      request_id: 'r-out',
      transfer_id: 'tx-1',
      seq: 0,
      data: 'AAA'
    }));
    transport.onData(encodeControlFrame({
      type: 'transfer.done',
      request_id: 'r-out',
      transfer_id: 'tx-1'
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.request_id, 'r-out');
  assert.equal(writes.some((line) => line.includes('"type":"transfer.ack"')), true);
  transport.close();
});
