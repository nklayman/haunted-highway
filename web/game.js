// Lane-runner prototype: the car auto-steers along an endless winding road and
// stays fixed on screen while the world rotates around it. Paddles hop lanes
// to dodge rows of traffic; clutches boost/brake; thumbs start/restart.
import { createWheelInput } from './input.js';
import * as board from './leaderboard.js';
import { createNameEntry, handleNameInput, drawNameEntry } from './nameentry.js';

export const W = 800, H = 480;

const DS = 8;                 // track sample spacing (px)
export const LANE_COUNT = 5;
export const LANE_W = 64;
export const LANES = Array.from({ length: LANE_COUNT }, (_, i) => i - (LANE_COUNT - 1) / 2); // e.g. -2..2
const ROAD_W = LANE_W * LANE_COUNT;
export const CAR_L = 58, CAR_W = 32;
export const LANE_SPEED = 430;       // lateral px/s while hopping lanes
export const TRAFFIC_V = 150;        // all traffic moves together so rows keep their gaps
// Arc-length ranges of road to keep and draw. Bends can curve the road back into
// view far along its length, so cover a full loop at the tightest radius (2π·260).
const VIEW_BEHIND = 1000, VIEW_AHEAD = 2000;
const HUD_H = 52;
const CAR_Y = Math.round(H * 0.85);          // car's fixed screen position; low so you can see ahead
export const SEE_AHEAD = CAR_Y - HUD_H - CAR_L / 2; // road visible ahead of the car's nose
export const REACTION = 0.2;                         // seconds allowed to spot a row and react
export const MIN_ROW_GAP = CAR_L * 4;
const FIRST_ROW_AT = 520;                // last car of one row to first of the next
export const ROW_GAP_RANDOM = 300;                   // plus up to this much extra
const ROW_STAGGER = CAR_L * 2;                // cars in a row are spread over this much road
const baseSpeed = (s) => Math.min(800, 260 + s * 0.025);
// Brake meter: you earn brakes by boosting and spend them by braking.
const BRAKE_START = 0.25;    // meter level at the start of a run
const BRAKE_DRAIN_S = 2.5;   // seconds of full braking to empty a full meter
const BRAKE_CHARGE_S = 4;    // seconds of full boost to fill an empty meter
// Halloween theme. Traffic is drawn as ghosts (same hitbox as a car).
const TRAFFIC_COLORS = ['#f4f4ff', '#d9f4ff', '#ece0ff', '#e0ffe4'];
const THEME = {
  ground: '#1d1028', road: '#2b2833', kerb: '#111', kerbDash: '#ff7a00', laneDash: '#ff9a3c',
  player: '#ff7a00', playerCrashed: '#6b2a00', accent: '#ff7a00', panel: '#2d1b3d',
};

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
        const roll = Math.random();
        const kind = roll < 0.45 ? 'tree' : roll < 0.75 ? 'pumpkin' : 'grave';
        q.trees.push({ x: q.x - Math.sin(th) * off, y: q.y + Math.cos(th) * off, r: 14 + Math.random() * 16, kind, a: Math.random() * Math.PI * 2 });
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
// Traffic density ramps gently within a narrow band: rows are normally 2 cars; some
// 1-car rows early on (fading out by 300 m), and 3-car rows growing from 300 m to a
// 60% share at 1800 m (about when top speed arrives). Never more than 3, so at least
// two lanes are always open.
export function carsInRow(distM, rnd = Math.random) {
  const p1 = Math.max(0, 0.25 * (1 - distM / 300));
  const p3 = Math.min(0.6, Math.max(0, (distM - 300) / 2500));
  const r = rnd();
  return r < p1 ? 1 : r < p1 + p3 ? 3 : 2;
}

