import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeServerHarnessWithFrames(framesByRequest = {}) {
  const sent = [];
  const transport = {
    async sendCommand(command, collector) {
      const key = command.request_id;
      const frames = framesByRequest[key] || [];
      for (const msg of frames) {
        const collected = collector ? collector(msg, { kind: 'ctrl', msg }, []) : null;
        if (collected?.done) {
          return {
            ok: typeof collected.ok === 'boolean' ? collected.ok : true,
            data: collected.data,
            msg: collected.msg ?? msg
          };
        }
      }
      throw new Error('device_timeout');
    }
  };

  const server = createServer({
    transport,
    send: (msg) => sent.push(msg)
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

test('reassembles large out-of-order screenshot stream', async () => {
  const requestId = 'shot-large-1';
  const chunkCount = 600;
  const chunks = [];
  const parts = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const d = String(i).padStart(4, '0');
    parts.push(d);
    chunks.push({ type: 'screenshot.chunk', rid: requestId, src: 'tab', q: i, d });
  }
  const frames = [
    { type: 'screenshot.meta', rid: requestId, src: 'tab', m: 'image/jpeg', tc: chunkCount, tch: parts.join('').length },
    ...chunks.reverse()
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId, { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, undefined);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.total_chunks, chunkCount);
  assert.equal(payload.base64, parts.join(''));
});

test('missing screenshot chunk results in structured transport timeout error', async () => {
  const requestId = 'shot-missing-1';
  const frames = [
    { type: 'screenshot.meta', rid: requestId, src: 'tab', m: 'image/jpeg', tc: 3, tch: 9 },
    { type: 'screenshot.chunk', rid: requestId, src: 'tab', q: 0, d: 'AAA' },
    { type: 'screenshot.chunk', rid: requestId, src: 'tab', q: 2, d: 'CCC' }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId, { max_chars: 200000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.error, 'transport_error');
  assert.equal(payload.detail, 'device_timeout');
});

test('oversized screenshot stream is rejected with structured size error', async () => {
  const requestId = 'shot-oversize-1';
  const frames = [
    { type: 'screenshot.meta', rid: requestId, src: 'tab', m: 'image/jpeg', tc: 1, tch: 90001 },
    { type: 'screenshot.chunk', rid: requestId, src: 'tab', q: 0, d: 'A'.repeat(90001) }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId, { max_chars: 90000 });
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.error, 'screenshot_response_too_large');
});

test('explicit screenshot.error is surfaced as structured tool error', async () => {
  const requestId = 'shot-error-1';
  const frames = [
    { type: 'screenshot.error', rid: requestId, src: 'tab', e: 'desktop_capture_denied' }
  ];
  const { sent, server } = makeServerHarnessWithFrames({ [requestId]: frames });

  await callScreenshotTool(server, requestId);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(sent[0].isError, true);
  assert.equal(payload.request_id, requestId);
  assert.equal(payload.error, 'desktop_capture_denied');
});

