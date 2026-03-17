#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const mcpDir = path.join(repoRoot, 'mcp');

const serialPort = process.env.AIRKVM_SERIAL_PORT || '/dev/cu.usbserial-0001';
const toolTimeoutMs = Number.parseInt(process.env.AIRKVM_TOOL_TIMEOUT_MS || '30000', 10);
const popupWidth = Number.parseInt(process.env.AIRKVM_CAL_WIDTH || '1400', 10);
const popupHeight = Number.parseInt(process.env.AIRKVM_CAL_HEIGHT || '1000', 10);
const absMin = 0;
const absMax = 32767;
const coarseStep = Number.parseInt(process.env.AIRKVM_CAL_ABS_SCAN_STEP || '1024', 10);
const settleMs = Number.parseInt(process.env.AIRKVM_CAL_ABS_SETTLE_MS || '220', 10);
const refineEdges = process.env.AIRKVM_CAL_ABS_REFINE === '1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnMcp() {
  const child = spawn('node', ['src/index.js'], {
    cwd: mcpDir,
    env: { ...process.env, AIRKVM_SERIAL_PORT: serialPort }
  });

  const waiting = new Map();
  let carry = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    carry += chunk;
    let nl = carry.indexOf('\n');
    while (nl !== -1) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && waiting.has(msg.id)) {
            const { resolve } = waiting.get(msg.id);
            waiting.delete(msg.id);
            resolve(msg);
          }
        } catch {}
      }
      nl = carry.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  function stop() {
    return new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 800);
    });
  }

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`timeout:${method}`));
      }, toolTimeoutMs);
      waiting.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async function tool(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    const rawText = response?.result?.content?.[0]?.text ?? '';
    try {
      return JSON.parse(rawText);
    } catch {
      throw new Error(`bad_json:${name}:${rawText}`);
    }
  }

  return { rpc, tool, stop };
}

function clampAbs(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(absMin, Math.min(absMax, Math.round(value)));
}

function eventCount(status) {
  return Number(status?.event_count || 0);
}

function clientPoint(status) {
  return {
    x: Number(status?.event?.client_x),
    y: Number(status?.event?.client_y)
  };
}

async function openPopup(mcp, sessionId) {
  const opened = await mcp.tool('airkvm_open_calibration_window', {
    request_id: 'abs-boundary-open',
    session_id: sessionId,
    focused: true,
    width: popupWidth,
    height: popupHeight
  });
  console.log(JSON.stringify({ phase: 'opened', opened }, null, 2));
  return opened;
}

async function getStatus(mcp, requestId) {
  return mcp.tool('airkvm_calibration_status', { request_id: requestId });
}

async function moveAbs(mcp, x, y, requestId) {
  await mcp.tool('airkvm_mouse_move_abs', { x: clampAbs(x), y: clampAbs(y) });
  await sleep(settleMs);
  return getStatus(mcp, requestId);
}

function axisValue(point, axis) {
  return axis === 'x' ? point.x : point.y;
}

function buildPoint(axis, value, fixed) {
  return axis === 'x'
    ? { x: clampAbs(value), y: clampAbs(fixed) }
    : { x: clampAbs(fixed), y: clampAbs(value) };
}

function nextScanValue(current, direction) {
  return direction > 0 ? current + coarseStep : current - coarseStep;
}

async function probeMove(mcp, point, requestId) {
  const status = await moveAbs(mcp, point.x, point.y, requestId);
  return {
    point,
    status,
    count: eventCount(status),
    client: clientPoint(status)
  };
}

