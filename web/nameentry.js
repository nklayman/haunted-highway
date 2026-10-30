// On-screen QWERTY name keyboard for the wheel screen. Works with taps (touchscreen),
// D-pad navigation + confirm/back, and a physical keyboard.

export const MAX_NAME = 10;
const UNIT = 72, KEY_H = 56, X0 = 40, Y0 = 132;

// Rows of [label/char, width in key units]; `offset` staggers the row like a real keyboard.
const LAYOUT = [
  { offset: 0, keys: [...'1234567890'] },
  { offset: 0, keys: [...'QWERTYUIOP'] },
  { offset: 0.5, keys: [...'ASDFGHJKL'] },
  { offset: 1.5, keys: [...'ZXCVBNM'] },
  { offset: 0, keys: [{ label: '⌫', act: 'del', w: 2.5 }, { label: 'SPACE', act: 'space', w: 4.5 }, { label: 'DONE', act: 'done', w: 3 }] },
];
const KEYS = LAYOUT.map(({ offset, keys }, row) => {
  let x = offset;
  return keys.map((k) => {
    const key = typeof k === 'string' ? { char: k, label: k, w: 1 } : { ...k };
    Object.assign(key, { row, x: X0 + x * UNIT, y: Y0 + row * KEY_H, w: key.w * UNIT });
    x += key.w / UNIT;
    return key;
  });
});
const ALLOWED = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.!? ']);
const center = (k) => k.x + k.w / 2;

export function createNameEntry(initial = '') {
  return { name: initial.toUpperCase().slice(0, MAX_NAME), row: 1, i: 0 }; // start on Q
}

function append(e, c) {
  if (e.name.length >= MAX_NAME) return;
  if (c === ' ' && (!e.name || e.name.endsWith(' '))) return;
  e.name += c;
}

function activate(e, key) {
  if (key.char) append(e, key.char);
  else if (key.act === 'del') e.name = e.name.slice(0, -1);
  else if (key.act === 'space') append(e, ' ');
  else if (key.act === 'done') return e.name.trim() ? 'done' : null;
  return null;
}

// input: { left, right, up, down, confirmPad, back, taps: [{x,y}], chars: [], enter, backspace }
// Returns 'done' when the name is submitted, else null.
export function handleNameInput(e, input) {
  const row = KEYS[e.row];
  if (input.left) e.i = (e.i + row.length - 1) % row.length;
  if (input.right) e.i = (e.i + 1) % row.length;
  if (input.up || input.down) {
    // Move to the key in the next row whose centre is nearest the current one.
    const x = center(KEYS[e.row][e.i]);
    e.row = (e.row + (input.down ? 1 : KEYS.length - 1)) % KEYS.length;
    const next = KEYS[e.row];
    e.i = next.reduce((best, k, j) => (Math.abs(center(k) - x) < Math.abs(center(next[best]) - x) ? j : best), 0);
  }

  let result = null;
  for (const t of input.taps) {
    for (const r of KEYS) {
      const j = r.findIndex((k) => t.x >= k.x && t.x < k.x + k.w && t.y >= k.y && t.y < k.y + KEY_H);
      if (j >= 0) { e.row = r[0].row; e.i = j; result = activate(e, r[j]) || result; }
    }
  }
  if (input.confirmPad) result = activate(e, KEYS[e.row][e.i]) || result;
  if (input.back || input.backspace) e.name = e.name.slice(0, -1);
  for (const ch of input.chars) { const c = ch.toUpperCase(); if (ALLOWED.has(c)) append(e, c); }
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
  ctx.fillRect(X0, 56, 10 * UNIT, 62);
  ctx.fillStyle = '#ffd54a';
  ctx.font = 'bold 44px ui-monospace, monospace';
  const caret = Math.floor(now / 500) % 2 && e.name.length < MAX_NAME ? '_' : ' ';
  ctx.fillText(e.name + caret, W / 2, 102);

  ctx.font = 'bold 28px system-ui, sans-serif';
  KEYS.forEach((r, row) => r.forEach((k, i) => {
    const sel = row === e.row && i === e.i;
    ctx.fillStyle = sel ? '#ffd54a' : k.act === 'done' ? '#2e7d32' : '#2a3140';
    ctx.fillRect(k.x + 3, k.y + 3, k.w - 6, KEY_H - 6);
    ctx.fillStyle = sel ? '#111' : '#eee';
    ctx.fillText(k.label, k.x + k.w / 2, k.y + KEY_H / 2 + 10);
  }));
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText('tap keys · D-pad + right clutch to type · left clutch deletes', W / 2, H - 14);
}
