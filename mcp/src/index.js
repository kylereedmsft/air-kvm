import readline from 'node:readline';
import { createServer } from './server.js';
import { UartTransport } from './uart.js';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const SERIAL_PORT = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const SERIAL_BAUD = Number.parseInt(process.env.AIRKVM_SERIAL_BAUD || '115200', 10);
const SERIAL_TIMEOUT_MS = Number.parseInt(process.env.AIRKVM_SERIAL_TIMEOUT_MS || '3000', 10);
const UART_DEBUG = process.env.AIRKVM_UART_DEBUG === '1';
const transport = new UartTransport({
  portPath: SERIAL_PORT,
  baudRate: Number.isNaN(SERIAL_BAUD) ? 115200 : SERIAL_BAUD,
  commandTimeoutMs: Number.isNaN(SERIAL_TIMEOUT_MS) ? 3000 : SERIAL_TIMEOUT_MS,
  debug: UART_DEBUG
});

const server = createServer({ transport, send });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    server.handleRequest(msg);
  } catch {
    // Ignore malformed input to keep STDIO loop resilient.
  }
});
rl.on('close', () => {
  transport.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  transport.close();
  process.exit(0);
});
