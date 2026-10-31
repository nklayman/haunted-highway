// Headless check of the real game's traffic spawner: runs createGame() with a stub
// canvas for 90 s of game time (crashes are ignored so the run continues) and
// measures the spacing actually produced on the road.
//   node test/traffic.test.mjs
const noop = () => {};
const ctxStub = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop),
  set: (t, k, v) => ((t[k] = v), true),
});
Object.assign(globalThis, {
  addEventListener: noop, requestAnimationFrame: noop, location: { search: '' },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
});
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', getGamepads: () => [] }, configurable: true });

const { createGame } = await import('../web/game.js');
const CAR_L = 58;

let overlaps = 0, minSameLane = Infinity, carsTotal = 0, rowsTotal = 0;
const speedAt = {}, carsPerRow = {};
for (let run = 0; run < 20; run++) {
  const game = createGame({ getContext: () => ctxStub, width: 800, height: 480 });
  const g = game.state;
  game.reset('playing');
  const seen = new Set();
  for (let i = 0; i < 60 * 90; i++) {
    game.step(1 / 60);
    if (g.mode !== 'playing') g.mode = 'playing'; // ignore crashes
    const t = (i + 1) / 60;
    if (run === 0 && Number.isInteger(t) && t % 15 === 0) speedAt[t] = Math.round(g.speed);
    for (const c of g.traffic) if (!seen.has(c)) { seen.add(c); carsTotal++; }
    // only judge cars on visible-ish road ahead of the player
    const cars = g.traffic.filter((c) => c.s > g.s - 300 && c.s < g.s + 600);
    for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
      if (Math.abs(cars[a].lat - cars[b].lat) > 1) continue;
      const gap = Math.abs(cars[a].s - cars[b].s);
      minSameLane = Math.min(minSameLane, gap);
      if (gap < CAR_L) overlaps++;
    }
  }
  for (const c of seen) { const k = c.row ?? 'n/a'; carsPerRow[k] = (carsPerRow[k] || 0) + 1; }
}
console.log({ runs: 20, seconds: 90, overlapFrames: overlaps, minSameLaneGap: Math.round(minSameLane), carLength: CAR_L, carsSpawned: carsTotal });
console.log('speed by time (s -> px/s):', speedAt);