// `gap` runs from the previous row's last car to this row's start. Cars are
// staggered by `off` (0..ROW_STAGGER) past the start; `length` is the row's extent.
export function planRow(prevPath, gap, closing, distM, rnd = Math.random, first = false) {
  const k = reachableShift(gap, closing);
  // Usually make the player move: when the path can shift, move it and block the lane
  // it was in (where a player following it will be). Strongly at the start so the
  // opening rows can't be ignored; half the time later on.
  const forceMove = k >= 1 && (first || rnd() < (distM < 300 ? 0.9 : 0.5));
  const options = LANES.filter((l) => Math.abs(l - prevPath) <= k && !(forceMove && l === prevPath));
  const pathLane = options[Math.floor(rnd() * options.length)];
  const count = Math.min(carsInRow(distM, rnd), LANE_COUNT - 1);
  const others = LANES.filter((l) => l !== pathLane && !(forceMove && l === prevPath)).sort(() => rnd() - 0.5);
  const lanes = (forceMove ? [prevPath, ...others] : others).slice(0, count);
  const cars = lanes.map((lane) => ({ lane, off: rnd() * ROW_STAGGER }));
  const length = Math.max(0, ...cars.map((c) => c.off));
  return { pathLane, cars, length, k };
}

export function createGame(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pollWheel = createWheelInput();
  const keys = new Set(), keyPresses = new Set(), typed = [], taps = [];
  addEventListener('keydown', (e) => {
    if (!keys.has(e.code)) keyPresses.add(e.code);
    keys.add(e.code);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) typed.push(e.key);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  let best = 0;
  const g = {};
  const ui = { choice: 0, canSave: false, entry: null, board: null, enteredAt: 0 };
  const topScore = () => board.load()[0]?.score ?? 0;

  function reset(mode) {
    Object.assign(g, {
      mode, track: new Track(), s: 0, lane: 0, lat: 0, speed: 260,
      brakeEnergy: BRAKE_START, braking: 0,
      // First row starts just past the top of the screen and always blocks the start lane.
      traffic: [], nextRowAt: FIRST_ROW_AT, lastRowEnd: 0, pathLane: 0, firstRow: true, crashedAt: 0, time: 0,
    });
    g.track.extendTo(VIEW_AHEAD + 200);
  }
  reset('ready');

  const debug = new URLSearchParams(location.search).has('debug');
  let lastWheel = null;

  // Clutch "clicks" for menus: count a pull once it passes 0.7, re-arm below 0.3.
  const clutch = { left: false, right: false };
  function clutchEdge(side, v) {
    if (!clutch[side] && v > 0.7) { clutch[side] = true; return true; }
    if (clutch[side] && v < 0.3) clutch[side] = false;
    return false;
  }

  function readInput() {
    const w = pollWheel();
    lastWheel = w;
    const kp = (code) => keyPresses.has(code);
    const input = {
      // Paddles on desktop; D-pad too (the only buttons Android Chrome passes through).
      left: w.pressed.leftPaddle || w.pressed.dpadLeft || kp('ArrowLeft'),
      right: w.pressed.rightPaddle || w.pressed.dpadRight || kp('ArrowRight'),
      up: w.pressed.dpadUp || kp('ArrowUp'),
      down: w.pressed.dpadDown || kp('ArrowDown'),
      // Menu confirm/back: right/left clutch pulls work everywhere; thumbs on desktop.
      confirmPad: clutchEdge('right', w.rightClutch) || w.pressed.leftThumb || w.pressed.rightThumb,
      back: clutchEdge('left', w.leftClutch),
      cancel: kp('Escape'),
      confirmKey: kp('Enter') || kp('Space'),
      enter: kp('Enter'),
      backspace: kp('Backspace'),
      chars: typed.splice(0),
      taps: taps.splice(0),
      // Held D-pad up/down (or arrow keys) = full boost/brake, alongside the analog clutches.
      boost: Math.max(w.rightClutch, w.dpadUp || keys.has('ArrowUp') ? 1 : 0),
      brake: Math.max(w.leftClutch, w.dpadDown || keys.has('ArrowDown') ? 1 : 0),
      wheel: w.connected,
    };
    input.confirm = input.confirmPad || input.confirmKey;
    keyPresses.clear();
    return input;
  }

  // Touch/click targets for menu screens, in canvas coordinates.
  const BTN = {
    start: { x: 300, y: 392, w: 200, h: 64, label: 'START' },
    save: { x: 150, y: 300, w: 230, h: 72, label: 'SAVE SCORE' },
    again: { x: 420, y: 300, w: 230, h: 72, label: 'PLAY AGAIN' },
    againSolo: { x: 285, y: 300, w: 230, h: 72, label: 'PLAY AGAIN' },
    boardAgain: { x: 285, y: 404, w: 230, h: 60, label: 'PLAY AGAIN' },
  };
  const hit = (t, b) => t.x >= b.x && t.x < b.x + b.w && t.y >= b.y && t.y < b.y + b.h;

  function gameOver() {
    const score = Math.floor(g.s / 10);
    best = Math.max(best, score);
    g.mode = 'over';
    g.crashedAt = g.time;
    ui.canSave = board.qualifies(score);
    ui.choice = ui.canSave ? 0 : 1;
  }

  function updateMenus(input) {
    const settled = g.time - g.crashedAt > 0.6; // ignore inputs still held from the crash
    if (g.mode === 'ready') {
      if (input.confirm || input.up || input.down || input.taps.some((t) => hit(t, BTN.start))) reset('playing');
    } else if (g.mode === 'over' && settled) {
      if (ui.canSave && (input.left || input.right)) ui.choice ^= 1;
      let act = input.confirm ? (ui.choice === 0 ? 'save' : 'again') : null;
      for (const t of input.taps) {
        if (ui.canSave && hit(t, BTN.save)) act = 'save';
        if (hit(t, ui.canSave ? BTN.again : BTN.againSolo)) act = 'again';
      }
      if (act === 'again') reset('playing');
      if (act === 'save') { g.mode = 'naming'; ui.entry = createNameEntry(); }
    } else if (g.mode === 'naming') {
      const result = handleNameInput(ui.entry, input);
      if (result === 'cancel') { g.mode = 'over'; g.crashedAt = g.time; return; }
      if (result === 'done') {
        ui.board = board.add(ui.entry.name, Math.floor(g.s / 10));
        g.mode = 'board';
        ui.enteredAt = g.time;
      }
    } else if (g.mode === 'board' && g.time - ui.enteredAt > 0.4) {
      if (input.confirm || input.taps.some((t) => hit(t, BTN.boardAgain))) reset('playing');
    }
  }

  function spawnRow() {
    // Rows all move at TRAFFIC_V, so their spacing never changes; estimate the
    // player's (unboosted) speed when they reach this row to get the closing speed.
    const rowS = g.nextRowAt;
    const meetAt = rowS + ((rowS - g.s) * TRAFFIC_V) / Math.max(80, g.speed - TRAFFIC_V);
    const closing = baseSpeed(meetAt) - TRAFFIC_V;
    const row = planRow(g.pathLane, rowS - g.lastRowEnd, closing, meetAt / 10, Math.random, g.firstRow);
    g.firstRow = false;
    for (const c of row.cars) {
      const color = TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)];
      g.traffic.push({ s: rowS + c.off, lat: c.lane * LANE_W, color });
    }
    g.pathLane = row.pathLane;
    g.lastRowEnd = rowS + row.length;
    g.nextRowAt = g.lastRowEnd + MIN_ROW_GAP + Math.random() * ROW_GAP_RANDOM;
  }

  function update(dt, input) {
    g.time += dt;
    if (g.mode !== 'playing') { updateMenus(input); return; }
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
    // Row bookmarks live in the traffic's moving frame too; otherwise each new row is
    // placed relative to where the previous row *was*, and the real gaps shrink.
    g.nextRowAt += TRAFFIC_V * dt;
    g.lastRowEnd += TRAFFIC_V * dt;

    while (g.nextRowAt < g.s + VIEW_AHEAD + 300) spawnRow();
    g.traffic = g.traffic.filter((c) => c.s > g.s - VIEW_BEHIND);
    g.track.extendTo(Math.max(g.s, ...g.traffic.map((c) => c.s), g.nextRowAt) + VIEW_AHEAD + 200);
    g.track.trimBefore(g.s - VIEW_BEHIND - 50);

    for (const c of g.traffic) {
      if (Math.abs(c.s - g.s) < CAR_L * 0.9 && Math.abs(c.lat - g.lat) < CAR_W * 0.95) {
        gameOver();
        break;
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

  // Roadside decor, drawn top-down in world space.
  function drawDecor(t, now) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.a);
    if (t.kind === 'pumpkin') {
      const r = t.r * 0.8;
      ctx.fillStyle = 'rgba(255,140,0,0.18)'; // glow
      ctx.beginPath(); ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e86a00';
      ctx.beginPath(); ctx.ellipse(0, 0, r * 1.15, r, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#b84d00'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.45, r, 0, 0, Math.PI * 2); ctx.stroke();
      const flicker = 0.75 + 0.25 * Math.sin(now / 90 + t.a * 10);
      ctx.fillStyle = `rgba(255,230,120,${flicker})`; // carved face
      ctx.beginPath(); ctx.moveTo(-r * 0.6, -r * 0.25); ctx.lineTo(-r * 0.25, -r * 0.25); ctx.lineTo(-r * 0.42, -r * 0.55); ctx.fill();
      ctx.beginPath(); ctx.moveTo(r * 0.6, -r * 0.25); ctx.lineTo(r * 0.25, -r * 0.25); ctx.lineTo(r * 0.42, -r * 0.55); ctx.fill();
      ctx.fillRect(-r * 0.55, r * 0.15, r * 1.1, r * 0.28);
      ctx.fillStyle = '#3a5a1a'; ctx.fillRect(-2, -r - 4, 4, 7); // stem
    } else if (t.kind === 'grave') {
      const w = t.r * 1.1, h = t.r * 1.5;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-w / 2 + 4, -h / 2 + 4, w, h);
      ctx.fillStyle = '#6f6a7a';
      ctx.beginPath(); ctx.moveTo(-w / 2, h / 2); ctx.lineTo(-w / 2, -h / 2 + w / 2);
      ctx.arc(0, -h / 2 + w / 2, w / 2, Math.PI, 0); ctx.lineTo(w / 2, h / 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#3f3b48'; ctx.fillRect(-2, -h / 4, 4, h * 0.45); ctx.fillRect(-w / 4, -h / 8, w / 2, 4); // cross
    } else {
      ctx.strokeStyle = '#120a18'; ctx.lineCap = 'round'; // dead tree: bare branches from above
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2, len = t.r * (1.1 + (i % 2) * 0.5);
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len); ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(Math.cos(ang) * len * 0.6, Math.sin(ang) * len * 0.6);
        ctx.lineTo(Math.cos(ang + 0.5) * len * 0.95, Math.sin(ang + 0.5) * len * 0.95); ctx.stroke();
      }
      ctx.fillStyle = '#2a1a22'; ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Traffic ghost: head at the front, wavy tail trailing behind, inside the car hitbox.
  function drawGhost(pose, color, now, seed) {
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.th + Math.PI / 2);
    const r = CAR_W / 2, top = -CAR_L / 2, bottom = CAR_L / 2;
    const body = () => {
      ctx.beginPath();
      ctx.arc(0, top + r, r, Math.PI, 0);
      ctx.lineTo(r, bottom - 6);
      const waves = 3, phase = now / 140 + seed;
      for (let i = 0; i <= waves * 2; i++) {
        const x = r - (i / (waves * 2)) * 2 * r;
        ctx.lineTo(x, bottom - 6 + (i % 2 ? 6 : 0) + Math.sin(phase + i) * 2);
      }
      ctx.closePath();
    };
    ctx.fillStyle = 'rgba(200,220,255,0.16)'; // halo
    ctx.save(); ctx.scale(1.35, 1.15); body(); ctx.fill(); ctx.restore();
    ctx.fillStyle = color;
    body(); ctx.fill();
    ctx.fillStyle = '#16121c'; // eyes look ahead
    ctx.beginPath(); ctx.ellipse(-6, top + r - 2, 3.5, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6, top + r - 2, 3.5, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // A few bats flapping across the screen (screen space, purely decorative).
  const bats = Array.from({ length: 3 }, (_, i) => ({ x: Math.random() * W, y: 70 + Math.random() * 200, v: 40 + Math.random() * 50, dir: i % 2 ? 1 : -1, ph: Math.random() * 6 }));
  function drawBats(dt, now) {
    ctx.fillStyle = '#0b0610';
    for (const b of bats) {
      b.x += b.v * b.dir * dt;
      b.y += Math.sin(now / 400 + b.ph) * 0.4;
      if (b.x < -40 || b.x > W + 40) { b.dir *= -1; b.y = 70 + Math.random() * 220; }
      const flap = Math.sin(now / 70 + b.ph) * 7;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.quadraticCurveTo(b.x - 9, b.y - 8 - flap, b.x - 18, b.y - flap);
      ctx.quadraticCurveTo(b.x - 10, b.y - 2, b.x - 6, b.y + 3);
      ctx.lineTo(b.x, b.y + 1);
      ctx.lineTo(b.x + 6, b.y + 3);
      ctx.quadraticCurveTo(b.x + 10, b.y - 2, b.x + 18, b.y - flap);
      ctx.quadraticCurveTo(b.x + 9, b.y - 8 - flap, b.x, b.y);
      ctx.fill();
    }
  }
  const vignette = ctx.createRadialGradient(W / 2, CAR_Y - 80, 160, W / 2, CAR_Y - 80, 560);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(8,0,16,0.75)');

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
      ctx.fillStyle = '#111';
      ctx.fillRect(-3, -CAR_L / 2, 6, CAR_L); // racing stripe
    }
    ctx.restore();
  }

  let lastRender = performance.now();
  function render() {
    const now = performance.now();
    const rdt = Math.min(0.05, (now - lastRender) / 1000);
    lastRender = now;
    const me = g.track.pose(g.s, g.lat);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = THEME.ground;
    ctx.fillRect(0, 0, W, H);

    // Camera: car fixed at (W/2, CAR_Y), track heading pointing up.
    ctx.translate(W / 2, CAR_Y);
    ctx.rotate(-me.th - Math.PI / 2);
    ctx.translate(-me.x, -me.y);

    const pts = g.track.range(g.s - VIEW_BEHIND, g.s + VIEW_AHEAD);
    const anchor = pts[0]?.s || 0; // keeps dash patterns fixed to the world
    // Trees first so any that land near a bend sit under the road, not on it.
    for (const p of pts) for (const t of p.trees) drawDecor(t, now);
    ctx.lineJoin = 'round';
    strokePath(pts, 0, ROAD_W + 24, THEME.kerb);
    strokePath(pts, 0, ROAD_W + 24, THEME.kerbDash, [22, 22], anchor);
    strokePath(pts, 0, ROAD_W, THEME.road);
    for (const l of LANES.slice(1)) strokePath(pts, (l - 0.5) * LANE_W, 4, THEME.laneDash, [26, 30], anchor);
    ctx.setLineDash([]);

    g.traffic.forEach((c, i) => drawGhost(g.track.pose(c.s, c.lat), c.color, now, (c.s % 97) + i));
    const yaw = Math.max(-0.35, Math.min(0.35, ((g.lane * LANE_W - g.lat) / LANE_W) * 0.35));
    drawCar(me, g.mode === 'playing' || g.mode === 'ready' ? THEME.player : THEME.playerCrashed, yaw, true);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
    drawBats(rdt, now);

    // HUD
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 52);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.floor(g.s / 10)} m`, 18, 38);
    ctx.textAlign = 'center';
    ctx.fillText(`BEST ${Math.max(best, topScore())}`, W / 2, 38);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(g.speed * 0.3)} km/h`, W - 18, 38);

    if (debug && lastWheel) {
      const pad = [...navigator.getGamepads()].find(Boolean);
      const on = Object.keys(lastWheel).filter((k) => lastWheel[k] === true);
      const lines = [
        `pad: ${pad ? `${pad.id.slice(0, 40)} map=${pad.mapping || 'none'} b=${pad.buttons.length} a=${pad.axes.length}` : 'none'}`,
        `raw pressed: ${pad ? pad.buttons.map((x, i) => (x.pressed ? i : null)).filter((x) => x !== null).join(' ') || '-' : '-'}`,
        `wheel: ${on.filter((k) => k !== 'connected').join(' ') || '-'}  L=${lastWheel.leftClutch.toFixed(2)} R=${lastWheel.rightClutch.toFixed(2)}`,
      ];
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, H - 92, W, 92);
      ctx.fillStyle = '#0f0';
      ctx.font = '20px ui-monospace, monospace';
      ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, 10, H - 66 + i * 26));
    }

    if (g.mode !== 'playing') drawMenus();
  }

  function drawButton(b, selected) {
    ctx.fillStyle = selected ? THEME.accent : THEME.panel;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = THEME.accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
    ctx.fillStyle = selected ? '#111' : '#fff';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 11);
  }

  function drawScores(list, x, y, from, count, highlight) {
    ctx.font = 'bold 28px ui-monospace, monospace';
    for (let i = from; i < Math.min(list.length, from + count); i++) {
      const e = list[i];
      ctx.fillStyle = i === highlight ? THEME.accent : '#e8e8e8';
      ctx.textAlign = 'left';
      ctx.fillText(`${String(i + 1).padStart(2)}. ${e.name}`, x, y + (i - from) * 40);
      ctx.textAlign = 'right';
      ctx.fillText(`${e.score}`, x + 320, y + (i - from) * 40);
    }
  }

  function drawMenus() {
    ctx.textAlign = 'center';
    if (g.mode === 'naming') { drawNameEntry(ctx, ui.entry, W, H, performance.now()); return; }
    ctx.fillStyle = 'rgba(12,4,20,0.78)';
    ctx.fillRect(0, 52, W, H - 52);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    if (g.mode === 'ready') {
      ctx.font = 'bold 52px system-ui, sans-serif';
      ctx.fillStyle = THEME.accent;
      ctx.fillText('HAUNTED HIGHWAY', W / 2, 112);
      ctx.fillStyle = '#fff';
      const list = board.load();
      if (list.length) drawScores(list, 230, 160, 0, 5, -1);
      else { ctx.font = '26px system-ui, sans-serif'; ctx.fillText('no scores yet', W / 2, 230); }
      drawButton(BTN.start, true);
    } else if (g.mode === 'over') {
      ctx.font = 'bold 52px system-ui, sans-serif';
      ctx.fillText('BOO! CRASHED', W / 2, 130);
      ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillStyle = THEME.accent;
      ctx.fillText(`${Math.floor(g.s / 10)} m`, W / 2, 190);
      ctx.fillStyle = '#ccc';
      ctx.font = '24px system-ui, sans-serif';
      ctx.fillText(ui.canSave ? 'top 10 run — save it?' : 'not a top 10 run', W / 2, 240);
      if (ui.canSave) { drawButton(BTN.save, ui.choice === 0); drawButton(BTN.again, ui.choice === 1); }
      else drawButton(BTN.againSolo, true);
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('tap a button · or D-pad to choose, pull right clutch to confirm', W / 2, H - 20);
    } else if (g.mode === 'board') {
      ctx.font = 'bold 40px system-ui, sans-serif';
      ctx.fillText('LEADERBOARD', W / 2, 100);
      const { list, index } = ui.board;
      drawScores(list, 40, 150, 0, 5, index);
      drawScores(list, 420, 150, 5, 5, index);
      drawButton(BTN.boardAgain, true);
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

  // step(dt) advances one frame by hand — for scripted tests while the tab is hidden.
  return { state: g, reset, tap: (p) => taps.push(p), step: (dt = 1 / 60) => { update(dt, readInput()); render(); } };
}

// Wheel LED frame for the current game state (layout in wheelleds.js): the top bar
// is the brake meter; the side LEDs blink red when the meter is empty.
export function ledFrame(g, now = performance.now()) {
  const colors = Array.from({ length: 39 }, (_, i) => (i < 21 ? [0, 0, 0] : [40, 12, 0])); // pumpkin-dim buttons
  const e = g.brakeEnergy ?? 0;
  const lit = Math.ceil(e * 15 - 1e-6);
  const base = e > 0.5 ? [255, 80, 0] : e > 0.25 ? [150, 0, 220] : [230, 0, 0]; // orange, purple, red
  const k = g.braking > 0.05 ? 1 : 0.45; // brighter while braking
  for (let i = 0; i < lit; i++) colors[3 + i] = base.map((v) => Math.round(v * k));
  if (g.mode === 'playing' && e <= 0 && Math.floor(now / 200) % 2 === 0) {
    for (const i of [0, 1, 2, 18, 19, 20]) colors[i] = [255, 0, 0];
  }
  return colors;
}
