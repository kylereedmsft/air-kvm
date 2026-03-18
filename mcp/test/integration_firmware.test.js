/**
 * MCP → Firmware integration tests.
 *
 * Requires hardware flashed and connected via UART.
 * Run with: AIRKVM_INTEGRATION=1 [AIRKVM_SERIAL_PORT=...] node --test test/integration_firmware.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { UartTransport } from '../src/uart.js';
import { getTool } from '../src/protocol.js';
import { kTarget } from '../../shared/binary_frame.js';

const RUN = !!process.env.AIRKVM_INTEGRATION;
const SKIP = RUN ? false : 'set AIRKVM_INTEGRATION=1 to run';
const PORT = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';

const itest = (name, fn) => test(name, { skip: SKIP }, fn);

// Temporarily capture the next inbound CONTROL message, bypassing _pending.
// Safe in sequential test code; always restores the transport's handler.
function captureNextControl(transport, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const restore = () => transport.halfpipe.onControl((msg) => transport._handleControl(msg));
    const timer = setTimeout(() => { restore(); reject(new Error('capture_timeout')); }, timeoutMs);
    transport.halfpipe.onControl((msg) => {
      clearTimeout(timer);
      restore();
      resolve(msg);
    });
  });
}

let transport;

test.before(async () => {
  if (!RUN) return;
  transport = new UartTransport({
    portPath: PORT,
    commandTimeoutMs: 5000,
    debug: !!process.env.AIRKVM_UART_DEBUG,
  });
  await transport.open();
});

test.after(async () => {
  transport?.close();
});

// -- FW tools ----------------------------------------------------------------

itest('fw_version_request returns version string', async () => {
  const t = getTool('airkvm_fw_version_request');
  const result = await transport.send(t.build(), t);
  assert.equal(result.data.type, 'fw.version');
  assert.equal(typeof result.data.version, 'string');
  assert.ok(result.data.version.length > 0);
  assert.equal(typeof result.data.built_at, 'string');
});

itest('state_request returns state with busy flag', async () => {
  const t = getTool('airkvm_state_request');
  const result = await transport.send(t.build(), t);
  assert.equal(result.data.type, 'state');
  assert.equal(typeof result.data.busy, 'boolean');
});

itest('state_set busy=true then busy=false roundtrips correctly', async () => {
  const t = getTool('airkvm_state_set');
  const stateReq = getTool('airkvm_state_request');

  const setTrue = await transport.send(t.build({ busy: true }), t);
  assert.equal(setTrue.ok, true);

  const stateAfterTrue = await transport.send(stateReq.build(), stateReq);
  assert.equal(stateAfterTrue.data.busy, true);

  const setFalse = await transport.send(t.build({ busy: false }), t);
  assert.equal(setFalse.ok, true);

  const stateAfterFalse = await transport.send(stateReq.build(), stateReq);
  assert.equal(stateAfterFalse.data.busy, false);
});

// -- HID tools ---------------------------------------------------------------

itest('mouse_move_rel returns ok', async () => {
  const t = getTool('airkvm_mouse_move_rel');
  const result = await transport.send(t.build({ dx: 0, dy: 0 }), t);
  assert.equal(result.ok, true);
});

itest('mouse_move_abs returns ok', async () => {
  const t = getTool('airkvm_mouse_move_abs');
  const result = await transport.send(t.build({ x: 0, y: 0 }), t);
  assert.equal(result.ok, true);
});

itest('mouse_scroll returns ok', async () => {
  const t = getTool('airkvm_mouse_scroll');
  const result = await transport.send(t.build({ dy: -1 }), t);
  assert.equal(result.ok, true);
});

itest('mouse_click returns ok', async () => {
  const t = getTool('airkvm_mouse_click');
  const result = await transport.send(t.build({ button: 'left' }), t);
  assert.equal(result.ok, true);
});

itest('key_tap returns ok', async () => {
  const t = getTool('airkvm_key_tap');
  // Use a safe navigation key that has no visible side effect when focus is unknown
  const result = await transport.send(t.build({ key: 'ArrowRight' }), t);
  assert.equal(result.ok, true);
});

// -- Routing error cases: wrong frame type for target ------------------------

itest('CHUNK frame to FW target is NACKed', async () => {
  await assert.rejects(
    () => transport.halfpipe.send({ type: 'fw.version.request' }, kTarget.FW),
    /nack/
  );
});

itest('CHUNK frame to HID target is NACKed', async () => {
  await assert.rejects(
    () => transport.halfpipe.send({ type: 'mouse.click', button: 'left' }, kTarget.HID),
    /nack/
  );
});

itest('CHUNK frame to MCP target (invalid) is NACKed', async () => {
  await assert.rejects(
    () => transport.halfpipe.send({ type: 'anything' }, kTarget.MCP),
    /nack/
  );
});

// -- CONTROL parse errors: firmware returns invalid_command ------------------

itest('CONTROL to FW with no type field returns invalid_command', async () => {
  const capture = captureNextControl(transport);
  await transport.halfpipe.sendControl({ not_a_type: true }, kTarget.FW);
  const msg = await capture;
  assert.equal(msg.ok, false);
  assert.equal(msg.error, 'invalid_command');
});

itest('CONTROL to FW with unknown type returns invalid_command', async () => {
  const capture = captureNextControl(transport);
  await transport.halfpipe.sendControl({ type: 'bogus.command' }, kTarget.FW);
  const msg = await capture;
  assert.equal(msg.ok, false);
  assert.equal(msg.error, 'invalid_command');
});

itest('CONTROL to HID with unknown type returns invalid_command', async () => {
  const capture = captureNextControl(transport);
  await transport.halfpipe.sendControl({ type: 'bogus.hid.command' }, kTarget.HID);
  const msg = await capture;
  assert.equal(msg.ok, false);
  assert.equal(msg.error, 'invalid_command');
});

// -- HID command_rejected: valid command, firmware rejects the value ---------

itest('key_tap with unrecognized key returns command_rejected', async () => {
  const t = getTool('airkvm_key_tap');
  const result = await transport.send(t.build({ key: 'NotARealKey' }), t);
  assert.equal(result.ok, false);
  assert.equal(result.data.error, 'command_rejected');
});

itest('mouse_click with invalid button returns command_rejected', async () => {
  const t = getTool('airkvm_mouse_click');
  const result = await transport.send(t.build({ button: 'bogus_button' }), t);
  assert.equal(result.ok, false);
  assert.equal(result.data.error, 'command_rejected');
});

// -- RESET frame recovery ----------------------------------------------------

itest('RESET frame clears parser state; firmware responds normally after', async () => {
  await transport.halfpipe.reset();
  // Firmware must still handle commands correctly after a RESET
  const t = getTool('airkvm_fw_version_request');
  const result = await transport.send(t.build(), t);
  assert.equal(result.data.type, 'fw.version');
});

// -- EXTENSION target routing ------------------------------------------------

// EXTENSION forwarding cannot be verified from the UART side alone — the
// firmware silently forwards the frame to BLE with no UART response, and
// HalfPipe discards NACKs that arrive without a pending chunk. Verifying
// this path requires a BLE receiver (extension) to be connected.

