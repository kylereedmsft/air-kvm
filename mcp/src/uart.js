import { SerialPort } from 'serialport';
import { kMagic0, kMagic1, tryExtractFrame, encodeControlFrame } from '../../shared/binary_frame.js';
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
    this.readBuffer = Buffer.alloc(0);
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

    this.serialPort.on('data', (chunk) => this.onData(chunk));
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
        log: (msg) => this.log(`[halfpipe] ${msg}`),
      });
    }
  }

  log(msg) {
    if (!this.debug) return;
    process.stderr.write(`[uart] ${msg}\n`);
  }

  shouldResolveForCommand(command, msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (typeof msg.ok === 'boolean') return true;

    if (command?.type === 'state.request' && msg.type === 'state' && typeof msg.busy === 'boolean') {
      return true;
    }
    if (command?.type === 'fw.version.request' && msg.type === 'fw.version' && typeof msg.version === 'string') {
      return true;
    }
    return false;
  }

  onData(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.readBuffer = Buffer.concat([this.readBuffer, incoming]);
    while (this.readBuffer.length > 0) {
      if (this.readBuffer[0] !== kMagic0) {
        const nextMagic = this.readBuffer.indexOf(kMagic0, 1);
        if (nextMagic === -1) { this.readBuffer = Buffer.alloc(0); break; }
        this.readBuffer = this.readBuffer.subarray(nextMagic);
        continue;
      }
      if (this.readBuffer.length < 2) break;
      if (this.readBuffer[1] !== kMagic1) {
        this.readBuffer = this.readBuffer.subarray(1);
        continue;
      }

      const result = tryExtractFrame(this.readBuffer);
      if (result && result.frame.type !== 'error') {
        this.readBuffer = this.readBuffer.subarray(result.consumed);
        if (this.halfpipe) {
          this.halfpipe.onFrame(result.frame);
        }
        continue;
      }

      // Bad CRC or decode error — consume bytes, log, and continue
      if (result) {
        this.log(`frame error: ${result.frame.error}`);
        this.readBuffer = this.readBuffer.subarray(result.consumed);
        continue;
      }

      // Incomplete frame — wait for more data
      break;
    }
  }

  // Send a command via half-pipe and wait for the response message.
  async sendRequest(command, { timeoutMs = 30000 } = {}) {
    await this.open();
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const finish = (fn, val) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn(val);
      };

      const prevCb = this.halfpipe._messageHandler;

      timer = setTimeout(() => {
        this.log(`sendRequest timeout command=${JSON.stringify(command)}`);
        if (this.halfpipe) this.halfpipe.onMessage(prevCb);
        finish(reject, new Error('device_timeout'));
      }, timeoutMs);
      this.halfpipe.onMessage((msg) => {
        finish(resolve, msg);
        if (this.halfpipe) this.halfpipe.onMessage(prevCb);
      });

      this.halfpipe.send(command).catch((err) => {
        if (this.halfpipe) this.halfpipe.onMessage(prevCb);
        finish(reject, err);
      });
    });
  }

  // Send a firmware-local command as an AK control frame.
  async sendControlCommand(command, { timeoutMs = this.commandTimeoutMs } = {}) {
    await this.open();
    return new Promise((resolve, reject) => {
      let timer = null;
      let done = false;
      const finish = (fn, val) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        fn(val);
      };

      const prevCb = this.halfpipe._controlHandler;

      timer = setTimeout(() => {
        this.log('sendControlCommand timeout');
        if (this.halfpipe) this.halfpipe.onControl(prevCb);
        finish(reject, new Error('device_timeout'));
      }, timeoutMs);
      this.halfpipe.onControl((msg) => {
        if (this.shouldResolveForCommand(command, msg)) {
          if (this.halfpipe) this.halfpipe.onControl(prevCb);
          finish(resolve, { ok: msg.ok !== false, msg });
        }
      });

      const frameBytes = encodeControlFrame(command);
      this.serialPort.write(frameBytes, (err) => {
        if (err) { finish(reject, err); return; }
        this.serialPort.drain((drainErr) => {
          if (drainErr) finish(reject, drainErr);
        });
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
    this.readBuffer = Buffer.alloc(0);
    this.opened = false;
  }
}
