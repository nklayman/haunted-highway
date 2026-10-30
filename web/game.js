// Lane-runner prototype: the car auto-steers along an endless winding road and
// stays fixed on screen while the world rotates around it. Paddles hop lanes
// to dodge rows of traffic; clutches boost/brake; thumbs start/restart.
import { createWheelInput } from './input.js';

export const W = 800, H = 480;

const DS = 8;                 // track sample spacing (px)
export const LANE_COUNT = 5;
export const LANE_W = 64;
export const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i - (LANE_COUNT - 1) / 2); // e.g. -2..2
const ROAD_W = LANE_W * LANE_COUNT;
const CAR_L = 58, CAR_W = 32;
const LANE_SPEED = 430;       // lateral px/s while hopping lanes
const TRAFFIC_V = 150;        // all traffic moves together so rows keep their gaps
// Arc-length ranges of road to keep and draw. Bends can curve the road back into
// view far along its length, so cover a full loop at the tightest radius (2π·260).
const VIEW_BEHIND = 1000, VIEW_AHEAD = 2000;
const HUD_H = 52;
const CAR_Y = Math.round(H * 0.85);          // car's fixed screen position; low so you can see ahead
export const SEE_AHEAD = CAR_Y - HUD_H - CAR_L / 2; // road visible ahead of the car's nose
const REACTION = 0.2;                         // seconds allowed to spot a row and react
const MIN_ROW_GAP = CAR_L * 2.5;              // last car of one row to first of the next
const ROW_STAGGER = CAR_L * 2;                // cars in a row are spread over this much road
const baseSpeed = (s) => Math.min(650, 260 + s * 0.012);
// Brake meter: you earn brakes by boosting and spend them by braking.
const BRAKE_START = 0.25;    // meter level at the start of a run
const BRAKE_DRAIN_S = 2.5;   // seconds of full braking to empty a full meter
const BRAKE_CHARGE_S = 4;    // seconds of full boost to fill an empty meter
const TRAFFIC_COLORS = ['#e8b830', '#3a8ee8', '#e86a3a', '#9b59d0', '#e8e8e8'];

const HEADING0 = -Math.PI / 2;               // the road's overall direction (up)
const MAX_DEV = (65 * Math.PI) / 180;         // winding limit either side of HEADING0
const K_EASE = 0.03;                          // per-sample easing of curvature toward its target

// Keeping the heading within ±MAX_DEV (+ a little overshoot) of one direction means
// the road always makes forward progress, so it can never fold back over itself.
export class Track {
  constructor() {
    this.pts = [{ s: 0, x: 0, y: 0, th: HEADING0, trees: [] }];
    this.k = 0;
    this.kTarget = 0;
    this.untilChange = 700; // start on a straight
  }

  extendTo(s) {
    while (this.pts.at(-1).s < s) {
      const p = this.pts.at(-1);
      if ((this.untilChange -= DS) <= 0) {
        const straight = Math.random() < 0.3;
        const radius = 260 + Math.random() * 500;
        this.kTarget = straight ? 0 : (Math.random() < 0.5 ? -1 : 1) / radius;
        this.untilChange = 250 + Math.random() * 600;
      }
      // Heading still to come if curvature eased to zero from here is ~k·DS/K_EASE;
      // if that would carry us past the limit, start the opposite bend now.
      const heading = p.th - HEADING0 + (this.k * DS) / K_EASE;
      if (Math.abs(heading) > MAX_DEV && Math.sign(this.kTarget) !== -Math.sign(heading)) {
        this.kTarget = -Math.sign(heading) / (260 + Math.random() * 500);
        this.untilChange = 250 + Math.random() * 600;
      }
      this.k += (this.kTarget - this.k) * K_EASE;
      const th = p.th + this.k * DS;
      const q = { s: p.s + DS, x: p.x + Math.cos(th) * DS, y: p.y + Math.sin(th) * DS, th, trees: [] };
      if (Math.random() < 0.18) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const off = side * (ROAD_W / 2 + 40 + Math.random() * 260);
        q.trees.push({ x: q.x - Math.sin(th) * off, y: q.y + Math.cos(th) * off, r: 14 + Math.random() * 16 });
      }
      this.pts.push(q);
    }
  }

  trimBefore(s) {
    let i = 0;
    while (i < this.pts.length - 2 && this.pts[i + 1].s < s) i++;
    if (i) this.pts.splice(0, i);
  }

  // Interpolated pose at distance s, offset `lat` px to the right of the centreline.
  pose(s, lat = 0) {
    const f = (s - this.pts[0].s) / DS;
    const i = Math.max(0, Math.min(this.pts.length - 2, Math.floor(f)));
    const t = Math.max(0, Math.min(1, f - i));
    const a = this.pts[i], b = this.pts[i + 1];
    const th = a.th + (b.th - a.th) * t;
    return {
      x: a.x + (b.x - a.x) * t - Math.sin(th) * lat,
      y: a.y + (b.y - a.y) * t + Math.cos(th) * lat,
      th,
    };
  }

  range(s0, s1) {
    const i0 = Math.max(0, Math.floor((s0 - this.pts[0].s) / DS));
    const i1 = Math.min(this.pts.length, Math.ceil((s1 - this.pts[0].s) / DS) + 1);
    return this.pts.slice(i0, i1);
  }
}

