const UART_SERVICE_UUID = '6e400101-b5a3-f393-e0a9-e50e24dccb01';
const UART_RX_CHAR_UUID = '6e400102-b5a3-f393-e0a9-e50e24dccb01';
const UART_TX_CHAR_UUID = '6e400103-b5a3-f393-e0a9-e50e24dccb01';
const kDebug = true;
let debugLogger = null;

function debugLog(...args) {
  if (!kDebug) return;
  console.log('[airkvm-ble]', ...args);
  if (typeof debugLogger === 'function') {
    try {
      debugLogger(...args);
    } catch {
      // Non-fatal logging hook.
    }
  }
}

function bytesToHex(view) {
  if (!view) return '';
  const bytes = view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function propsToObject(props) {
  if (!props) return {};
  return {
    broadcast: Boolean(props.broadcast),
    read: Boolean(props.read),
    writeWithoutResponse: Boolean(props.writeWithoutResponse),
    write: Boolean(props.write),
    notify: Boolean(props.notify),
    indicate: Boolean(props.indicate),
    authenticatedSignedWrites: Boolean(props.authenticatedSignedWrites),
    reliableWrite: Boolean(props.reliableWrite),
    writableAuxiliaries: Boolean(props.writableAuxiliaries)
  };
}

async function describeGatt(server) {
  if (!server || typeof server.getPrimaryServices !== 'function') return null;
  const services = await server.getPrimaryServices();
  const out = [];
  for (const service of services) {
    const chars = typeof service.getCharacteristics === 'function'
      ? await service.getCharacteristics()
      : [];
    out.push({
      service: service?.uuid || null,
      isPrimary: Boolean(service?.isPrimary),
      characteristics: chars.map((c) => ({
        uuid: c?.uuid || null,
        properties: propsToObject(c?.properties)
      }))
    });
  }
  return out;
}

let bleDevice = null;
let rxCharacteristic = null;
let txCharacteristic = null;
let bleLineBuffer = '';
let commandHandler = null;

export function __resetBleForTest() {
  bleDevice = null;
  rxCharacteristic = null;
  txCharacteristic = null;
  bleLineBuffer = '';
  commandHandler = null;
  debugLogger = null;
}

export function setBleDebugLogger(logger) {
  debugLogger = typeof logger === 'function' ? logger : null;
}

function extractJsonObjects(input) {
  const messages = [];
  if (!input) return { messages, rest: '' };

  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  let consumedUntil = 0;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      } else if (!/\s/.test(ch)) {
        // Drop non-whitespace garbage before the next JSON object.
        consumedUntil = i + 1;
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        messages.push(input.slice(start, i + 1));
        consumedUntil = i + 1;
        start = -1;
      }
    }
  }

  return { messages, rest: input.slice(consumedUntil) };
}

function hasBluetooth(navigatorLike) {
  return Boolean(navigatorLike?.bluetooth?.requestDevice);
}

async function pickDevice(navigatorLike, deps = {}) {
  const preferredDeviceId = deps.preferredDeviceId || null;
  if (preferredDeviceId && typeof navigatorLike?.bluetooth?.getDevices === 'function') {
    try {
      const known = await navigatorLike.bluetooth.getDevices();
      const preferred = known.find((d) => d?.id === preferredDeviceId);
      if (preferred) {
        debugLog('using preferred device', preferred.id);
        return preferred;
      }
    } catch (err) {
      debugLog('getDevices failed', String(err?.message || err));
    }
  }

  const requestOptions = deps.requestOptions || {
    filters: [{ services: [UART_SERVICE_UUID] }],
    optionalServices: [UART_SERVICE_UUID]
  };
  return navigatorLike.bluetooth.requestDevice(requestOptions);
}

