// 東京湾環境情報センターの水温・塩分：偽の「データ一覧」で、取得 → D1 → 画面向けの読み出しを確かめる（センターへは通信しない）
//   node tools/test/baytest.mjs <worker.js>
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'url';
const W = process.argv[2];
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
const env = { DB, CACHE: { get: async () => null, put: async () => {} } };

const JST = 9 * 3600e3, pad = n => String(n).padStart(2, '0');
const row = c => '<tr>' + c.map(v => '<td class="normalCol">' + v + '</td>').join('') + '</tr>';
// 直近 n 時間分（新しい順）の表。lag：水質計は値が遅れて載る（直近の何時間分が「---」か）
function table(full, hours, lag) {
  const top = Math.floor(Date.now() / 3600e3) * 3600e3, out = [];
  for (let h = 0; h < hours; h++) {
    const d = new Date(top - h * 3600e3 + JST), ds = d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()), ts = pad(d.getUTCHours()) + ':00';
    const v = h < lag ? ['---', '---', '---'] : ['1.1', '21.' + pad(h % 100), '30.5'];
    if (full) { const c = [ds, ts, '17.0', '5', '300', '北', ...v, ...Array(5).fill('---'), ...(h < lag ? ['---','---','---'] : ['5.0', '21.5', '31.0']), ...Array(5).fill('0'), ...(h < lag ? ['---','---','---'] : ['10.0', '22.0', '32.0'])]; while (c.length < 39) c.push('0'); out.push(row(c)); }
    else out.push(row([ds, ts, v[0] === '---' ? '---' : '1', v[1], '10', '21.5', '19', '21.0', ...Array(11).fill('20.0')]));
    // 15分・20分ごとの行（捨てられるはず）
    out.push(row([ds, pad(d.getUTCHours()) + ':20', ...Array(full ? 37 : 17).fill('---')]));
  }
  return '<table id="tblHeaderTable"></table><table id="tblDataTable">' + out.join('') + '</table>';
}
const reqs = [];
globalThis.fetch = async (u, o) => {
  reqs.push({ u: String(u), body: String(o && o.body || '') });
  const m = /buoyId=(\d\d)/.exec(o.body), id = m[1], full = +id <= 4;
  return new Response(table(full, 30, full ? 2 : 0), { status: 200 });
};
const mod = (await import(pathToFileURL(W).href)).default;
const waits = []; const ctx = { waitUntil: p => waits.push(p) };
await mod.scheduled({ scheduledTime: Date.now() - (Date.now() % 3600e3) + 10 * 60e3 }, env, ctx);
await Promise.all(waits);
console.log('取得の回数', reqs.length, '（7地点で7回のはず）', reqs.every(r => /DataList/.test(r.u)));
console.log('保存した行数', db.prepare('SELECT count(*) c FROM bay').get().c, '／ 記録', db.prepare("SELECT v FROM mon_meta WHERE k='bay_last'").get().v);
console.log('値のない時刻は捨てたか（01）', db.prepare("SELECT count(*) c FROM bay WHERE buoy='01'").get().c, '（30時間−遅れ2時間＝28）');
// 分が違うときは取得しない
reqs.length = 0; waits.length = 0;
await mod.scheduled({ scheduledTime: Date.now() - (Date.now() % 3600e3) + 11 * 60e3 }, env, ctx);
await Promise.all(waits);
console.log('10分以外では取得しない', reqs.length === 0);
async function call(lat, lon) {
  const res = await mod.fetch(new Request('https://x/', { method: 'POST', headers: { Origin: 'https://kotaro9-design.github.io' }, body: JSON.stringify({ fn: 'callBatch', args: [[['b', 'getBay', [lat, lon]]], null, null] }) }), env, ctx);
  return (await res.json()).result.done.b;
}
let r = await call(35.62, 139.95);   // 浦安・検見川の近く
console.log('浦安付近', r.error || r.result.name + ' ' + r.result.dist + 'km 水温' + r.result.temp + ' 塩分' + r.result.sal + ' 推移' + r.result.pts.length + '点 塩分あり=' + r.result.salt);
r = await call(35.17, 139.70);       // 金田湾の近く
console.log('金田湾付近', r.error || r.result.name + ' ' + r.result.dist + 'km 水温' + r.result.temp + ' 塩分' + r.result.sal + ' 塩分あり=' + r.result.salt);
r = await call(34.68, 135.19);       // 神戸（遠い）
console.log('神戸（遠い）', r.error || JSON.stringify(r.result));
// 保存期間：31日前の行は次の取得で消える
db.prepare("INSERT INTO bay (buoy, t) VALUES ('01', ?)").run(Date.now() - 31 * 86400e3);
waits.length = 0; await mod.scheduled({ scheduledTime: Date.now() - (Date.now() % 3600e3) + 10 * 60e3 }, env, ctx); await Promise.all(waits);
console.log('31日前の行は消える', db.prepare("SELECT count(*) c FROM bay WHERE t < ?").get(Date.now() - 30 * 86400e3).c === 0);
