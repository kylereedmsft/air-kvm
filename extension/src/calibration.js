const params = new URLSearchParams(globalThis.location.search);
const sessionId = params.get('session_id') || null;
const statusEl = document.getElementById('status');
const doneBtn = document.getElementById('done');
const dotEl = document.getElementById('dot');
const cornerTl = document.getElementById('corner-tl');
const cornerTr = document.getElementById('corner-tr');
const cornerBl = document.getElementById('corner-bl');
const cornerBr = document.getElementById('corner-br');

function updateStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function updateDot(event) {
  if (!dotEl) return;
  dotEl.style.left = `${event.clientX}px`;
  dotEl.style.top = `${event.clientY}px`;
}

function report(event, kind) {
  updateDot(event);
  updateStatus(`Seen via ${kind} at ${event.clientX}, ${event.clientY}`);
  chrome.runtime.sendMessage({
    type: 'calibration.pointer_found',
    session_id: sessionId,
    event: {
      kind,
      client_x: Math.round(event.clientX),
      client_y: Math.round(event.clientY),
      screen_x: Math.round(event.screenX),
      screen_y: Math.round(event.screenY),
      page_x: Math.round(event.pageX),
      page_y: Math.round(event.pageY),
      ts: Date.now()
    }
  }).catch(() => {});
}

function reportDoneClick(event) {
  updateStatus('DONE clicked');
  chrome.runtime.sendMessage({
    type: 'calibration.done_clicked',
    session_id: sessionId,
    ts: Date.now(),
    event: event ? {
      kind: 'click',
      client_x: Math.round(event.clientX),
      client_y: Math.round(event.clientY),
      screen_x: Math.round(event.screenX),
      screen_y: Math.round(event.screenY),
      page_x: Math.round(event.pageX),
      page_y: Math.round(event.pageY)
    } : null
  }).catch(() => {}).finally(() => {
    // Dismiss the calibration popup once the click is reported so the test can
    // immediately continue against the underlying browser window.
    setTimeout(() => window.close(), 80);
  });
}

function reportLayout() {
  if (!doneBtn) return;
  const doneRect = doneBtn.getBoundingClientRect();
  const corners = {
    tl: rectSummary(cornerTl),
    tr: rectSummary(cornerTr),
    bl: rectSummary(cornerBl),
    br: rectSummary(cornerBr)
  };
  chrome.runtime.sendMessage({
    type: 'calibration.layout',
    session_id: sessionId,
    layout: {
      viewport_width: Math.round(window.innerWidth),
      viewport_height: Math.round(window.innerHeight),
      done_left: Math.round(doneRect.left),
      done_top: Math.round(doneRect.top),
      done_width: Math.round(doneRect.width),
      done_height: Math.round(doneRect.height),
      done_center_x: Math.round(doneRect.left + doneRect.width / 2),
      done_center_y: Math.round(doneRect.top + doneRect.height / 2),
      corner_tl_x: corners.tl.x,
      corner_tl_y: corners.tl.y,
      corner_tl_left: corners.tl.left,
      corner_tl_top: corners.tl.top,
      corner_tl_width: corners.tl.width,
      corner_tl_height: corners.tl.height,
      corner_tr_x: corners.tr.x,
      corner_tr_y: corners.tr.y,
      corner_tr_left: corners.tr.left,
      corner_tr_top: corners.tr.top,
      corner_tr_width: corners.tr.width,
      corner_tr_height: corners.tr.height,
      corner_bl_x: corners.bl.x,
      corner_bl_y: corners.bl.y,
      corner_bl_left: corners.bl.left,
      corner_bl_top: corners.bl.top,
      corner_bl_width: corners.bl.width,
      corner_bl_height: corners.bl.height,
      corner_br_x: corners.br.x,
      corner_br_y: corners.br.y,
      corner_br_left: corners.br.left,
      corner_br_top: corners.br.top,
      corner_br_width: corners.br.width,
      corner_br_height: corners.br.height
    }
  }).catch(() => {});
}

function rectSummary(element) {
  if (!element) {
    return { x: null, y: null, left: null, top: null, width: null, height: null };
  }
  const rect = element.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2)
  };
}

window.addEventListener('pointerenter', (event) => report(event, 'pointerenter'), true);
window.addEventListener('mouseenter', (event) => report(event, 'mouseenter'), true);
window.addEventListener('mousemove', (event) => report(event, 'mousemove'), { passive: true });
doneBtn?.addEventListener('click', reportDoneClick);
window.addEventListener('load', reportLayout, { once: true });
