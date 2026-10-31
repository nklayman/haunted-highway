// Local top-10 leaderboard in localStorage (per device/browser). Storage can be
// unavailable (private mode, blocked site data), so every access is guarded.

const KEY = 'racewheel.leaderboard.v1';
// Older builds remembered the last name entered; drop it so it isn't prefilled anywhere.
try { localStorage.removeItem('racewheel.lastName'); } catch {}
export const SIZE = 10;

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function load() {
  const list = read(KEY, []);
  return Array.isArray(list) ? list.filter((e) => e && typeof e.score === 'number') : [];
}

export function qualifies(score) {
  const list = load();
  return score > 0 && (list.length < SIZE || score > list[list.length - 1].score);
}

// Insert and return { list, index } where index is the new entry's position.
export function add(name, score) {
  const entry = { name: name.trim().slice(0, 10), score, at: Date.now() };
  const list = [...load(), entry].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, SIZE);
  write(KEY, list);
  return { list, index: list.indexOf(entry) };
}