// How many lanes a player can shift between two rows `gap` apart. The decision
// window opens once the previous row is passed or the new row comes into view,
// whichever is later, and closes when the cars would touch.
export function reachableShift(gap, closing) {
  const window = Math.min(gap - CAR_L, SEE_AHEAD + CAR_L) - CAR_L;
  const t = window / closing - REACTION;
  return Math.max(0, Math.min(LANE_COUNT - 1, Math.floor((t * LANE_SPEED) / LANE_W)));
}

// Plan one traffic row. `prevPath` is the lane guaranteed open in the previous
// row; the new guaranteed lane is always within reach of it, so there is never
// a wall. Other lanes may be blocked freely (dead ends are part of the game).
// `gap` runs from the previous row's last car to this row's start. Cars are
// staggered by `off` (0..ROW_STAGGER) past the start; `length` is the row's extent.
export function planRow(prevPath, gap, closing, distM, rnd = Math.random) {
  const k = reachableShift(gap, closing);
  const options = LANES.filter((l) => Math.abs(l - prevPath) <= k);
  const pathLane = options[Math.floor(rnd() * options.length)];
  // Mostly 1-3 cars; 3 from 600 m; an occasional near-wall of 4 after 1500 m.
  const maxBlocked = Math.min(3, 2 + Math.floor(distM / 600));
  let count = 1 + Math.floor(rnd() * maxBlocked);
  if (distM > 1500 && rnd() < 0.15) count = 4;
  count = Math.min(count, LANE_COUNT - 1);
  const lanes = LANES.filter((l) => l !== pathLane).sort(() => rnd() - 0.5).slice(0, count);
  const cars = lanes.map((lane) => ({ lane, off: rnd() * ROW_STAGGER }));
  const length = Math.max(0, ...cars.map((c) => c.off));
  return { pathLane, cars, length, k };
}

