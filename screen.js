// Mirrors a canvas onto the wheel screen: handles connect/reconnect and streams
// frames back-to-back (each send starts as soon as the previous transfer ends).
import * as vc from './vocore.js?v=3e82b21';

export function createScreen(canvas, { onStatus = () => {}, log = console.log } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let dev = null, ep = null;
  let frames = 0, fps = 0, lastFpsAt = performance.now();

  async function attach(d) {
    try {
      ep = await vc.init(d);
      dev = d;
      onStatus(`screen: ${d.productName}`);
      log('screen connected');
    } catch (e) {
      log('screen init failed:', e.message);
      onStatus('screen: init failed');
    }
  }

  async function pump() {
    for (;;) {
      if (!dev) { await new Promise((r) => setTimeout(r, 200)); continue; }
      try {
        await vc.sendFrame(dev, ep, vc.toRGB565(ctx, vc.WIDTH, vc.HEIGHT));
        frames++;
        const now = performance.now();
        if (now - lastFpsAt >= 1000) { fps = (frames * 1000) / (now - lastFpsAt); frames = 0; lastFpsAt = now; }
      } catch (e) {
        log('screen send failed:', e.message);
        dev = null;
        onStatus('screen: lost');
      }
    }
  }

  if (navigator.usb) {
    navigator.usb.getDevices().then((ds) => {
      const d = ds.find((x) => x.vendorId === vc.VENDOR_ID);
      if (d) attach(d);
    });
    navigator.usb.addEventListener('connect', (e) => { if (e.device.vendorId === vc.VENDOR_ID) attach(e.device); });
    navigator.usb.addEventListener('disconnect', (e) => {
      if (e.device === dev) { dev = null; onStatus('screen: disconnected'); }
    });
    pump();
  } else {
    onStatus(isSecureContext ? 'screen: WebUSB unsupported' : 'screen: WebUSB needs https');
  }

  return {
    async connect() {
      const d = await navigator.usb.requestDevice({ filters: [{ vendorId: vc.VENDOR_ID }] });
      await attach(d);
    },
    get connected() { return !!dev; },
    get fps() { return fps; },
    get dev() { return dev; },
  };
}
