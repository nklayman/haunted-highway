// Conspit MAX 01 LEDs over SimHub's standard serial protocol (SIMHUB_1.1, 115200 8N1),
// on the wheel's CDC serial interface. Two transports:
//   - SerialLink: Web Serial (desktop Chrome; COM port on Windows)
//   - UsbLink:    WebUSB straight to the CDC data interface (Android Chrome)
//
// Frame: FF×6 "sleds", then 39 × RGB, then FF FE FD. LED order:
//   0-2   left vertical, bottom → top
//   3-17  top bar, left → right
//   18-20 right vertical, top → bottom
//   21-38 button LEDs (all-zero shows the wheel's default purple)
//
// Quirks found by USB capture:
//   - The firmware takes one LED per USB packet (as SimHub sends them), so each
//     RGB triple must be its own write. WebUSB transfers guarantee that; Web Serial
//     needs spacing so Chrome doesn't merge writes.
//   - Web Serial on Windows cuts the outgoing stream every 255 bytes; a write
//     straddling a cut arrives as two packets and shifts every LED after it, so
//     SerialLink pads with zero bytes between frames to keep writes clear of cuts.
//   - Without a fresh frame for a few seconds the wheel reverts to its defaults.

export const WHEEL_VID = 0x3514;
export const LED_COUNT = 39;

const HEADER = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...new TextEncoder().encode('sleds')]);
const SYNC = HEADER.subarray(0, 6);
const TERMINATOR = new Uint8Array([0xff, 0xfe, 0xfd]);
const KEEPALIVE_MS = 1000; // resend so the wheel doesn't revert
const MIN_FRAME_MS = 50;   // cap updates at 20 Hz