export function createGame(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pollWheel = createWheelInput();
  const keys = new Set(), keyPresses = new Set();
  addEventListener('keydown', (e) => { if (!keys.has(e.code)) keyPresses.add(e.code); keys.add(e.code); });
  addEventListener('keyup', (e) => keys.delete(e.code));

  let best = 0;
  const g = {};

  function reset(mode) {
    Object.assign(g, {
      mode, track: new Track(), s: 0, lane: 0, lat: 0, speed: 260,
      brakeEnergy: BRAKE_START, braking: 0,
      traffic: [], nextRowAt: 800, lastRowEnd: 0, pathLane: 0, crashedAt: 0, time: 0,
    });
    g.track.extendTo(VIEW_AHEAD + 200);
  }
  reset('ready');

  function readInput() {
    const w = pollWheel();
    const kp = (code) => keyPresses.has(code);
    const input = {
      // Paddles on desktop; D-pad too (the only buttons Android Chrome passes through).
      left: w.pressed.leftPaddle || w.pressed.dpadLeft || kp('ArrowLeft') || kp('KeyA'),
      right: w.pressed.rightPaddle || w.pressed.dpadRight || kp('ArrowRight') || kp('KeyD'),
      start: w.pressed.leftThumb || w.pressed.rightThumb || w.pressed.dpadUp || w.pressed.dpadDown ||
        kp('Space') || kp('Enter') || kp('ArrowUp') || kp('ArrowDown'),
      boost: Math.max(w.rightClutch, keys.has('ArrowUp') ? 1 : 0),
      brake: Math.max(w.leftClutch, keys.has('ArrowDown') ? 1 : 0),
      wheel: w.connected,
    };
    keyPresses.clear();
    return input;
  }

  function spawnRow() {
    // Rows all move at TRAFFIC_V, so their spacing never changes; estimate the
    // player's (unboosted) speed when they reach this row to get the closing speed.
    const rowS = g.nextRowAt;
    const meetAt = rowS + ((rowS - g.s) * TRAFFIC_V) / Math.max(80, g.speed - TRAFFIC_V);
    const closing = baseSpeed(meetAt) - TRAFFIC_V;
    const row = planRow(g.pathLane, rowS - g.lastRowEnd, closing, meetAt / 10);
    for (const c of row.cars) {
      const color = TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)];
      g.traffic.push({ s: rowS + c.off, lat: c.lane * LANE_W, color });
    }
    g.pathLane = row.pathLane;
    g.lastRowEnd = rowS + row.length;
    g.nextRowAt = g.lastRowEnd + MIN_ROW_GAP + Math.random() * 260;
  }

  function update(dt, input) {
    g.time += dt;
    if (g.mode !== 'playing') {
      if (input.start && (g.mode === 'ready' || g.time - g.crashedAt > 0.6)) reset('playing');
      return;
    }
    if (input.left) g.lane = Math.max(LANES[0], g.lane - 1);
    if (input.right) g.lane = Math.min(LANES.at(-1), g.lane + 1);
    const target = g.lane * LANE_W;
    const step = LANE_SPEED * dt;
    g.lat += Math.max(-step, Math.min(step, target - g.lat));

    g.braking = g.brakeEnergy > 0 ? input.brake : 0; // empty meter = no brakes
    g.brakeEnergy = Math.min(1, Math.max(0,
      g.brakeEnergy - (g.braking * dt) / BRAKE_DRAIN_S + (input.boost * dt) / BRAKE_CHARGE_S));
    const want = baseSpeed(g.s) * (1 + 0.5 * input.boost - 0.6 * g.braking);
    g.speed += (want - g.speed) * Math.min(1, dt * 2);
    g.s += g.speed * dt;
    for (const c of g.traffic) c.s += TRAFFIC_V * dt;

    while (g.nextRowAt < g.s + VIEW_AHEAD + 300) spawnRow();
    g.traffic = g.traffic.filter((c) => c.s > g.s - VIEW_BEHIND);
    g.track.extendTo(Math.max(g.s, ...g.traffic.map((c) => c.s), g.nextRowAt) + VIEW_AHEAD + 200);
    g.track.trimBefore(g.s - VIEW_BEHIND - 50);

    for (const c of g.traffic) {
      if (Math.abs(c.s - g.s) < CAR_L * 0.9 && Math.abs(c.lat - g.lat) < CAR_W * 0.95) {
        g.mode = 'crashed';
        g.crashedAt = g.time;
        best = Math.max(best, Math.floor(g.s / 10));
      }
    }
  }

  function strokePath(pts, offset, width, color, dash, dashOffset = 0) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = p.x - Math.sin(p.th) * offset, y = p.y + Math.cos(p.th) * offset;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.setLineDash(dash || []);
    ctx.lineDashOffset = dashOffset;
    ctx.stroke();
  }

  function drawCar(pose, color, yaw = 0, player = false) {
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.th + Math.PI / 2 + yaw);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-CAR_W / 2 + 3, -CAR_L / 2 + 4, CAR_W, CAR_L);
    ctx.fillStyle = color;
    ctx.fillRect(-CAR_W / 2, -CAR_L / 2, CAR_W, CAR_L);
    ctx.fillStyle = '#1b2633';
    ctx.fillRect(-CAR_W / 2 + 4, -CAR_L / 2 + 12, CAR_W - 8, 12); // windscreen
    ctx.fillRect(-CAR_W / 2 + 5, CAR_L / 2 - 14, CAR_W - 10, 8);  // rear window
    if (player) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-3, -CAR_L / 2, 6, CAR_L); // racing stripe
    }
    ctx.restore();
  }

  function render() {
    const me = g.track.pose(g.s, g.lat);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2e7d32';
    ctx.fillRect(0, 0, W, H);

    // Camera: car fixed at (W/2, CAR_Y), track heading pointing up.
    ctx.translate(W / 2, CAR_Y);
    ctx.rotate(-me.th - Math.PI / 2);
    ctx.translate(-me.x, -me.y);

    const pts = g.track.range(g.s - VIEW_BEHIND, g.s + VIEW_AHEAD);
    const anchor = pts[0]?.s || 0; // keeps dash patterns fixed to the world
    // Trees first so any that land near a bend sit under the road, not on it.
    ctx.fillStyle = '#1b5e20';
    for (const p of pts) for (const t of p.trees) {
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.lineJoin = 'round';
    strokePath(pts, 0, ROAD_W + 24, '#f2f2f2');
    strokePath(pts, 0, ROAD_W + 24, '#d32f2f', [22, 22], anchor);
    strokePath(pts, 0, ROAD_W, '#4a4a4a');
    for (const l of LANES.slice(1)) strokePath(pts, (l - 0.5) * LANE_W, 4, '#e0e0e0', [26, 30], anchor);
    ctx.setLineDash([]);


    for (const c of g.traffic) drawCar(g.track.pose(c.s, c.lat), c.color);
    const yaw = Math.max(-0.35, Math.min(0.35, ((g.lane * LANE_W - g.lat) / LANE_W) * 0.35));
    drawCar(me, g.mode === 'crashed' ? '#7a1010' : '#d32f2f', yaw, true);

    // HUD
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 52);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.floor(g.s / 10)} m`, 18, 38);
    ctx.textAlign = 'center';
    ctx.fillText(`BEST ${best}`, W / 2, 38);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(g.speed * 0.3)} km/h`, W - 18, 38);

    if (g.mode !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 80, W, 110);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = 'bold 48px system-ui, sans-serif';
      ctx.fillText(g.mode === 'ready' ? 'LANE RACER' : 'CRASHED', W / 2, 132);
      ctx.font = '26px system-ui, sans-serif';
      ctx.fillText('thumb/D-pad to ' + (g.mode === 'ready' ? 'start' : 'restart') + ' · paddles or D-pad change lanes', W / 2, 172);
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, readInput());
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { state: g, reset };
}

// Wheel LED frame for the current game state (layout in wheelleds.js): the top bar
// is the brake meter; the side LEDs blink red when the meter is empty.
export function ledFrame(g, now = performance.now()) {
  const colors = Array.from({ length: 39 }, (_, i) => (i < 21 ? [0, 0, 0] : [12, 12, 16]));
  const e = g.brakeEnergy ?? 0;
  const lit = Math.ceil(e * 15 - 1e-6);
  const base = e > 0.5 ? [0, 200, 40] : e > 0.25 ? [230, 160, 0] : [230, 20, 0];
  const k = g.braking > 0.05 ? 1 : 0.45; // brighter while braking
  for (let i = 0; i < lit; i++) colors[3 + i] = base.map((v) => Math.round(v * k));
  if (g.mode === 'playing' && e <= 0 && Math.floor(now / 200) % 2 === 0) {
    for (const i of [0, 1, 2, 18, 19, 20]) colors[i] = [255, 0, 0];
  }
  return colors;
}
