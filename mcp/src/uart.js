import { SerialPort } from 'serialport';
import { tryExtractFrameFromBuffer } from './binary_frame.js';
import { StreamSender, StreamReceiver } from './stream.js';

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

  async writeRawCommand(command) {
    const line = `${JSON.stringify(command)}\n`;
    this.log(`tx line=${line.trim()}`);
    await new Promise((resolve, reject) => {
      this.serialPort.write(line, (err) => {
        if (err) reject(err);
        else this.serialPort.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });
  }

  async sendCommandNoWait(command) {
    const run = async () => {
      await this.open();
      await this.writeRawCommand(command);
      return { ok: true };
    };
    const scheduled = this.sendQueue.then(run, run);
    this.sendQueue = scheduled.catch(() => {});
    return scheduled;
  }

  async waitForFrame(responseCollector, timeoutMs = this.commandTimeoutMs) {
    if (typeof responseCollector !== 'function') {
      throw new Error('invalid_response_collector');
    }
    const run = async () => {
      await this.open();
      return this._collectFrames({ collector: responseCollector, timeoutMs });
    };

    const scheduled = this.sendQueue.then(run, run);
    this.sendQueue = scheduled.catch(() => {});
    return scheduled;
  }

  async sendCommand(command, responseCollector = null) {
    const run = async () => {
      await this.open();
      await this.writeRawCommand(command);

      return this._collectFrames({
        collector: responseCollector,
        timeoutMs: this.commandTimeoutMs,
        onTimeout: typeof responseCollector?.onTimeout === 'function'
          ? responseCollector.onTimeout
          : null,
        noCollectorMatch: !responseCollector
          ? (msg) => {
            if (this.shouldResolveForCommand(command, msg)) {
              this.log(`resolved command=${JSON.stringify(command)} msg=${JSON.stringify(msg)}`);
              return { ok: msg.ok, msg };
            }
            return null;
          }
          : null,
        logContext: command,
      });
    };

    const scheduled = this.sendQueue.then(run, run);
    this.sendQueue = scheduled.catch(() => {});
    return scheduled;
  }

  // Shared frame-collection loop used by sendCommand, waitForFrame, and
  // streamSendCommand.  Sets up currentWaiter, timer, and collector routing.
  _collectFrames({ collector, timeoutMs, onTimeout = null, noCollectorMatch = null, logContext = null }) {
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
            .then(() => this.writeRawCommand(outbound))
            .catch((err) => {
              this.log(`collector tx error: ${err?.message || err}`);
            });
        }
      };

      const armTimer = (ms = timeoutMs) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (waiterClosed) return;
          if (onTimeout) {
            const timed = onTimeout(frames);
            if (timed) {
              if (Array.isArray(timed.outbound) && timed.outbound.length > 0) {
                queueCollectorCommands(timed.outbound);
              }
              if (timed.done) {
                finish(resolve, {
                  ok: typeof timed.ok === 'boolean' ? timed.ok : true,
                  msg: timed.msg ?? null,
                  frames,
                  data: timed.data,
                });
                return;
              }
              armTimer(Number.isInteger(timed.extendTimeoutMs) ? timed.extendTimeoutMs : timeoutMs);
              return;
            }
          }
          if (logContext) {
            this.log(`timeout command=${JSON.stringify(logContext)} frames=${JSON.stringify(frames)}`);
          }
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

      armTimer(timeoutMs);

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

          if (collector && shouldCallCollector) {
            armTimer(timeoutMs);
            const collected = collector(msg, frame, frames);
            if (collected?.done) {
              if (Array.isArray(collected.outbound) && collected.outbound.length > 0) {
                queueCollectorCommands(collected.outbound);
              }
              finish(resolve, {
                ok: typeof collected.ok === 'boolean' ? collected.ok : true,
                msg: collected.msg ?? msg,
                frames,
                data: collected.data,
              });
              return;
            }
            if (Array.isArray(collected?.outbound) && collected.outbound.length > 0) {
              queueCollectorCommands(collected.outbound);
            }
            if (Number.isInteger(collected?.extendTimeoutMs)) {
              armTimer(collected.extendTimeoutMs);
            } else if (collected) {
              armTimer(timeoutMs);
            }
          }

          if (noCollectorMatch && msg) {
            const match = noCollectorMatch(msg);
            if (match) {
              finish(resolve, { ok: match.ok, msg: match.msg, frames });
            }
          }
        },
      };
    });
  }

  // Stream-based request: sends a command and returns the complete response
  // assembled by the stream layer (handles chunked binary transfers transparently).
  async streamRequest(command, { timeoutMs = this.commandTimeoutMs } = {}) {
    const run = async () => {
      await this.open();
      this.log(`streamRequest start type=${command?.type || 'unknown'}`);
      await this.writeRawCommand(command);

      return new Promise((resolve, reject) => {
        let timer = null;
        let finished = false;
        let chunkCount = 0;

        const receiver = new StreamReceiver({
          writeJsonFn: async (obj) => {
            this.log(`streamRequest ack type=${obj?.type} tid=${obj?.transfer_id} seq=${obj?.seq}`);
            await this.writeRawCommand(obj);
          },
        });

        receiver.onMessage((msg) => {
          if (finished) return;
          this.log(`streamRequest complete chunks=${chunkCount} type=${msg?.type || 'unknown'}`);
          finish(resolve, { ok: true, data: msg });
        });

        receiver.onError((err) => {
          if (finished) return;
          this.log(`streamRequest error code=${err.code} tid=${err.transfer_id}`);
          finish(reject, new Error(`stream_error:${err.code}`));
        });

        const armTimer = (ms) => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (finished) return;
            finish(reject, new Error('device_timeout'));
          }, ms);
        };

        const finish = (fn, value) => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          this.currentWaiter = null;
          receiver.reset();
          fn(value);
        };

        armTimer(timeoutMs);

        this.currentWaiter = {
          reject,
          onFrame: (frame) => {
            if (finished) return;
            armTimer(timeoutMs);
            if (frame.kind === 'bin') {
              chunkCount += 1;
              receiver.onChunkFrame({
                transfer_id: frame.transfer_id,
                raw_seq: frame.seq,
                payload: frame.payload,
              });
            } else if (frame.kind === 'ctrl' || frame.kind === 'legacy_ctrl') {
              receiver.onControlFrame(frame.msg);
            }
          },
        };
      });
    };

    const scheduled = this.sendQueue.then(run, run);
    this.sendQueue = scheduled.catch(() => {});
    return scheduled;
  }

  // Stream-based send + response: sends a large command via stream layer
  // (JSON-based chunking), then waits for a response using the collector.
  // Used for MCP→Extension direction where UART is text-only.
  async streamSendCommand(command, responseCollector, { timeoutMs = this.commandTimeoutMs } = {}) {
    const run = async () => {
      await this.open();
      this.log(`streamSendCommand start type=${command?.type || 'unknown'} bytes=${JSON.stringify(command).length}`);

      const sender = new StreamSender({
        writeJsonFn: async (obj) => { await this.writeRawCommand(obj); },
      });

      // Phase 1: stream-send the command, routing acks from extension.
      await new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          this.currentWaiter = null;
          sender.reset();
          this.log('streamSendCommand send phase timeout');
          reject(new Error('stream_send_timeout'));
        }, timeoutMs);

        this.currentWaiter = {
          reject,
          onFrame: (frame) => {
            if (finished) return;
            const msg = frame.kind === 'ctrl' || frame.kind === 'legacy_ctrl' ? frame.msg : null;
            if (msg?.type === 'stream.ack' || msg?.type === 'stream.nack') {
              sender.onAck(msg);
            }
          },
        };

        sender.send(command).then(() => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.currentWaiter = null;
          this.log('streamSendCommand send phase complete');
          resolve();
        }).catch((err) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.currentWaiter = null;
          this.log(`streamSendCommand send phase error: ${err.message}`);
          reject(err);
        });
      });

      // Phase 2: wait for the response using the shared collector loop.
      return this._collectFrames({ collector: responseCollector, timeoutMs });
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
