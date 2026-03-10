import { SerialPort } from 'serialport';
import { tryExtractFrameFromBuffer } from './binary_frame.js';

const kMagic0 = 0x41;
const kMagic1 = 0x4b;

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
    this.serialPort = null;
    this.readBuffer = Buffer.alloc(0);
    this.currentWaiter = null;
    this.sendQueue = Promise.resolve();
    this.opened = false;
    this.recentFrames = [];
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
    this.recentFrames.push(frame);
    if (this.recentFrames.length > 200) {
      this.recentFrames.shift();
    }
    if (this.currentWaiter) {
      this.currentWaiter.onFrame(frame);
    }
  }

  onData(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.readBuffer = Buffer.concat([this.readBuffer, incoming]);
    while (this.readBuffer.length > 0) {
      if (this.readBuffer[0] !== kMagic0) {
        const nextMagic = this.readBuffer.indexOf(kMagic0, 1);
        if (nextMagic === -1) {
          this.readBuffer = Buffer.alloc(0);
          break;
        }
        this.readBuffer = this.readBuffer.subarray(nextMagic);
        continue;
      }
      if (this.readBuffer.length < 2) {
        break;
      }
      if (this.readBuffer[1] !== kMagic1) {
        this.readBuffer = this.readBuffer.subarray(1);
        continue;
      }

      const maybeFrame = tryExtractFrameFromBuffer(this.readBuffer);
      if (!maybeFrame) {
        break;
      }
      this.readBuffer = this.readBuffer.subarray(maybeFrame.consumed);
      const frame = maybeFrame.frame;
      this.recentFrames.push(frame);
      if (this.recentFrames.length > 200) {
        this.recentFrames.shift();
      }
      if (this.currentWaiter) {
        this.currentWaiter.onFrame(frame);
      }
    }
  }

  async sendCommand(command, responseCollector = null) {
    const run = async () => {
      await this.open();

      const writeRawCommand = async (cmd) => {
        const line = `${JSON.stringify(cmd)}\n`;
        this.log(`tx line=${line.trim()}`);
        await new Promise((resolve, reject) => {
          this.serialPort.write(line, (err) => {
            if (err) reject(err);
            else this.serialPort.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
          });
        });
      };

      await writeRawCommand(command);

      return new Promise((resolve, reject) => {
        const frames = [];
        let timer = null;
        let waiterClosed = false;
        let controlWriteQueue = Promise.resolve();

        const queueCollectorCommands = (commands) => {
          if (!Array.isArray(commands) || commands.length === 0) return;
          for (const outbound of commands) {
            this.log(`collector outbound=${JSON.stringify(outbound)}`);
            controlWriteQueue = controlWriteQueue
              .then(() => writeRawCommand(outbound))
              .catch((err) => {
                this.log(`collector tx error: ${err?.message || err}`);
              });
          }
        };

        const armTimer = (ms = this.commandTimeoutMs) => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (waiterClosed) return;
            if (typeof responseCollector?.onTimeout === 'function') {
              const timed = responseCollector.onTimeout(frames);
              if (timed) {
                if (Array.isArray(timed.outbound) && timed.outbound.length > 0) {
                  queueCollectorCommands(timed.outbound);
                }
                if (timed.done) {
                  if (typeof timed.ok === 'boolean' && timed.ok === false) {
                    finish(resolve, {
                      ok: false,
                      msg: timed.msg ?? null,
                      frames,
                      data: timed.data
                    });
                    return;
                  }
                  finish(resolve, {
                    ok: true,
                    msg: timed.msg ?? null,
                    frames,
                    data: timed.data
                  });
                  return;
                }
                armTimer(Number.isInteger(timed.extendTimeoutMs) ? timed.extendTimeoutMs : this.commandTimeoutMs);
                return;
              }
            }
            this.log(`timeout command=${JSON.stringify(command)} frames=${JSON.stringify(frames)}`);
            const err = new Error('device_timeout');
            err.frames = frames;
            err.recentFrames = this.recentFrames.slice(-50);
            finish(reject, err);
          }, ms);
        };

        const finish = (fn, value) => {
          if (waiterClosed) return;
          waiterClosed = true;
          if (timer) clearTimeout(timer);
          this.currentWaiter = null;
          fn(value);
        };
        armTimer(this.commandTimeoutMs);

        this.currentWaiter = {
          reject,
          onFrame: (frame) => {
            frames.push(frame);
            const msg = frame.kind === 'ctrl' || frame.kind === 'legacy_ctrl' ? frame.msg : null;
            const shouldCallCollector = Boolean(
              msg ||
              frame.kind === 'bin' ||
              frame.kind === 'bin_error'
            );
            if (responseCollector && shouldCallCollector) {
              // Any control/bin frame is progress for long-running streamed responses.
              armTimer(this.commandTimeoutMs);
              const collected = responseCollector(msg, frame, frames);
              if (collected?.done) {
                if (Array.isArray(collected.outbound) && collected.outbound.length > 0) {
                  queueCollectorCommands(collected.outbound);
                }
                finish(resolve, {
                  ok: typeof collected.ok === 'boolean' ? collected.ok : true,
                  msg: collected.msg ?? msg,
                  frames,
                  data: collected.data
                });
                return;
              }
              if (Array.isArray(collected?.outbound) && collected.outbound.length > 0) {
                queueCollectorCommands(collected.outbound);
              }
              if (Number.isInteger(collected?.extendTimeoutMs)) {
                armTimer(collected.extendTimeoutMs);
              } else if (collected) {
                // A collector match indicates progress; keep wait alive.
                armTimer(this.commandTimeoutMs);
              }
            }
            if (!responseCollector && this.shouldResolveForCommand(command, msg)) {
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
    if (this.serialPort?.isOpen) {
      this.serialPort.close(() => {});
    }
    this.serialPort = null;
    this.readBuffer = '';
    this.opened = false;
  }
}
