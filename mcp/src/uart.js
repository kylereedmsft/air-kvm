import fs from 'node:fs';
import readline from 'node:readline';

export function parseDeviceLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'invalid', raw: line };
  }

  if (parsed && parsed.ch === 'ctrl' && typeof parsed.msg === 'object' && parsed.msg !== null) {
    return { kind: 'ctrl', msg: parsed.msg };
  }
  if (parsed && parsed.ch === 'log' && typeof parsed.msg === 'string') {
    return { kind: 'log', msg: parsed.msg };
  }
  if (parsed && typeof parsed === 'object') {
    return { kind: 'legacy_ctrl', msg: parsed };
  }
  return { kind: 'invalid', raw: line };
}

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
    this.readStream = null;
    this.writeStream = null;
    this.rl = null;
    this.currentWaiter = null;
    this.sendQueue = Promise.resolve();
    this.opened = false;
  }

  async open() {
    if (this.opened) return;
    if (!this.portPath) throw new Error('serial_port_not_configured');

    this.log(`open port=${this.portPath} baud=${this.baudRate}`);
    this.readStream = fs.createReadStream(this.portPath, { encoding: 'utf8' });
    this.writeStream = fs.createWriteStream(this.portPath, { encoding: 'utf8', flags: 'a' });
    this.rl = readline.createInterface({ input: this.readStream, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.onLine(line));
    this.opened = true;
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
    return false;
  }

  onLine(line) {
    this.log(`rx line=${line}`);
    const frame = parseDeviceLine(line);
    if (this.currentWaiter) {
      this.currentWaiter.onFrame(frame);
    }
  }

  async sendCommand(command) {
    const run = async () => {
      await this.open();

      const line = `${JSON.stringify(command)}\n`;
      this.log(`tx line=${line.trim()}`);
      await new Promise((resolve, reject) => {
        this.writeStream.write(line, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      return new Promise((resolve, reject) => {
        const frames = [];
        const finish = (fn, value) => {
          clearTimeout(timer);
          this.currentWaiter = null;
          fn(value);
        };
        const timer = setTimeout(() => {
          this.log(`timeout command=${JSON.stringify(command)} frames=${JSON.stringify(frames)}`);
          finish(reject, new Error('device_timeout'));
        }, this.commandTimeoutMs);

        this.currentWaiter = {
          reject,
          onFrame: (frame) => {
            frames.push(frame);
            const msg = frame.kind === 'ctrl' || frame.kind === 'legacy_ctrl' ? frame.msg : null;
            if (this.shouldResolveForCommand(command, msg)) {
              this.log(`resolved command=${JSON.stringify(command)} msg=${JSON.stringify(msg)}`);
              finish(resolve, { ok: msg.ok, msg, frames });
            }
          }
        };
      });
    };

    const scheduled = this.sendQueue.then(run, run);
    this.sendQueue = scheduled.catch(() => {});
    return scheduled;
  }

  close() {
    if (this.currentWaiter) {
      this.currentWaiter.reject(new Error('transport_closed'));
      this.currentWaiter = null;
    }
    this.rl?.close();
    this.readStream?.destroy();
    this.writeStream?.end();
    this.opened = false;
  }
}
