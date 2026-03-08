import test from 'node:test';
import assert from 'node:assert/strict';

import { dataUrlToMetaAndChunks, resolveScreenshotConfig } from '../src/screenshot_protocol.js';

test('resolveScreenshotConfig clamps and defaults values', () => {
  const cfg = resolveScreenshotConfig({
    max_width: 99999,
    max_height: 1,
    quality: 2,
    max_chars: 10
  });

  assert.equal(cfg.maxWidth, 1920);
  assert.equal(cfg.maxHeight, 120);
  assert.equal(cfg.jpegQuality, 0.9);
  assert.equal(cfg.maxBase64Chars, 20000);
  assert.equal(cfg.desktopDelayMs, 350);
});

test('resolveScreenshotConfig applies desktop_delay_ms bounds', () => {
  const low = resolveScreenshotConfig({ desktop_delay_ms: -10 });
  const high = resolveScreenshotConfig({ desktop_delay_ms: 99999 });
  const mid = resolveScreenshotConfig({ desktop_delay_ms: 800 });

  assert.equal(low.desktopDelayMs, 0);
  assert.equal(high.desktopDelayMs, 5000);
  assert.equal(mid.desktopDelayMs, 800);
});

test('dataUrlToMetaAndChunks emits compact keys and chunked payload', () => {
  const dataUrl = 'data:image/jpeg;base64,QUJDREVGR0hJSktM';
  const { meta, chunks } = dataUrlToMetaAndChunks(
    dataUrl,
    'r1',
    'tab',
    'tx_00000001',
    { encodedWidth: 640, encodedHeight: 360, encodedQuality: 0.55, attempts: 2 },
    4
  );

  assert.equal(meta.type, 'transfer.meta');
  assert.equal(meta.request_id, 'r1');
  assert.equal(meta.transfer_id, 'tx_00000001');
  assert.equal(meta.source, 'tab');
  assert.equal(meta.mime, 'image/jpeg');
  assert.equal(meta.encoding, 'bin');
  assert.equal(meta.chunk_size, 4);
  assert.equal(meta.total_chunks, 3);
  assert.equal(meta.total_bytes, 12);
  assert.equal(meta.total_chars, undefined);
  assert.equal(meta.encoded_width, undefined);
  assert.equal(meta.encoded_height, undefined);
  assert.equal(meta.encoded_quality, undefined);
  assert.equal(meta.encode_attempts, undefined);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].seq, 0);
  assert.equal(chunks[1].seq, 1);
  assert.equal(chunks[2].seq, 2);
  assert.equal(new TextDecoder().decode(chunks[0].bytes), 'ABCD');
  assert.equal(new TextDecoder().decode(chunks[1].bytes), 'EFGH');
  assert.equal(new TextDecoder().decode(chunks[2].bytes), 'IJKL');
});
