import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeHarness(sendImpl) {
  const sent = [];
  const transport = { send: sendImpl };
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
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('screenshot via transport.send returns base64 payload', async () => {
  const fakeBase64 = Buffer.from('fakeImageData').toString('base64');
  const { sent, server } = makeHarness(async () => ({
    type: 'screenshot.response',
    request_id: 'shot-stream-1',
    source: 'tab',
    data: fakeBase64,
    mime: 'image/jpeg',
  }));

  await callScreenshotTool(server, 'shot-stream-1', { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, undefined);
  assert.equal(payload.request_id, 'shot-stream-1');
  assert.equal(payload.base64, fakeBase64);
  assert.equal(payload.mime, 'image/jpeg');
});

test('screenshot transport timeout surfaces as transport_error', async () => {
  const { sent, server } = makeHarness(async () => {
    throw new Error('device_timeout');
  });

  await callScreenshotTool(server, 'shot-timeout-1', { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, 'shot-timeout-1');
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('screenshot.error is surfaced as structured tool error', async () => {
  const { sent, server } = makeHarness(async () => ({
    type: 'screenshot.error',
    request_id: 'shot-err-1',
    source: 'tab',
    ok: false,
    error: 'desktop_capture_denied',
  }));

  await callScreenshotTool(server, 'shot-err-1');
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.error, 'desktop_capture_denied');
});
