// 管理画面を手元で動かす（D1 は node:sqlite で代用、外部への通信はすべて止める）
import http from 'http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
const ROOT = process.argv[2], PORT = 8788;
globalThis.fetch = async () => new Response('', { status: 404 });   // 外部へは出ない
const mod = (await import(pathToFileURL(ROOT + '/cloudflare/api/worker.js').href)).default;
const db = new DatabaseSync(':memory:');
const stmt = (sql) => {
  const s = { sql, a: [] };
  s.bind = (...a) => { s.a = a; return s; };
  s.first = async () => db.prepare(sql).get(...s.a) || null;
  s.all = async () => ({ results: db.prepare(sql).all(...s.a), meta: {} });
  s.run = async () => { const r = db.prepare(sql).run(...s.a); return { meta: { changes: Number(r.changes) } }; };
  return s;
};
const DB = { prepare: stmt, batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
const kv = new Map();
const env = { DB, ADMIN_KEY: 'testkey', CACHE: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const ctx = { waitUntil: p => p };
// 作り物の記録：3時間前から1分ごと（途中に20分の途切れ）
await mod.fetch(new Request('http://localhost/monitor?key=testkey&format=live'), env, ctx);
const now = Date.now();
for (let m = 180; m >= 1; m--) {
  if (m > 60 && m < 80) continue;
  const t = Math.floor((now - m * 60000) / 60000) * 60000;
  const n = Math.max(0, Math.round(12 + 8 * Math.sin(m / 25) + 3 * Math.sin(m / 4)));
  db.prepare('INSERT INTO live_hist (t, n) VALUES (?, ?)').run(t, n);
}
// 「いま使っている」端末を何台か
for (let i = 0; i < 9; i++) db.prepare('INSERT INTO live (id, t) VALUES (?, ?)').run('dev' + i, now - i * 20000);
// Cron を1回動かす（記録が増えること）
await mod.scheduled({ scheduledTime: now }, env, ctx);
await new Promise(r => setTimeout(r, 100));
console.log('cron 後の最新の記録', JSON.stringify(db.prepare('SELECT t, n FROM live_hist ORDER BY t DESC LIMIT 1').get()), '件数', db.prepare('SELECT count(*) c FROM live_hist').get().c);
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const r = await mod.fetch(new Request('http://localhost:' + PORT + req.url, { method: req.method, headers: { 'Content-Type': 'application/json' }, body: req.method === 'POST' ? body : undefined }), env, ctx);
  res.writeHead(r.status, { 'Content-Type': r.headers.get('Content-Type') || 'text/plain' }); res.end(await r.text());
}).listen(PORT, () => console.log('listening ' + PORT));
