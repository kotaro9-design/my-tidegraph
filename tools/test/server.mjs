// 手元の確認用：docs/index.html（API を手元に向けたもの）と、組み立てた worker.js を同じ場所で動かす
import http from 'http';
import fs from 'fs';
import { pathToFileURL } from 'url';
const ROOT = process.argv[2], PORT = 8787;
const mod = (await import(pathToFileURL(ROOT + '/cloudflare/api/worker.js').href)).default;
const kv = new Map();
const env = { CACHE: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); } } };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);
  if (req.method === 'POST' && u.pathname === '/api') {
    let body = ''; for await (const c of req) body += c;
    const r = await mod.fetch(new Request('http://localhost:' + PORT + '/api', { method: 'POST', headers: { Origin: 'http://localhost:' + PORT, 'Content-Type': 'text/plain' }, body }), env, { waitUntil: p => p });
    res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(await r.text());
    return;
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try {
    let t = fs.readFileSync(ROOT + '/docs' + f);
    if (f === '/index.html') t = Buffer.from(String(t).replace("'https://tide-api.kotaro9.workers.dev/api'", "'http://localhost:" + PORT + "/api'"));
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' });
    res.end(t);
  } catch (e) { res.writeHead(404); res.end(); }
}).listen(PORT, () => console.log('listening ' + PORT));