async function scanBoundary(mcp, options) {
  const { axis, startAbs, endAbs, fixedAbs, direction, label } = options;
  let baseline = await getStatus(mcp, `${label}-baseline`);
  let previousCount = eventCount(baseline);
  let miss = null;
  let hit = null;
  let cursor = startAbs;

  while ((direction > 0 && cursor <= endAbs) || (direction < 0 && cursor >= endAbs)) {
    const point = buildPoint(axis, cursor, fixedAbs);
    const probe = await probeMove(mcp, point, `${label}-coarse-${cursor}`);
    const changed = probe.count > previousCount;
    console.log(JSON.stringify({
      phase: 'boundary-coarse',
      label,
      axis,
      requested_abs: point,
      changed,
      client: probe.client,
      event_count: probe.count
    }, null, 2));
    previousCount = probe.count;
    if (changed) {
      hit = probe;
      break;
    }
    miss = probe;
    cursor = nextScanValue(cursor, direction);
  }

  if (!hit) {
    throw new Error(`boundary_not_found:${label}`);
  }

  if (!miss || !refineEdges) {
    return {
      label,
      axis,
      abs: axisValue(hit.point, axis),
      point: hit.point,
      client: hit.client,
      status: hit.status
    };
  }

  let low = direction > 0 ? axisValue(miss.point, axis) : axisValue(hit.point, axis);
  let high = direction > 0 ? axisValue(hit.point, axis) : axisValue(miss.point, axis);
  let best = hit;

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const point = buildPoint(axis, mid, fixedAbs);
    const probe = await probeMove(mcp, point, `${label}-refine-${mid}`);
    const changed = probe.count > previousCount;
    console.log(JSON.stringify({
      phase: 'boundary-refine',
      label,
      axis,
      requested_abs: point,
      changed,
      client: probe.client,
      event_count: probe.count
    }, null, 2));
    previousCount = probe.count;
    if (changed) {
      best = probe;
      if (direction > 0) {
        high = mid;
      } else {
        low = mid;
      }
    } else if (direction > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return {
    label,
    axis,
    abs: axisValue(best.point, axis),
    point: best.point,
    client: best.client,
    status: best.status
  };
}

function interpolateAbs(target, lowClient, highClient, lowAbs, highAbs) {
  const spanClient = highClient - lowClient;
  const spanAbs = highAbs - lowAbs;
  if (!Number.isFinite(spanClient) || !Number.isFinite(spanAbs) || spanClient === 0) {
    return clampAbs((lowAbs + highAbs) / 2);
  }
  const ratio = (target - lowClient) / spanClient;
  return clampAbs(lowAbs + (ratio * spanAbs));
}

async function moveToEstimatedPoint(mcp, layout, bounds, targetX, targetY, label) {
  const x = interpolateAbs(targetX, bounds.left.client.x, bounds.right.client.x, bounds.left.abs, bounds.right.abs);
  const y = interpolateAbs(targetY, bounds.top.client.y, bounds.bottom.client.y, bounds.top.abs, bounds.bottom.abs);
  const status = await moveAbs(mcp, x, y, `${label}-move`);
  const landed = clientPoint(status);
  console.log(JSON.stringify({
    phase: 'estimated-move',
    label,
    requested_abs: { x, y },
    target: { x: targetX, y: targetY },
    landed
  }, null, 2));
  return { status, absX: x, absY: y, landed };
}

async function hitTarget(mcp, layout, bounds, label, targetX, targetY) {
  const moved = await moveToEstimatedPoint(mcp, layout, bounds, targetX, targetY, label);
  const landed = moved.landed;
  console.log(JSON.stringify({
    phase: 'target-result',
    label,
    target: { x: targetX, y: targetY },
    landed,
    offset: {
      dx: landed.x - targetX,
      dy: landed.y - targetY
    }
  }, null, 2));
  return moved;
}

async function main() {
  const mcp = spawnMcp();
  const sessionId = `cal-abs-boundary-${Date.now()}`;
  try {
    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'calibration-abs-boundary', version: '0.1.0' }
    });
    if (!init.result) throw new Error('mcp_initialize_failed');

    await openPopup(mcp, sessionId);

    const status = await getStatus(mcp, 'layout-read');
    const layout = status?.layout;
    const viewportWidth = Number(layout?.viewport_width);
    const viewportHeight = Number(layout?.viewport_height);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) {
      throw new Error('missing_layout');
    }

    const centerAbs = 16384;
    const left = await scanBoundary(mcp, {
      axis: 'x',
      startAbs: 0,
      endAbs: absMax,
      fixedAbs: centerAbs,
      direction: 1,
      label: 'left'
    });
    const right = await scanBoundary(mcp, {
      axis: 'x',
      startAbs: absMax,
      endAbs: absMin,
      fixedAbs: centerAbs,
      direction: -1,
      label: 'right'
    });

    const midAbsX = clampAbs((left.abs + right.abs) / 2);
    const top = await scanBoundary(mcp, {
      axis: 'y',
      startAbs: 0,
      endAbs: absMax,
      fixedAbs: midAbsX,
      direction: 1,
      label: 'top'
    });
    const bottom = await scanBoundary(mcp, {
      axis: 'y',
      startAbs: absMax,
      endAbs: absMin,
      fixedAbs: midAbsX,
      direction: -1,
      label: 'bottom'
    });

    const bounds = { left, right, top, bottom };
    console.log(JSON.stringify({ phase: 'boundary-summary', bounds }, null, 2));

    const cornerTargets = [
      { label: 'corner_tl', x: Number(layout?.corner_tl_x), y: Number(layout?.corner_tl_y) },
      { label: 'corner_tr', x: Number(layout?.corner_tr_x), y: Number(layout?.corner_tr_y) },
      { label: 'corner_bl', x: Number(layout?.corner_bl_x), y: Number(layout?.corner_bl_y) },
      { label: 'corner_br', x: Number(layout?.corner_br_x), y: Number(layout?.corner_br_y) }
    ];
    for (const target of cornerTargets) {
      await hitTarget(mcp, layout, bounds, target.label, target.x, target.y);
    }

    const doneX = Number(layout?.done_center_x);
    const doneY = Number(layout?.done_center_y);
    const estimate = await hitTarget(mcp, layout, bounds, 'done-center', doneX, doneY);
    console.log(JSON.stringify({
      phase: 'done-estimate-result',
      target: { x: doneX, y: doneY },
      landed: estimate.landed,
      offset: {
        dx: estimate.landed.x - doneX,
        dy: estimate.landed.y - doneY
      }
    }, null, 2));
  } finally {
    await mcp.stop();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
