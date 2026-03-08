#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';

function run() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/index.js'], {
      cwd: mcpDir,
      env: {
        ...process.env,
        AIRKVM_SERIAL_PORT: serialPort
      }
    });

    const waiting = new Map();
    let bootstrapped = false;
    let timeoutId = null;
    let stdoutCarry = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutCarry += chunk;
      let newline = stdoutCarry.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutCarry.slice(0, newline);
        stdoutCarry = stdoutCarry.slice(newline + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          newline = stdoutCarry.indexOf('\n');
          continue;
        }
        if (typeof msg.id !== 'undefined' && waiting.has(msg.id)) {
          const done = waiting.get(msg.id);
          waiting.delete(msg.id);
          done(msg);
        }
        newline = stdoutCarry.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`mcp_exit_${code}`));
      }
    });

    function stopChild() {
      return new Promise((done) => {
        const finish = () => done();
        child.once('exit', finish);
        child.kill('SIGINT');
        setTimeout(() => child.kill('SIGKILL'), 800);
      });
    }

    function sendRpc(id, method, params = {}) {
      return new Promise((resolveRpc) => {
        waiting.set(id, resolveRpc);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    }

    async function main() {
      const init = await sendRpc(1, 'initialize', {});
      if (!init.result) throw new Error('initialize_failed');

      const control = await sendRpc(2, 'tools/call', {
        name: 'airkvm_send',
        arguments: { command: { type: 'state.request' } }
      });
      const ctlText = control?.result?.content?.[0]?.text || '';
      if (!ctlText.includes('forwarded')) throw new Error(`control_failed:${ctlText}`);

      bootstrapped = true;
      if (timeoutId) clearTimeout(timeoutId);
      console.log('smoke_ok');
      await stopChild();
      resolve();
    }

    main().catch((err) => {
      if (timeoutId) clearTimeout(timeoutId);
      stopChild().finally(() => reject(err));
    });

    timeoutId = setTimeout(() => {
      if (!bootstrapped) {
        stopChild().finally(() => reject(new Error('smoke_timeout')));
      }
    }, 10000);
  });
}

run().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
