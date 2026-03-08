import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandForTool,
  createResponseCollector,
  isKnownTool,
  isStructuredTool
} from '../src/tooling.js';
import { parseTransferId } from '../src/binary_frame.js';

test('buildCommandForTool maps screenshot tools to screenshot.request with bin encoding', () => {
  const tab = buildCommandForTool('airkvm_screenshot_tab', {
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123
  });
  const desktop = buildCommandForTool('airkvm_screenshot_desktop', { request_id: 'r2' });
  const desktopWithDelay = buildCommandForTool('airkvm_screenshot_desktop', {
    request_id: 'r3',
    desktop_delay_ms: 600
  });
  const tabs = buildCommandForTool('airkvm_list_tabs', { request_id: 't1' });

  assert.deepEqual(tab, {
    type: 'screenshot.request',
    source: 'tab',
    request_id: 'r1',
    max_width: 800,
    max_height: 450,
    quality: 0.5,
    max_chars: 70000,
    tab_id: 123,
    encoding: 'bin'
  });
  assert.deepEqual(desktop, { type: 'screenshot.request', source: 'desktop', request_id: 'r2', encoding: 'bin' });
  assert.deepEqual(desktopWithDelay, {
    type: 'screenshot.request',
    source: 'desktop',
    request_id: 'r3',
    desktop_delay_ms: 600,
    encoding: 'bin'
  });
  assert.deepEqual(tabs, { type: 'tabs.list.request', request_id: 't1' });
});

test('isKnownTool and isStructuredTool classify tools correctly', () => {
  assert.equal(isKnownTool('airkvm_send'), true);
  assert.equal(isKnownTool('airkvm_dom_snapshot'), true);
  assert.equal(isKnownTool('airkvm_list_tabs'), true);
  assert.equal(isKnownTool('nope'), false);
  assert.equal(isStructuredTool('airkvm_send'), false);
  assert.equal(isStructuredTool('airkvm_list_tabs'), true);
  assert.equal(isStructuredTool('airkvm_screenshot_tab'), true);
});

test('tabs list collector returns structured list payload', () => {
  const command = { type: 'tabs.list.request', request_id: 'tabs-1' };
  const collect = createResponseCollector('airkvm_list_tabs', command);
  const done = collect({
    type: 'tabs.list',
    request_id: 'tabs-1',
    tabs: [{ id: 10, title: 'Example', url: 'https://example.com' }]
  });
  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.request_id, 'tabs-1');
  assert.equal(done.data.tabs.length, 1);
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

test('binary screenshot collector reassembles transfer and emits done ack', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-transfer', encoding: 'bin' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);
  const transferId = 'tx_00000011';
  const transferIdNumeric = parseTransferId(transferId);

  assert.equal(collect({
    type: 'transfer.meta',
    request_id: 'shot-transfer',
    transfer_id: transferId,
    source: 'tab',
    mime: 'application/octet-stream',
    total_chunks: 2,
    total_bytes: 6
  }, { kind: 'ctrl' }, []), null);

  const gapNack = collect(
    null,
    { kind: 'bin', transfer_id: transferId, seq: 1, payload: Buffer.from('DEF') },
    []
  );
  assert.equal(gapNack.done, false);
  assert.equal(Array.isArray(gapNack.outbound), true);
  assert.equal(gapNack.outbound[0].type, 'transfer.nack');
  assert.equal(gapNack.outbound[0].seq, 0);

  assert.equal(
    collect(
      null,
      { kind: 'bin', transfer_id: transferId, seq: 0, payload: Buffer.from('ABC') },
      []
    ),
    null
  );

  const done = collect({
    type: 'transfer.done',
    request_id: 'shot-transfer',
    transfer_id: transferId,
    source: 'tab',
    total_chunks: 2
  }, { kind: 'ctrl' }, []);

  assert.equal(done.done, true);
  assert.equal(done.ok, true);
  assert.equal(done.data.base64, Buffer.from('ABCDEF').toString('base64'));
  assert.equal(Array.isArray(done.outbound), true);
  assert.equal(done.outbound[0].type, 'transfer.done.ack');
  assert.equal(done.outbound[0].transfer_id, transferId);
  assert.equal(transferIdNumeric, 0x11);
});

test('binary screenshot collector emits transfer.nack for bin errors', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-nack', encoding: 'bin' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  const out = collect(null, {
    kind: 'bin_error',
    transfer_id: 'tx_00000022',
    seq: 9,
    error: 'crc_mismatch'
  }, []);
  assert.equal(out.done, false);
  assert.equal(out.outbound[0].type, 'transfer.nack');
  assert.equal(out.outbound[0].transfer_id, 'tx_00000022');
  assert.equal(out.outbound[0].seq, 9);
});

test('binary screenshot collector timeout handler emits transfer.resume', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-resume', encoding: 'bin' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);
  const transferId = 'tx_00000033';

  collect({
    type: 'transfer.meta',
    request_id: 'shot-resume',
    transfer_id: transferId,
    source: 'tab',
    total_chunks: 3,
    total_bytes: 9
  }, { kind: 'ctrl' }, []);
  collect(null, { kind: 'bin', transfer_id: transferId, seq: 0, payload: Buffer.from('AAA') }, []);

  const timed = collect.onTimeout();
  assert.equal(timed.done, false);
  assert.equal(timed.outbound[0].type, 'transfer.resume');
  assert.equal(timed.outbound[0].transfer_id, transferId);
  assert.equal(timed.outbound[0].from_seq, 1);
});

test('screenshot collector returns structured error payload', () => {
  const command = { type: 'screenshot.request', source: 'desktop', request_id: 'shot-2', encoding: 'bin' };
  const collect = createResponseCollector('airkvm_screenshot_desktop', command);

  const done = collect({
    type: 'screenshot.error',
    request_id: 'shot-2',
    source: 'desktop',
    error: 'desktop_capture_denied'
  }, { kind: 'ctrl' }, []);

  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.request_id, 'shot-2');
  assert.equal(done.data.error, 'desktop_capture_denied');
});

test('transfer no_such_transfer surfaces structured error', () => {
  const command = { type: 'screenshot.request', source: 'tab', request_id: 'shot-no-such', encoding: 'bin' };
  const collect = createResponseCollector('airkvm_screenshot_tab', command);

  const done = collect({
    type: 'transfer.error',
    request_id: 'shot-no-such',
    source: 'tab',
    code: 'no_such_transfer',
    transfer_id: 'tx-gone'
  }, { kind: 'ctrl' }, []);

  assert.equal(done.done, true);
  assert.equal(done.ok, false);
  assert.equal(done.data.error, 'no_such_transfer');
});
