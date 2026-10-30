// On-screen name keyboard for the wheel screen. Works with taps (touchscreen),
// D-pad navigation + confirm/back, and a physical keyboard.

export const MAX_NAME = 10;
const ROWS = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '456789-.!?'];
const SPECIAL = [
  { label: '⌫', act: 'del', cols: [0, 1, 2] },
  { label: 'SPACE', act: 'space', cols: [3, 4, 5, 6] },
  { label: 'DONE', act: 'done', cols: [7, 8, 9] },
];
const KEY_W = 72, KEY_H = 56, X0 = 40, Y0 = 132;
const ALLOWED = new Set([...ROWS.join(''), ' ']);

export function createNameEntry(initial = '') {
  return { name: initial.toUpperCase().slice(0, MAX_NAME), row: 0, col: 0 };
}

function keyAt(row, col) {
  if (row < ROWS.length) return { char: ROWS[row][col], x: X0 + col * KEY_W, y: Y0 + row * KEY_H, w: KEY_W };
  const s = SPECIAL.find((k) => k.cols.includes(col));
  return { act: s.act, label: s.label, x: X0 + s.cols[0] * KEY_W, y: Y0 + row * KEY_H, w: s.cols.length * KEY_W };
}

function allKeys() {
  const keys = [];
  ROWS.forEach((r, row) => [...r].forEach((_, col) => keys.push({ ...keyAt(row, col), row, col })));
  SPECIAL.forEach((s) => keys.push({ ...keyAt(ROWS.length, s.cols[0]), row: ROWS.length, col: s.cols[0] }));
  return keys;
}

function activate(e, key) {
  if (key.char) { if (e.name.length < MAX_NAME) e.name += key.char; return null; }
  if (key.act === 'del') { e.name = e.name.slice(0, -1); return null; }
  if (key.act === 'space') { if (e.name.length < MAX_NAME && e.name && !e.name.endsWith(' ')) e.name += ' '; return null; }
  if (key.act === 'done') return e.name.trim() ? 'done' : null;
  return null;
}

// input: { left, right, up, down, confirmPad, back, taps: [{x,y}], chars: [], enter, backspace }
// Returns 'done' when the name is submitted, else null.
export function handleNameInput(e, input) {
  const lastRow = ROWS.length;
  const step = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (step && e.row === lastRow) {
    // The bottom row has three wide keys: left/right step between them.
    const i = SPECIAL.findIndex((s) => s.cols.includes(e.col));
    e.col = SPECIAL[(i + step + 3) % 3].cols[0];
  } else if (step) {
    e.col = (e.col + step + 10) % 10;
  }
  if (input.up) e.row = (e.row + lastRow) % (lastRow + 1);
  if (input.down) e.row = (e.row + 1) % (lastRow + 1);

  let result = null;
  for (const t of input.taps) {
    const key = allKeys().find((k) => t.x >= k.x && t.x < k.x + k.w && t.y >= k.y && t.y < k.y + KEY_H);
    if (key) { e.row = key.row; e.col = key.col; result = activate(e, key) || result; }
  }
  if (input.confirmPad) result = activate(e, keyAt(e.row, e.col)) || result;
  if (input.back || input.backspace) e.name = e.name.slice(0, -1);
  for (const ch of input.chars) {
    const c = ch.toUpperCase();
    if (ALLOWED.has(c) && e.name.length < MAX_NAME && !(c === ' ' && (!e.name || e.name.endsWith(' ')))) e.name += c;
  }
  if (input.enter && e.name.trim()) result = 'done';
  return result;
}

export function drawNameEntry(ctx, e, W, H, now) {
  ctx.fillStyle = 'rgba(10,12,18,0.94)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.fillText('ENTER YOUR NAME', W / 2, 40);

  ctx.fillStyle = '#1e2430';
  ctx.fillRect(X0, 56, 10 * KEY_W, 62);
  ctx.fillStyle = '#ffd54a';
  ctx.font = 'bold 44px ui-monospace, monospace';
  const caret = Math.floor(now / 500) % 2 && e.name.length < MAX_NAME ? '_' : ' ';
  ctx.fillText(e.name + caret, W / 2, 102);

  ctx.font = 'bold 28px system-ui, sans-serif';
  for (const k of allKeys()) {
    const sel = k.row === e.row && (k.char ? k.col === e.col : SPECIAL.find((s) => s.act === k.act).cols.includes(e.col));
    ctx.fillStyle = sel ? '#ffd54a' : k.act === 'done' ? '#2e7d32' : '#2a3140';
    ctx.fillRect(k.x + 3, k.y + 3, k.w - 6, KEY_H - 6);
    ctx.fillStyle = sel ? '#111' : '#eee';
    ctx.fillText(k.char || k.label, k.x + k.w / 2, k.y + KEY_H / 2 + 10);
  }
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText('tap keys · D-pad + right clutch to type · left clutch deletes', W / 2, H - 14);
}
