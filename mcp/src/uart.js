import { SerialPort } from 'serialport';
import { kTarget } from '../../shared/binary_frame.js';
import { HalfPipe } from '../../shared/halfpipe.js';

export class UartTransport {
  constructor({
    portPath,
    baudRate = 115200,
    commandTimeoutMs = 3000,
    debug = false
  } = {}) {
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.commandTimeoutMs = commandTimeoutMs;
    this.debug = debug;
    this.serialPort = null;
    this.opened = false;
    this.halfpipe = null;
    this._pending = null; // { isLocal, resolve, reject, timer }
    this._callQueue = Promise.resolve(); // serializes concurrent send() calls
  }

  async open() {
    if (this.opened) return;
    if (!this.portPath) throw new Error('serial_port_not_configured');

    this.log(`open port=${this.portPath} baud=${this.baudRate}`);
    this.serialPort = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false
    });

    await new Promise((resolve, reject) => {
      this.serialPort.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.serialPort.on('error', (error) => {
      this.log(`serial error: ${error?.message || error}`);
    });
    this.opened = true;

    if (!this.halfpipe) {
      this.halfpipe = new HalfPipe({
        writeFn: async (frameBytes) => {
          await new Promise((resolve, reject) => {
            this.serialPort.write(frameBytes, (err) => {
              if (err) reject(err);
              else this.serialPort.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
            });
          });
        },
        ackTarget: kTarget.EXTENSION,
        log: (msg) => this.log(`[halfpipe] ${msg}`),
      });

      this.halfpipe.onControl((msg) => this._handleControl(msg));
      this.halfpipe.onMessage((msg) => this._handleMessage(msg));
    }

    this.serialPort.on('data', (chunk) => {
      this.halfpipe.feedBytes(chunk);
    });

    // Flush any partial stream state left on the firmware's UART parser.
    await this.halfpipe.reset();
  }

  log(msg) {
    if (!this.debug) return;
    process.stderr.write(`[uart] ${msg}\n`);
  }

  _handleControl(msg) {
    if (msg?.type === 'boot') {
      this.log('firmware reboot detected, resetting halfpipe');
      const p = this._pending;
      this._pending = null;
      if (p) { clearTimeout(p.timer); p.reject(new Error('firmware_rebooted')); }
      this.halfpipe.reset().catch(() => {});
      return;
    }
    const p = this._pending;
    if (p?.isLocal) {
      this._pending = null;
      clearTimeout(p.timer);
      p.resolve({ ok: msg?.ok !== false, data: msg });
    }
  }

  _handleMessage(msg) {
    const p = this._pending;
    if (p && !p.isLocal) {
      this._pending = null;
      clearTimeout(p.timer);
      p.resolve({ ok: !(msg?.ok === false || msg?.error), data: msg });
    }
  }

  // Send a command and wait for the response.
  // FW and HID tools → sendControl (single CONTROL frame, firmware handles locally, response via onControl).
  // Extension tools → send (CHUNK frames relayed to extension over BLE, response via onMessage).
  send(command, tool, { timeoutMs = this.commandTimeoutMs } = {}) {
    const run = async () => {
      await this.open();
      const isLocal = tool.target === 'fw' || tool.target === 'hid';
      const halfpipeTarget = tool.target === 'fw' ? kTarget.FW
        : tool.target === 'hid' ? kTarget.HID
        : kTarget.EXTENSION;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.log(`send timeout command=${JSON.stringify(command)}`);
          this._pending = null;
          reject(new Error('device_timeout'));
        }, timeoutMs);

        this._pending = { isLocal, resolve, reject, timer };

        const sendPromise = isLocal
          ? this.halfpipe.sendControl(command, halfpipeTarget)
          : this.halfpipe.send(command, halfpipeTarget);

        sendPromise.catch((err) => {
          if (this._pending) { clearTimeout(this._pending.timer); this._pending = null; }
          reject(err);
        });
      });
    };

    const next = this._callQueue.then(run, run);
    this._callQueue = next.catch(() => {});
    return next;
  }

  close() {
    if (this.serialPort?.isOpen) {
      this.serialPort.close(() => {});
    }
    if (this.halfpipe) {
      this.halfpipe.close();
      this.halfpipe = null;
    }
    this.serialPort = null;
    this.opened = false;
  }
}
