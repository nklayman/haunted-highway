// The traffic planner promises one lane per row that a player can always reach.
// A bot that only follows that lane, reacting REACTION s after each decision window
// opens (prev row passed, or new row in view), must never crash — at any speed.
//   node test/feasibility.test.mjs
const noop = () => {};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', getGamepads: () => [] }, configurable: true });
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: noop, removeItem: noop } });
const { planRow, SEE_AHEAD, LANE_W, CAR_L, CAR_W, LANE_SPEED, REACTION, MIN_ROW_GAP, ROW_GAP_RANDOM, TRAFFIC_V } = await import('../web/game.js');

let runs = 0, crashes = 0, rows = 0;
for (const [speed, distM] of [[260, 0], [400, 300], [550, 900], [700, 1600], [800, 2500]]) {
  const closing = speed - TRAFFIC_V;
  for (let run = 0; run < 300; run++, runs++) {
    const plan = [];
    let path = 0, lastEnd = 0, at = 800;
    for (let i = 0; i < 60; i++) {
      const r = planRow(path, at - lastEnd, closing, distM);
      plan.push({ at, end: at + r.length, path: r.pathLane, cars: r.cars.map((c) => ({ s: at + c.off, lat: c.lane * LANE_W })) });
      path = r.pathLane; lastEnd = at + r.length; at = lastEnd + MIN_ROW_GAP + Math.random() * ROW_GAP_RANDOM;
    }
    rows += plan.length;
    let x = 0, lat = 0, target = 0, next = 0, crashed = false;
    const dt = 1 / 240;
    while (next < plan.length && !crashed) {
      const prevEnd = next ? plan[next - 1].end : -1e9;
      const openAt = Math.max(prevEnd + CAR_L, plan[next].at - SEE_AHEAD - CAR_L) + REACTION * closing;
      if (x >= openAt) target = plan[next].path * LANE_W;
      if (x > plan[next].end + CAR_L) next++;
      const step = LANE_SPEED * dt;
      lat += Math.max(-step, Math.min(step, target - lat));
      x += closing * dt;
      for (const r of plan) for (const c of r.cars)
        if (Math.abs(c.s - x) < CAR_L * 0.9 && Math.abs(c.lat - lat) < CAR_W * 0.95) crashed = true;
    }
    if (crashed) crashes++;
  }
}
console.log({ runs, rows, crashes });
if (crashes) process.exitCode = 1;
