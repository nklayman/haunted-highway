// Render game frames to PNGs with a real 2D canvas, to eyeball visuals headlessly.
//   node test/render-preview.mjs   -> test/out/*.png
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
const noop = () => {};
const handlers = {};
Object.assign(globalThis, {
  addEventListener: (t, f) => ((handlers[t] ||= []).push(f)), requestAnimationFrame: noop, location: { search: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  OffscreenCanvas: class { constructor(w, h) { return createCanvas(w, h); } },
});
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', getGamepads: () => [] }, configurable: true });

const { createGame } = await import('../web/game.js');
const canvas = createCanvas(800, 480);
const game = createGame(canvas);
const g = game.state;
const save = (name) => fs.writeFileSync(new URL(`./out/${name}.png`, import.meta.url), canvas.toBuffer('image/png'));

game.step(1 / 60); save('1-title');
game.reset('playing');
for (let i = 0; i < 60 * 12; i++) { game.step(1 / 60); if (g.mode !== 'playing') g.mode = 'playing'; }
save('2-playing');
g.traffic.push({ s: g.s, lat: g.lat, color: '#fff' }); game.step(1 / 60); for (let i = 0; i < 40; i++) game.step(1 / 60);
save('3-crashed');
console.log('mode after crash:', g.mode);
