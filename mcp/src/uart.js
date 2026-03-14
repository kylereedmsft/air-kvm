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
    }

    this.serialPort.on('data', (chunk) => {
      this.halfpipe.feedBytes(chunk);
    });
  }

  log(msg) {
    if (!this.debug) return;
    process.stderr.write(`[uart] ${msg}\n`);
  }

  // Send a command and wait for the response.
  // FW and HID tools → sendControl (single CONTROL frame, firmware handles locally, response via onControl).
  // Extension tools → send (CHUNK frames relayed to extension over BLE, response via onMessage).
  async send(command, tool, { timeoutMs = this.commandTimeoutMs } = {}) {
    await this.open();
    const isLocal = tool.target === 'fw' || tool.target === 'hid';
    const halfpipeTarget = tool.target === 'fw' ? kTarget.FW
      : tool.target === 'hid' ? kTarget.HID
      : kTarget.EXTENSION;

    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const finish = (fn, val) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn(val);
      };

      const prevCb = isLocal ? this.halfpipe._controlHandler : this.halfpipe._messageHandler;
      const setHandler = isLocal
        ? (cb) => this.halfpipe.onControl(cb)
        : (cb) => this.halfpipe.onMessage(cb);

      timer = setTimeout(() => {
        this.log(`send timeout command=${JSON.stringify(command)}`);
        if (this.halfpipe) setHandler(prevCb);
        finish(reject, new Error('device_timeout'));
      }, timeoutMs);

      setHandler((msg) => {
        const matches = tool.matchResponse
          ? tool.matchResponse(msg)
          : typeof msg?.ok === 'boolean';
        if (!isLocal || matches) {
          setHandler(prevCb);
          finish(resolve, isLocal ? { ok: msg?.ok !== false, msg } : msg);
        }
      });

      const sendPromise = isLocal
        ? this.halfpipe.sendControl(command, halfpipeTarget)
        : this.halfpipe.send(command, halfpipeTarget);

      sendPromise.catch((err) => {
        if (this.halfpipe) setHandler(prevCb);
        finish(reject, err);
      });
    });
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
