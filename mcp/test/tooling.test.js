import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool
} from '../src/tooling.js';

test('buildCommandForTool maps screenshot tools to screenshot.request', () => {
  const tab = buildCommandForTool('airkvm_screenshot_tab', {
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000
  });
  const desktop = buildCommandForTool('airkvm_screenshot_desktop', { request_id: 'r2' });

  assert.deepEqual(tab, {
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2' });
});

test('isKnownTool and isStructuredTool classify tools correctly', () => {
  assert.equal(isKnownTool('airkvm_send'), true);
  assert.equal(isKnownTool('airkvm_dom_snapshot'), true);
  assert.equal(isKnownTool('nope'), false);
  assert.equal(isStructuredTool('airkvm_send'), false);
  assert.equal(isStructuredTool('airkvm_screenshot_tab'), true);
});

test('dom snapshot collector returns structured success payload', () => {
  const command = { type: 'dom.snapshot.request', request_id: 'dom-1' };
  const collect = createResponseCollector('airkvm_dom_snapshot', command);

  const ignored = collect({ type: 'dom.snapshot', request_id: 'other' });
  assert.equal(ignored, null);

  const done = collect({ type: 'dom.snapshot', request_id: 'dom-1', summary: { title: 'T' } });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'dom-1');
  assert.equal(done.data.snapshot.type, 'dom.snapshot');
});

test('screenshot collector reassembles chunks in sequence order', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-1' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  assert.equal(collect({ type: 'screenshot.meta', request_id: 'shot-1', source: 'tab', mime: 'image/png', total_chunks: 2, total_chars: 6 }), null);
  assert.equal(collect({ type: 'screenshot.chunk', request_id: 'shot-1', source: 'tab', seq: 1, data: 'DEF' }), null);
  const done = collect({ type: 'screenshot.chunk', request_id: 'shot-1', source: 'tab', seq: 0, data: 'ABC' });

  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'shot-1');
  assert.equal(done.data.base64, 'ABCDEF');
  assert.equal(done.data.total_chunks, 2);
});

test('screenshot collector returns structured error payload', () => {
  const command = { type: 'screenshot.request', source: 'desktop', request_id: 'shot-2' };
  const collect = createResponseCollector('airkvm_screenshot_desktop', command);

  const done = collect({
    type: 'screenshot.error',
    request_id: 'shot-2',
    source: 'desktop',
    error: 'desktop_capture_denied'
  });

  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.request_id, 'shot-2');
  assert.equal(done.data.error, 'desktop_capture_denied');
});