export async function connectBle(deps = {}) {
  const navigatorLike = deps.navigatorLike || globalThis.navigator;
  if (!hasBluetooth(navigatorLike)) {
    debugLog('connectBle unavailable');
    return false;
  }

  const device = await pickDevice(navigatorLike, deps);

  const server = await device.gatt.connect();
  try {
    const gatt = await describeGatt(server);
    debugLog('gatt services', gatt);
  } catch (err) {
    debugLog('gatt describe failed', String(err?.message || err));
  }
  const service = await server.getPrimaryService(UART_SERVICE_UUID);
  const rx = await service.getCharacteristic(UART_RX_CHAR_UUID);
  const tx = await service.getCharacteristic(UART_TX_CHAR_UUID);
  debugLog('selected chars', {
    service: service?.uuid || null,
    rx: { uuid: rx?.uuid || null, properties: propsToObject(rx?.properties) },
    tx: { uuid: tx?.uuid || null, properties: propsToObject(tx?.properties) }
  });
  debugLog('connectBle characteristics ready');

  bleDevice = device;
  rxCharacteristic = rx;
  txCharacteristic = tx;
  bleLineBuffer = '';

  const decoder = deps.decoder || new TextDecoder();
  if (typeof txCharacteristic?.addEventListener === 'function') {
    txCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = event?.target?.value;
      if (!value) return;
      const raw = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      debugLog('rx notify', { bytes: raw.length, hex: bytesToHex(raw) });
      onBleBytes(decoder.decode(value), deps.onCommand || commandHandler);
    });
  }
  if (typeof txCharacteristic?.startNotifications === 'function') {
    await txCharacteristic.startNotifications();
    debugLog('notifications started');
  }

  device.addEventListener('gattserverdisconnected', () => {
    rxCharacteristic = null;
    txCharacteristic = null;
    bleLineBuffer = '';
    if (typeof deps.onDisconnect === 'function') {
      try {
        deps.onDisconnect();
      } catch {
        // Non-fatal disconnect callback.
      }
    }
  });

  return true;
}

export function getConnectedDeviceInfo() {
  return {
    id: bleDevice?.id || null,
    name: bleDevice?.name || null,
    connected: Boolean(bleDevice?.gatt?.connected)
  };
}

export async function readBleTxSnapshot(deps = {}) {
  if (!txCharacteristic || typeof txCharacteristic.readValue !== 'function') {
    return null;
  }
  const decoder = deps.decoder || new TextDecoder();
  const value = await txCharacteristic.readValue();
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const text = decoder.decode(value);
  return {
    bytes: bytes.length,
    hex: bytesToHex(bytes),
    text
  };
}

export function disconnectBle() {
  const device = bleDevice;
  if (device?.gatt?.connected) {
    try {
      device.gatt.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
  bleDevice = null;
  rxCharacteristic = null;
  txCharacteristic = null;
  bleLineBuffer = '';
}

async function ensureConnected(deps = {}) {
  if (rxCharacteristic && bleDevice?.gatt?.connected) return true;
  return connectBle(deps);
}

export async function postEvent(payload, deps = {}) {
  const encoder = deps.encoder || new TextEncoder();
  const traceId = deps.traceId || null;
  try {
    const connected = await ensureConnected(deps);
    if (!connected || !rxCharacteristic) return false;
    const line = `${JSON.stringify(payload)}\n`;
    const bytes = encoder.encode(line);
    const supportsWithResponse = typeof rxCharacteristic.writeValueWithResponse === 'function';
    debugLog('tx', {
      traceId,
      type: payload?.type || 'unknown',
      bytes: bytes.length,
      mode: supportsWithResponse ? 'withResponse' : 'withoutResponse'
    });
    if (supportsWithResponse) {
      try {
        await rxCharacteristic.writeValueWithResponse(bytes);
        return true;
      } catch (err) {
        debugLog('tx withResponse failed, falling back', {
          traceId,
          error: String(err?.message || err)
        });
      }
    }
    await rxCharacteristic.writeValueWithoutResponse(bytes);
    return true;
  } catch {
    debugLog('postEvent failed', { traceId, type: payload?.type || 'unknown' });
    return false;
  }
}

function onBleBytes(text, onCommand) {
  if (!text || typeof text !== 'string') return;
  debugLog('rx bytes', { bytes: text.length, preview: text.slice(0, 160) });
  bleLineBuffer += text;
  const { messages, rest } = extractJsonObjects(bleLineBuffer);
  bleLineBuffer = rest;
  for (const serialized of messages) {
    try {
      const msg = JSON.parse(serialized);
      debugLog('rx json', msg?.type || 'unknown');
      if (typeof onCommand === 'function') onCommand(msg);
    } catch {
      // Ignore malformed objects.
    }
  }
}

export function setBleCommandHandler(handler) {
  commandHandler = handler;
}
