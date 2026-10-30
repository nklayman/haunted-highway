// Display test page: owns the WebUSB device and runs JS sent from the dev
// bridge (server.mjs) so the screen can be driven from a terminal.
import * as vc from './vocore.js';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

let dev = null;
let ws = null;
let bridgeState = 'connecting…';

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', line }));
}

function renderStatus() {
  const d = dev ? `${dev.productName || 'device'} (${dev.opened ? 'open' : 'closed'})` : 'none';
  statusEl.textContent = `bridge: ${bridgeState} · device: ${d}`;
}

async function useDevice(d) {
  dev = d;
  log('device selected:', vc.describe(d).product, vc.describe(d).productId);
  renderStatus();
}

document.getElementById('connect').onclick = async () => {
  try {
    await useDevice(await navigator.usb.requestDevice({ filters: [{ vendorId: vc.VENDOR_ID }] }));
  } catch (e) {
    log('requestDevice failed:', e.message);
  }
};

if (!navigator.usb) {
  log(isSecureContext
    ? 'WebUSB not available in this browser'
    : `WebUSB needs a secure origin: add ${location.origin} to chrome://flags/#unsafely-treat-insecure-origin-as-secure`);
} else {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (e.device === dev) { dev = null; log('device disconnected'); renderStatus(); }
  });
  navigator.usb.addEventListener('connect', (e) => {
    if (e.device.vendorId === vc.VENDOR_ID) { useDevice(e.device); }
  });
  // Previously-granted devices come back without a click.
  const granted = (await navigator.usb.getDevices()).filter((d) => d.vendorId === vc.VENDOR_ID);
  if (granted.length) await useDevice(granted[0]);
}

// Make WebUSB result objects (getters on prototypes, DataViews) JSON-friendly.
function plain(v, depth = 0) {
  if (v == null || typeof v !== 'object') return v;
  if (depth > 6) return '[depth]';
  if (v instanceof DataView) v = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (ArrayBuffer.isView(v)) {
    const bytes = Array.from(v.slice(0, 256), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return { bytes: v.length > 256 ? bytes + ` … (${v.length} total)` : bytes };
  }
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  const out = {};
  for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || k in out) continue;
      try { const x = v[k]; if (typeof x !== 'function') out[k] = plain(x, depth + 1); } catch {}
    }
  }
  return out;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const helpers = { vc, canvas, ctx, log, get dev() { return dev; } };
window.rw = helpers; // handy from DevTools too

function connectBridge() {
  ws = new WebSocket(`ws://${location.host}/bridge`);
  ws.onopen = () => { bridgeState = 'connected'; renderStatus(); };
  ws.onclose = () => { bridgeState = 'disconnected (retrying)'; renderStatus(); setTimeout(connectBridge, 1000); };
  ws.onmessage = async (ev) => {
    const { id, code } = JSON.parse(ev.data);
    try {
      const fn = new AsyncFunction('rw', 'vc', 'dev', 'canvas', 'ctx', 'log', code);
      const result = await fn(helpers, vc, dev, canvas, ctx, log);
      ws.send(JSON.stringify({ id, result: plain(result) }));
    } catch (e) {
      ws.send(JSON.stringify({ id, error: `${e.name}: ${e.message}` }));
    }
  };
}
// The dev bridge only exists when served by server.mjs over plain http;
// deployed (https) builds run standalone.
if (location.protocol === 'http:') connectBridge();
else bridgeState = 'off (deployed)';
renderStatus();
