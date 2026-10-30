// Dev bridge client: connects to server.mjs and runs JS sent from the terminal
// (POST /eval). Only used when served over plain http; deployed https builds skip it.

let ws = null;

export function bridgeLog(line) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', line }));
}

// getScope() returns an object whose keys become variables in the evaluated code.
export function startBridge(getScope, onState = () => {}) {
  if (location.protocol !== 'http:') return onState('off (deployed)');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const connect = () => {
    onState('connecting…');
    ws = new WebSocket(`ws://${location.host}/bridge`);
    ws.onopen = () => onState('connected');
    ws.onclose = () => { onState('disconnected (retrying)'); setTimeout(connect, 1000); };
    ws.onmessage = async (ev) => {
      const { id, code } = JSON.parse(ev.data);
      try {
        const scope = getScope();
        const result = await new AsyncFunction(...Object.keys(scope), code)(...Object.values(scope));
        ws.send(JSON.stringify({ id, result: plain(result) }));
      } catch (e) {
        ws.send(JSON.stringify({ id, error: `${e.name}: ${e.message}` }));
      }
    };
  };
  connect();
}

// Make WebUSB result objects (getters on prototypes, DataViews) JSON-friendly.
function plain(v, depth = 0) {
  if (v == null || typeof v !== 'object') return v;
  if (depth > 6) return '[depth]';
  if (v instanceof DataView) v = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (ArrayBuffer.isView(v)) {
    const bytes = Array.from(v.slice(0, 256), (b) => b.toString(16).padStart(2, '0')).join(' ');
    return { bytes: v.length > 256 ? bytes + ` … (${v.length} total)` : bytes };
  }
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  const out = {};
  for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || k in out) continue;
      try { const x = v[k]; if (typeof x !== 'function') out[k] = plain(x, depth + 1); } catch {}
    }
  }
  return out;
}
