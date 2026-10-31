// Display test page: owns the WebUSB device and runs JS sent from the dev
// bridge (server.mjs) so the screen can be driven from a terminal.
import * as vc from './vocore.js?v=cb76581';
import { startBridge, bridgeLog } from './bridge.js?v=cb76581';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

let dev = null;
let bridgeState = 'connecting…';

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
  bridgeLog(line);
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

const helpers = { vc, canvas, ctx, log, get dev() { return dev; } };
window.rw = helpers; // handy from DevTools too

startBridge(() => ({ rw: helpers, vc, dev, canvas, ctx, log }), (state) => { bridgeState = state; renderStatus(); });
