import test from 'node:test';
import assert from 'node:assert/strict';

import { UartTransport } from '../src/uart.js';
import {
  encodeControlFrame,
  encodeLogFrame,
  encodeTransferChunkFrame,
} from '../src/binary_frame.js';
import { kSeqFinalBit } from '../src/stream.js';

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

test('waitForFrame resolves on matching collector frame', async () => {
  const transport = makeTestTransport(200);
  const pending = transport.waitForFrame((msg) => {
    if (msg?.type === 'transfer.ack' && msg?.transfer_id === 'tx-wait-1') {
      return { done: true, ok: true, data: { highest: msg.highest_contiguous_seq } };
    }
    return null;
  }, 200);

  setTimeout(() => {
    transport.onData(encodeControlFrame({
      type: 'transfer.ack',
      request_id: 'r1',
      transfer_id: 'tx-wait-1',
      highest_contiguous_seq: 7
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.highest, 7);
  transport.close();
});

// ---------------------------------------------------------------------------
// streamRequest tests
// ---------------------------------------------------------------------------

function makeWriteCapturingTransport(commandTimeoutMs = 200) {
  const writes = [];
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    baudRate: 115200,
    commandTimeoutMs,
  });
  transport.open = async function openStub() {
    this.opened = true;
    this.serialPort = {
      write: (line, cb) => {
        writes.push(Buffer.isBuffer(line) ? line : Buffer.from(String(line)));
        cb();
      },
      drain: (cb) => cb(),
      isOpen: false,
      close: (cb) => cb?.(),
    };
  };
  return { transport, writes };
}

test('streamRequest resolves when inline control message arrives', async () => {
  const { transport } = makeWriteCapturingTransport(200);
  const pending = transport.streamRequest(
    { type: 'tabs.list.request', request_id: 'tl-1' },
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    transport.onData(encodeControlFrame({
      type: 'tabs.list',
      request_id: 'tl-1',
      tabs: [{ id: 1, title: 'Tab One' }],
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.data.type, 'tabs.list');
  assert.equal(result.data.tabs.length, 1);
  transport.close();
});

test('streamRequest resolves when chunked binary transfer completes', async () => {
  const { transport, writes } = makeWriteCapturingTransport(300);
  const pending = transport.streamRequest(
    { type: 'dom.snapshot.request', request_id: 'ds-1' },
    { timeoutMs: 300 }
  );

  // Simulate extension sending a chunked response through firmware.
  const responseObj = { type: 'dom.snapshot', request_id: 'ds-1', html: '<h1>hi</h1>' };
  const json = JSON.stringify(responseObj);
  const bytes = Buffer.from(json, 'utf8');
  const chunkSize = 20;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const transferId = 0x12345678;

  setTimeout(() => {
    for (let i = 0; i < totalChunks; i += 1) {
      const start = i * chunkSize;
      const end = Math.min(bytes.length, start + chunkSize);
      const isFinalChunk = i === totalChunks - 1;
      const frame = encodeTransferChunkFrame({
        transferId,
        seq: isFinalChunk ? ((kSeqFinalBit | i) >>> 0) : i,
        payload: bytes.subarray(start, end),
      });
      transport.onData(frame);
    }
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, responseObj);

  // StreamReceiver should have sent acks back via writeRawCommand.
  const ackWrites = writes.filter((w) => {
    const s = w.toString();
    return s.includes('"stream.ack"');
  });
  assert.ok(ackWrites.length >= 1, 'should have sent ack(s) back');
  transport.close();
});

test('streamRequest rejects on timeout when no frames arrive', async () => {
  const { transport } = makeWriteCapturingTransport(30);
  await assert.rejects(
    () => transport.streamRequest(
      { type: 'dom.snapshot.request', request_id: 'ds-timeout' },
      { timeoutMs: 30 }
    ),
    /device_timeout/
  );
  transport.close();
});

test('streamRequest rejects on stream error (invalid JSON reassembly)', async () => {
  const { transport } = makeWriteCapturingTransport(200);
  const pending = transport.streamRequest(
    { type: 'dom.snapshot.request', request_id: 'ds-bad' },
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    const badPayload = Buffer.from('this is not valid JSON {{{', 'utf8');
    const frame = encodeTransferChunkFrame({
      transferId: 0xAABBCCDD,
      seq: (kSeqFinalBit | 0) >>> 0,
      payload: badPayload,
    });
    transport.onData(frame);
  }, 10);

  await assert.rejects(pending, /stream_error:json_parse_failed/);
  transport.close();
});

test('streamRequest timer resets on each frame (progress keeps it alive)', async () => {
  const { transport } = makeWriteCapturingTransport(80);
  const pending = transport.streamRequest(
    { type: 'dom.snapshot.request', request_id: 'ds-slow' },
    { timeoutMs: 80 }
  );

  const responseObj = { type: 'dom.snapshot', request_id: 'ds-slow', data: 'ok' };
  const bytes = Buffer.from(JSON.stringify(responseObj), 'utf8');
  const chunkSize = 10;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const transferId = 0x55667788;

  // Send chunks slowly — each one should reset the timeout.
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * chunkSize;
    const end = Math.min(bytes.length, start + chunkSize);
    const isFinal = i === totalChunks - 1;
    setTimeout(() => {
      transport.onData(encodeTransferChunkFrame({
        transferId,
        seq: isFinal ? ((kSeqFinalBit | i) >>> 0) : i,
        payload: bytes.subarray(start, end),
      }));
    }, 20 + i * 40);
  }

  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, responseObj);
  transport.close();
});

test('streamRequest ignores log frames without error', async () => {
  const { transport } = makeWriteCapturingTransport(200);
  const pending = transport.streamRequest(
    { type: 'tabs.list.request', request_id: 'tl-log' },
    { timeoutMs: 200 }
  );

  setTimeout(() => {
    // Log frame should be ignored, not crash.
    transport.onData(encodeLogFrame('rx.ble some_log_message'));
    // Then the real response arrives.
    transport.onData(encodeControlFrame({
      type: 'tabs.list',
      request_id: 'tl-log',
      tabs: [],
    }));
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.tabs, []);
  transport.close();
});
