import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeStreamHarness(streamRequestImpl) {
  const sent = [];
  const transport = {
    sendCommand: async () => ({ ok: true, msg: { ok: true } }),
    sendCommandNoWait: async () => ({ ok: true }),
    streamRequest: streamRequestImpl,
  };
  const server = createServer({
    transport,
    send: (msg) => sent.push(msg),
  });
  return { sent, server };
}

async function callScreenshotTool(server, requestId, extraArgs = {}) {
  server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: requestId, ...extraArgs }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('screenshot via streamRequest returns base64 payload', async () => {
  const fakeBase64 = Buffer.from('fakeImageData').toString('base64');
  const { sent, server } = makeStreamHarness(async () => ({
    ok: true,
    data: {
      type: 'screenshot.response',
      request_id: 'shot-stream-1',
      source: 'tab',
      data: fakeBase64,
      mime: 'image/jpeg',
    },
  }));

  await callScreenshotTool(server, 'shot-stream-1', { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, undefined);
  assert.equal(payload.request_id, 'shot-stream-1');
  assert.equal(payload.base64, fakeBase64);
  assert.equal(payload.mime, 'image/jpeg');
});

test('screenshot streamRequest timeout surfaces as transport_error', async () => {
  const { sent, server } = makeStreamHarness(async () => {
    throw new Error('device_timeout');
  });

  await callScreenshotTool(server, 'shot-timeout-1', { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, 'shot-timeout-1');
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('screenshot.error via streamRequest is surfaced as structured tool error', async () => {
  const { sent, server } = makeStreamHarness(async () => ({
    ok: true,
    data: {
      type: 'screenshot.error',
      request_id: 'shot-err-1',
      source: 'tab',
      error: 'desktop_capture_denied',
    },
  }));

  await callScreenshotTool(server, 'shot-err-1');
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.error, 'desktop_capture_denied');
});

test('screenshot_tab errors when streamRequest is missing', async () => {
  const sent = [];
  const transport = {
    sendCommand: async () => ({ ok: true, msg: { ok: true } }),
  };
  const server = createServer({ transport, send: (msg) => sent.push(msg) });

  await callScreenshotTool(server, 'shot-no-stream');
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.error, 'stream_transport_required');
});
