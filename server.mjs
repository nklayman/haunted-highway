// Dev bridge: serves ./web and relays JS from a local CLI (POST /eval) to the
// browser page that owns the WebUSB device, returning the result as JSON.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
// HOST=0.0.0.0 serves the page on the LAN (for the phone); /eval, /logs and
// /status stay loopback-only either way.
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

const pages = new Map();   // page id -> { ws, label }
let latestPage = null;     // id of the most recently connected page
let nextPageId = 1;
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
const logs = [];           // ring buffer of page log lines

function pushLog(line) {
  logs.push(line);
  if (logs.length > 500) logs.shift();
  console.log('[page]', line);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2) + '\n');
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const devOnly = ['/eval', '/logs', '/status'].includes(url.pathname);
  if (devOnly && !isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });

  if (req.method === 'POST' && url.pathname === '/eval') {
    // Browsers always send Origin on cross-site POSTs; the CLI (curl) doesn't.
    if (req.headers.origin) return sendJson(res, 403, { error: 'eval not allowed from browsers' });
    const page = pages.get(Number(url.searchParams.get('page') || latestPage))?.ws;
    if (!page) return sendJson(res, 503, { error: 'no page connected' });
    const code = await readBody(req);
    const id = nextId++;
    const timeoutMs = Number(url.searchParams.get('timeout') || 20000);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      page.send(JSON.stringify({ id, code }));
    });
    return sendJson(res, result.error ? 500 : 200, result);
  }

  if (url.pathname === '/logs') {
    const n = Number(url.searchParams.get('n') || 50);
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(logs.slice(-n).join('\n') + '\n');
  }

  if (url.pathname === '/status') {
    const list = [...pages].map(([id, p]) => ({ id, label: p.label, latest: id === latestPage }));
    return sendJson(res, 200, { pages: list, pending: pending.size });
  }

  const file = path.normalize(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(ROOT)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({
  server,
  path: '/bridge',
  // Only our own page (same host:port it was served from) may attach as an eval target.
  verifyClient: ({ origin, req }) => origin === `http://${req.headers.host}`,
});
wss.on('connection', (ws, req) => {
  const id = nextPageId++;
  const ua = req.headers['user-agent'] || '';
  const label = `${/Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : 'other'} ${req.socket.remoteAddress}`;
  pages.set(id, { ws, label });
  latestPage = id;
  pushLog(`page ${id} connected (${label})`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'log') return pushLog(`#${id} ${msg.line}`);
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    p.resolve(msg.error ? { error: msg.error } : { result: msg.result });
  });
  ws.on('close', () => {
    pages.delete(id);
    if (latestPage === id) latestPage = [...pages.keys()].pop() ?? null;
    pushLog(`page ${id} disconnected`);
  });
});

server.listen(PORT, HOST, () => console.log(`bridge on http://${HOST}:${PORT}`));
