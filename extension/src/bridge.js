const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

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
}

function hasBluetooth(navigatorLike) {
  return Boolean(navigatorLike?.bluetooth?.requestDevice);
}

export async function connectBle(deps = {}) {
  const navigatorLike = deps.navigatorLike || globalThis.navigator;
  if (!hasBluetooth(navigatorLike)) return false;

  const device = await navigatorLike.bluetooth.requestDevice({
    filters: [{ services: [UART_SERVICE_UUID] }],
    optionalServices: [UART_SERVICE_UUID]
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(UART_SERVICE_UUID);
  const rx = await service.getCharacteristic(UART_RX_CHAR_UUID);
  const tx = await service.getCharacteristic(UART_TX_CHAR_UUID);

  bleDevice = device;
  rxCharacteristic = rx;
  txCharacteristic = tx;
  bleLineBuffer = '';

  const decoder = deps.decoder || new TextDecoder();
  if (typeof txCharacteristic?.addEventListener === 'function') {
    txCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = event?.target?.value;
      if (!value) return;
      onBleBytes(decoder.decode(value), deps.onCommand || commandHandler);
    });
  }
  if (typeof txCharacteristic?.startNotifications === 'function') {
    await txCharacteristic.startNotifications();
  }

  device.addEventListener('gattserverdisconnected', () => {
    rxCharacteristic = null;
    txCharacteristic = null;
    bleLineBuffer = '';
  });

  return true;
}

async function ensureConnected(deps = {}) {
  if (rxCharacteristic && bleDevice?.gatt?.connected) return true;
  return connectBle(deps);
}

export async function postEvent(payload, deps = {}) {
  const encoder = deps.encoder || new TextEncoder();
  try {
    const connected = await ensureConnected(deps);
    if (!connected || !rxCharacteristic) return false;
    const line = `${JSON.stringify(payload)}\n`;
    await rxCharacteristic.writeValueWithoutResponse(encoder.encode(line));
    return true;
  } catch {
    return false;
  }
}

function onBleBytes(text, onCommand) {
  if (!text || typeof text !== 'string') return;
  bleLineBuffer += text;
  const lines = bleLineBuffer.split('\n');
  bleLineBuffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (typeof onCommand === 'function') onCommand(msg);
    } catch {
      // Ignore malformed device notifications.
    }
  }
}

export function setBleCommandHandler(handler) {
  commandHandler = handler;
}