// Yield to the event loop without setTimeout's ~4 ms clamp, then spin briefly.
const channel = new MessageChannel();
const waiters = [];
channel.port1.onmessage = () => waiters.shift()();
const yieldNow = () => new Promise((r) => { waiters.push(r); channel.port2.postMessage(0); });
const spin = (us) => { const end = performance.now() + us / 1000; while (performance.now() < end); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SerialLink {
  static CUT = 255;
  static GAP_US = 300;

  static async open(port) {
    await port.open({ baudRate: 115200 });
    const link = new SerialLink();
    link.port = port;
    link.writer = port.writable.getWriter();
    link.sent = 0; // bytes since open, to track where the 255-byte cuts fall
    return link;
  }

  async write(bytes) {
    await this.writer.write(bytes);
    this.sent += bytes.length;
  }

  async pace() { await yieldNow(); spin(SerialLink.GAP_US); }

  // Zero bytes to send before a frame so every write in it falls clear of the cuts.
  padBeforeFrame() {
    const CUT = SerialLink.CUT;
    const straddles = (at, len) => Math.floor(at / CUT) !== Math.floor((at + len - 1) / CUT);
    for (let pad = 0; pad < CUT; pad++) {
      const start = this.sent + pad;
      const ledsAt = start + HEADER.length;
      if (straddles(start, HEADER.length) || ledsAt % 3 !== 0) continue; // CUT % 3 == 0
      if (straddles(ledsAt + LED_COUNT * 3, TERMINATOR.length)) continue;
      return pad;
    }
    return 0;
  }

  async close() { try { this.writer.releaseLock(); await this.port.close(); } catch {} }
}

export class UsbLink {
  static async open(device) {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const link = new UsbLink();
    link.device = device;
    for (const iface of device.configuration.interfaces) {
      const alt = iface.alternates[0];
      if (alt.interfaceClass === 0x02) link.commIface = iface.interfaceNumber; // CDC control
      if (alt.interfaceClass === 0x0a) {                                        // CDC data
        link.dataIface = iface.interfaceNumber;
        link.outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk')?.endpointNumber;
        link.inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk')?.endpointNumber;
      }
    }
    if (link.dataIface == null || link.outEp == null) throw new Error('no CDC data interface on wheel');
    await device.claimInterface(link.dataIface);
    if (link.commIface != null) {
      try {
        await device.claimInterface(link.commIface);
        const ctl = (request, value, data) => device.controlTransferOut(
          { requestType: 'class', recipient: 'interface', request, value, index: link.commIface }, data);
        await ctl(0x20, 0, new Uint8Array([0x00, 0xc2, 0x01, 0x00, 0x00, 0x00, 0x08])); // SET_LINE_CODING 115200 8N1
        await ctl(0x22, 0x03);                                                           // SET_CONTROL_LINE_STATE DTR|RTS
      } catch (e) { link.commError = e.message; }
    }
    return link;
  }

  async write(bytes) { await this.device.transferOut(this.outEp, bytes); }
  async pace() {}
  padBeforeFrame() { return 0; }

  // Send a SimHub query (e.g. "proto") and return the reply text, or '' on timeout.
  async query(cmd, timeoutMs = 500) {
    await this.write(SYNC);
    await this.write(new TextEncoder().encode(cmd));
    const reply = this.device.transferIn(this.inEp, 64).then((r) => new TextDecoder().decode(r.data));
    return Promise.race([reply, sleep(timeoutMs).then(() => '')]);
  }

  async close() { try { await this.device.releaseInterface(this.dataIface); } catch {} }
}

export class WheelLeds {
  constructor(link, log = () => {}) {
    this.link = link;
    this.log = log;
    this.colors = Array.from({ length: LED_COUNT }, () => [0, 0, 0]);
    this.dirty = true;
    this.closed = false;
    this.loop();
  }

  static async openSerial(port, log) { return new WheelLeds(await SerialLink.open(port), log); }
  static async openUsb(device, log) { return new WheelLeds(await UsbLink.open(device), log); }

  // colors: array of [r, g, b] (0-255), indexed as in the layout above.
  set(colors) {
    for (let i = 0; i < LED_COUNT; i++) {
      const c = colors[i] || [0, 0, 0];
      const cur = this.colors[i];
      if (cur[0] !== c[0] || cur[1] !== c[1] || cur[2] !== c[2]) { this.colors[i] = [c[0], c[1], c[2]]; this.dirty = true; }
    }
  }

  async sendFrame() {
    const link = this.link;
    const pad = link.padBeforeFrame();
    if (pad) { await link.write(new Uint8Array(pad)); await link.pace(); }
    await link.write(HEADER);
    await link.pace();
    for (const [r, g, b] of this.colors) {
      await link.write(new Uint8Array([r, g, b]));
      await link.pace();
    }
    await link.write(TERMINATOR);
  }

  async loop() {
    let lastSent = -Infinity;
    while (!this.closed) {
      const now = performance.now();
      if ((this.dirty && now - lastSent >= MIN_FRAME_MS) || now - lastSent >= KEEPALIVE_MS) {
        this.dirty = false;
        lastSent = now;
        try { await this.sendFrame(); }
        catch (e) { this.log('led write failed:', e.message); this.closed = true; break; }
      }
      await sleep(10);
    }
  }

  async close() {
    this.closed = true;
    await this.link.close();
  }
}

// Connect to the wheel's LEDs with whichever transport fits this platform:
// WebUSB on Android (its Web Serial doesn't list USB serial devices), Web Serial
// elsewhere (on Windows the serial interface belongs to the COM-port driver).
// With gesture=false only previously-granted devices are used (no picker).
export function preferredTransport() {
  if (navigator.usb && (/Android/i.test(navigator.userAgent) || !navigator.serial)) return 'usb';
  return navigator.serial ? 'serial' : null;
}

export async function openLink({ gesture = false, transport = preferredTransport() } = {}) {
  if (transport === 'usb') {
    const devs = await navigator.usb.getDevices();
    const dev = devs.find((d) => d.vendorId === WHEEL_VID) ||
      (gesture ? await navigator.usb.requestDevice({ filters: [{ vendorId: WHEEL_VID }] }) : null);
    return dev ? UsbLink.open(dev) : null;
  }
  if (transport === 'serial') {
    const ports = await navigator.serial.getPorts();
    const port = ports.find((p) => p.getInfo().usbVendorId === WHEEL_VID) ||
      (gesture ? await navigator.serial.requestPort({ filters: [{ usbVendorId: WHEEL_VID }] }) : null);
    return port ? SerialLink.open(port) : null;
  }
  throw new Error('no WebUSB or Web Serial in this browser');
}
