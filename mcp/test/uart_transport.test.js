import test from 'node:test';
import assert from 'node:assert/strict';

import { UartTransport } from '../src/uart.js';
import {
  encodeControlFrameV2,
  encodeLogFrameV2,
  encodeChunkFrame,
  encodeAckFrame,
  kFrameType,
} from '../src/binary_frame.js';

function makeTestTransport(commandTimeoutMs = 100) {
  const writes = [];
  const transport = new UartTransport({
    portPath: 'TEST_PORT',
    baudRate: 115200,
    commandTimeoutMs
  });

  transport.open = async function openStub() {
    this.opened = true;
    this.serialPort = {
      write: (data, cb) => {
        writes.push(data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data)));
        cb();
      },
      drain: (cb) => cb(),
      isOpen: false,
      close: (cb) => cb?.()
    };
    if (!this.halfpipe) {
      const { HalfPipe } = await import('../src/halfpipe.js');
      this.halfpipe = new HalfPipe({
        writeFn: async (frameBytes) => {
          await new Promise((resolve, reject) => {
            this.serialPort.write(frameBytes, (err) => {
              if (err) reject(err);
              else this.serialPort.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
            });
          });
        },
        log: () => {},
      });
    }
  };

  return { transport, writes };
}

test('onData routes valid v2 frame to halfpipe', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onFrame = (frame) => received.push(frame);

  const frame = encodeControlFrameV2({ ok: true, type: 'state' });
  transport.onData(frame);

  assert.equal(received.length, 1);
  assert.equal(received[0].type, kFrameType.CONTROL);
  transport.close();
});

test('onData skips non-magic bytes', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onFrame = (frame) => received.push(frame);

  const garbage = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
  const frame = encodeControlFrameV2({ ok: true });
  transport.onData(Buffer.concat([garbage, frame]));

  assert.equal(received.length, 1);
  assert.equal(received[0].type, kFrameType.CONTROL);
  transport.close();
});

test('onData handles corrupted frame (bad CRC)', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onFrame = (frame) => received.push(frame);

  const frame = encodeControlFrameV2({ ok: true });
  const corrupted = Buffer.from(frame);
  corrupted[8] ^= 0xff; // corrupt payload byte
  transport.onData(corrupted);

  // Corrupted frame should be consumed but not routed
  assert.equal(received.length, 0);
  assert.equal(transport.readBuffer.length, 0);
  transport.close();
});

test('onData handles incomplete frame (waits for more data)', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const received = [];
  transport.halfpipe.onFrame = (frame) => received.push(frame);

  const frame = encodeControlFrameV2({ ok: true });
  const half1 = frame.subarray(0, 6);
  const half2 = frame.subarray(6);

  transport.onData(half1);
  assert.equal(received.length, 0);

  transport.onData(half2);
  assert.equal(received.length, 1);
  transport.close();
});

test('sendRequest sends via halfpipe and resolves on response', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  const pending = transport.sendRequest(
    { type: 'tabs.list.request', request_id: 'tl-1' },
    { timeoutMs: 200 }
  );

  // Simulate response arriving via halfpipe
  setTimeout(() => {
    const response = { type: 'tabs.list', request_id: 'tl-1', tabs: [{ id: 1 }] };
    // Trigger the halfpipe message callback
    transport.halfpipe._messageHandler(response);
  }, 10);

  const result = await pending;
  assert.equal(result.type, 'tabs.list');
  assert.equal(result.tabs.length, 1);
  transport.close();
});

test('sendRequest times out correctly', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  await assert.rejects(
    () => transport.sendRequest(
      { type: 'tabs.list.request', request_id: 'tl-timeout' },
      { timeoutMs: 30 }
    ),
    /device_timeout/
  );
  transport.close();
});

test('sendControlCommand sends AK control frame and resolves', async () => {
  const { transport, writes } = makeTestTransport();
  await transport.open();

  const pending = transport.sendControlCommand(
    { type: 'state.request' },
    { timeoutMs: 200 }
  );

  // Simulate firmware control response via halfpipe
  setTimeout(() => {
    transport.halfpipe._controlHandler({ ok: true, type: 'state', busy: false });
  }, 10);

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.msg.type, 'state');

  // Verify a binary frame was written (not JSON text)
  assert.ok(writes.length >= 1);
  assert.equal(writes[0][0], 0x41); // 'A'
  assert.equal(writes[0][1], 0x4b); // 'K'
  transport.close();
});

test('sendControlCommand times out correctly', async () => {
  const { transport } = makeTestTransport();
  await transport.open();

  await assert.rejects(
    () => transport.sendControlCommand(
      { type: 'state.request' },
      { timeoutMs: 30 }
    ),
    /device_timeout/
  );
  transport.close();
});

test('close cleans up halfpipe', async () => {
  const { transport } = makeTestTransport();
  await transport.open();
  assert.ok(transport.halfpipe);
  transport.close();
  assert.equal(transport.halfpipe, null);
  assert.equal(transport.opened, false);
});
