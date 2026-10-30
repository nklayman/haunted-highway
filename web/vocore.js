// VoCore USB screen driver over WebUSB.
// Protocol (per VoCore's Linux/SimHub drivers): vendor control-out request 0xB0
// carries a command; a frame is "0x00 0x2C <len:24le> 0x00" followed by the
// raw RGB565 pixels on the bulk OUT endpoint.

export const VENDOR_ID = 0xc872;

// Conspit MAX 01: 4" panel is 480x800 portrait-native, mounted sideways.
// Draw at 800x480 landscape; frames are rotated 270° clockwise before sending.
export const WIDTH = 800;
export const HEIGHT = 480;
export const PANEL_ROTATE = 270;

export function describe(dev) {
  return {
    vendorId: hex(dev.vendorId),
    productId: hex(dev.productId),
    manufacturer: dev.manufacturerName,
    product: dev.productName,
    serial: dev.serialNumber,
    usbVersion: `${dev.usbVersionMajor}.${dev.usbVersionMinor}.${dev.usbVersionSubminor}`,
    deviceVersion: `${dev.deviceVersionMajor}.${dev.deviceVersionMinor}.${dev.deviceVersionSubminor}`,
    class: [dev.deviceClass, dev.deviceSubclass, dev.deviceProtocol],
    opened: dev.opened,
    configurations: dev.configurations.map((c) => ({
      value: c.configurationValue,
      name: c.configurationName,
      interfaces: c.interfaces.map((i) => ({
        number: i.interfaceNumber,
        claimed: i.claimed,
        alternates: i.alternates.map((a) => ({
          setting: a.alternateSetting,
          class: [a.interfaceClass, a.interfaceSubclass, a.interfaceProtocol],
          name: a.interfaceName,
          endpoints: a.endpoints.map((e) => ({ number: e.endpointNumber, direction: e.direction, type: e.type, packetSize: e.packetSize })),
        })),
      })),
    })),
  };
}

export async function open(dev) {
  if (!dev.opened) await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  const iface = dev.configuration.interfaces[0];
  if (!iface.claimed) await dev.claimInterface(iface.interfaceNumber);
  return bulkOutEndpoint(dev);
}

// Open, wake and light the backlight. Returns the bulk OUT endpoint for sendFrame.
export async function init(dev, { brightness = 255 } = {}) {
  const ep = await open(dev);
  await wake(dev);
  await setBrightness(dev, brightness);
  return ep;
}

export function bulkOutEndpoint(dev) {
  for (const iface of dev.configuration.interfaces) {
    for (const ep of iface.alternate.endpoints) {
      if (ep.direction === 'out' && ep.type === 'bulk') return ep.endpointNumber;
    }
  }
  throw new Error('no bulk OUT endpoint');
}

export function cmd(dev, bytes) {
  return dev.controlTransferOut(
    { requestType: 'vendor', recipient: 'device', request: 0xb0, value: 0, index: 0 },
    new Uint8Array(bytes),
  );
}

export const wake = (dev) => cmd(dev, [0x00, 0x29]);

// 0-255. Must be this 8-byte form; a short 0x51 command blanks the backlight.
export const setBrightness = (dev, level) => cmd(dev, [0x00, 0x51, 0x02, 0x00, 0x00, 0x00, level & 0xff, 0x00]);

export async function sendFrame(dev, ep, pixels) {
  const n = pixels.byteLength;
  await cmd(dev, [0x00, 0x2c, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0x00]);
  return dev.transferOut(ep, pixels);
}

// Canvas RGBA -> RGB565. Little-endian by default; flip if colours look scrambled.
// rotate (0/90/180/270, clockwise) maps the logical canvas onto the panel's native scan order.
export function toRGB565(ctx, w, h, { bigEndian = false, rotate = PANEL_ROTATE } = {}) {
  if (rotate) {
    const swap = rotate === 90 || rotate === 270;
    const tmp = new OffscreenCanvas(swap ? h : w, swap ? w : h);
    const t = tmp.getContext('2d', { willReadFrequently: true });
    t.translate(tmp.width / 2, tmp.height / 2);
    t.rotate((rotate * Math.PI) / 180);
    t.drawImage(ctx.canvas, 0, 0, w, h, -w / 2, -h / 2, w, h);
    return toRGB565(t, tmp.width, tmp.height, { bigEndian, rotate: 0 });
  }
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 2);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 2) {
    const v = ((src[i] & 0xf8) << 8) | ((src[i + 1] & 0xfc) << 3) | (src[i + 2] >> 3);
    if (bigEndian) { out[j] = v >> 8; out[j + 1] = v & 0xff; }
    else { out[j] = v & 0xff; out[j + 1] = v >> 8; }
  }
  return out;
}

const hex = (n) => '0x' + n.toString(16).padStart(4, '0');
