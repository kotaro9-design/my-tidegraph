// 川の防災情報にはアクセスせず、作り物のデータで worker.js の河川・水質の一覧を確かめる
import { pathToFileURL } from 'url';
const W = process.argv[2];
const RV = 'https://www.river.go.jp/kawabou/file/';
// 東京付近に 0.04° 間隔で市区町村（重心）を並べる
const towns = [];
for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) towns.push({ twnCd: 13000 + i * 12 + j, lat: 35.45 + i * 0.04, lon: 139.55 + j * 0.04, stgExistFlg: 1, qwtrExistFlg: (i + j) % 5 === 0 ? 1 : 0 });
const T = c => towns.find(t => t.twnCd === c);
let log = [];
globalThis.fetch = async (u) => {
  log.push(u);
  const ok = b => new Response(JSON.stringify(b), { status: 200 });
  if (!u.startsWith(RV)) return new Response('', { status: 404 });
  const p = u.slice(RV.length);
  if (p === 'files/map/twn/twnarea.json') return ok({ towns });
  if (p === 'system/tmCrntTime.json') return ok({ crntObsTime: '2026/10/20 22:30' });
  let m;
  if ((m = /^gjson\/obs\/\d{8}\/\d{4}\/stg\/(\d+)\.json$/.exec(p))) {
    const t = T(+m[1]);
    return ok({ features: [0, 1].map(k => ({ properties: { obs_fcd: String(1000000000000 + t.twnCd * 10 + k), obs_nm: '観測所' + t.twnCd + '-' + k, ofc_cd: 1, obs_cd: k, lat: t.lat + k * 0.01, lon: t.lon + k * 0.01 } })) });
  }
  if ((m = /^files\/obslist\/obs\/twnlist\/(\d+)\.json$/.exec(p))) {
    const t = T(+m[1]);
    return ok({ obsList: { obsQwtr: t.qwtrExistFlg ? ['上層', '下層'].map((l, k) => ({ obsFcd: String(2000000000000 + t.twnCd * 10 + k), obsNm: '水質' + t.twnCd + l, ofcCd: 1, obsCd: k })) : [] } });
  }
  if ((m = /^files\/master\/obs\/qwtr\/(\d+)\.json$/.exec(p))) {
    const c = Math.floor((+m[1] - 2000000000000) / 10), t = T(c);
    return ok({ obsInfo: { lat: t.lat + 0.005, lon: t.lon + 0.005, rvrNm: '川' + c, obsSadr: '' } });
  }
  if (/^files\/tmlist\/qwtr\//.test(p)) return ok({ hrValues: [{ obsTime: '2026/10/20 22:00', wtrtmp: 19.5, wtrtmpCcd: 0, slt: 1000, sltCcd: 0 }] });
  if (/^files\/tmlist\/stg\//.test(p)) return ok({ min10Values: [{ obsTime: '2026/10/20 22:30', stg: 1, stgHght: 1.2, stgCcd: 0 }] });
  if (/^files\/master\/obs\/stg\//.test(p)) return ok({ obsInfo: { rvrNm: '隅田川', obsNm: 'x', lat: 35.6, lon: 139.8 } });
  if (/^files\/obslist\/top\//.test(p)) return ok({ obsValue: { stgHght: 1.2 } });
  return new Response('', { status: 404 });
};
const kv = new Map();
const env = { CACHE: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); } } };
let ver = 0;
async function call(calls) {
  // 毎回別の実行環境（メモリのキャッシュなし、KV は共有）として読み込む
  const mod = (await import(pathToFileURL(W).href + '?v=' + (++ver))).default;
  log = [];
  const res = await mod.fetch(new Request('https://x/', { method: 'POST', headers: { Origin: 'https://kotaro9-design.github.io' }, body: JSON.stringify({ fn: 'callBatch', args: [calls, null, null] }) }), env, { waitUntil: p => p });
  await new Promise(r => setTimeout(r, 20));
  const kinds = {};
  log.forEach(u => { const k = u.slice(RV.length).split('/').slice(0, 2).join('/'); kinds[k] = (kinds[k] || 0) + 1; });
  return { done: (await res.json()).result.done, kinds };
}
let r = await call([['r', 'getRiverStations', [35.68, 139.77]]]);
console.log('河川一覧（初回）', r.done.r.error || r.done.r.result.length + '件 先頭 ' + r.done.r.result[0].name + ' ' + r.done.r.result[0].dist + 'km', '取得', JSON.stringify(r.kinds));
r = await call([['r', 'getRiverStations', [35.70, 139.79]]]);
console.log('河川一覧（2km 隣・別の実行環境）', r.done.r.error || r.done.r.result.length + '件', '取得', JSON.stringify(r.kinds));
r = await call([['r', 'getRiver', [35.68, 139.77, null]]]);
console.log('河川水位（自動）', r.done.r.error || r.done.r.result && r.done.r.result.name, '取得', JSON.stringify(r.kinds));
r = await call([['w', 'getWQStations', [35.68, 139.77]]]);
const wl = r.done.w.result || [];
console.log('水質一覧', r.done.w.error || wl.length + '件 ' + wl.slice(0, 3).map(x => x.name + ' ' + x.dist + 'km').join(' / '), '取得', JSON.stringify(r.kinds));
r = await call([['w', 'getWQStations', [35.66, 139.81]]]);
console.log('水質一覧（隣・別の実行環境）', (r.done.w.result || []).length + '件', '取得', JSON.stringify(r.kinds));
const far = wl[wl.length - 1];
r = await call([['q', 'getWaterQuality', [35.66, 139.81, far.fcd]]]);
console.log('水質（一覧の最後を選択、少し動いた位置から）', r.done.q.error || JSON.stringify(r.done.q.result && { name: r.done.q.result.name, dist: r.done.q.result.dist, layers: r.done.q.result.layers.map(l => l.layer) }), '取得', JSON.stringify(r.kinds));
