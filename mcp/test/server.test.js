import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

function makeHarness(sendCommandImpl) {
  const sent = [];
  const transport = {
    sendCommand: sendCommandImpl || (async () => ({ ok: true, msg: { ok: true } }))
  };
  const server = createServer({
    transport,
    send: (msg) => sent.push(msg)
  });
  return { sent, server };
}

test('tools/list includes structured tools', () => {
  const { sent, server } = makeHarness();
  server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(sent.length, 1);
  const names = sent[0].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'airkvm_send',
    'airkvm_dom_snapshot',
    'airkvm_screenshot_tab',
    'airkvm_screenshot_desktop'
  ]);
});

test('airkvm_dom_snapshot returns structured json content', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: true,
    data: {
      request_id: 'dom-1',
      snapshot: { type: 'dom.snapshot', request_id: 'dom-1', summary: { title: 'Example' } }
    }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'airkvm_dom_snapshot',
      arguments: { request_id: 'dom-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'dom-1');
  assert.equal(payload.snapshot.type, 'dom.snapshot');
});

test('airkvm_screenshot_tab returns structured error result on failure', async () => {
  const { sent, server } = makeHarness(async () => ({
    ok: false,
    data: { request_id: 'shot-1', source: 'tab', error: 'permission_denied' }
  }));

  server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'airkvm_screenshot_tab',
      arguments: { request_id: 'shot-1' }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0].isError, true);
  const payload = JSON.parse(sent[0].result.content[0].text);
  assert.equal(payload.request_id, 'shot-1');
  assert.equal(payload.error, 'permission_denied');
});

