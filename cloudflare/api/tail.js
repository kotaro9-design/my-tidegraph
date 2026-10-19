
/* ==================== ここから Workers の入口 ==================== */

// Workers では外部取得はすべて Workers 自身が行う（ブラウザへの依頼・中継・URL Fetch の上限は不要）
clientUrl_ = function () { return true; };
proxyUrl_ = function () { return false; };
FETCH_LIMIT = { hour: 1e9, day: 1e9, fallbackHour: 1e9, lowShare: 1 };

// 利用状況：1回の呼び出しの記録を D1 に書く（tail の handler で waitUntil）
let __MON_ROWS = [];
monCommit_ = function () {
  const p = MON_PENDING;
  MON_PENDING = null;
  if (!p || monIsEmpty_(p)) return;
  __MON_ROWS.push([monHourKey_(Date.now()), JSON.stringify(p)]);
};

// 呼び出し元（このアプリの画面）
const __ORIGINS = [
  /^https:\/\/kotaro9-design\.github\.io$/,
  /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/,
  /^http:\/\/localhost(:\d+)?$/
];

// 取得先ごとのキャッシュ時間（秒）。kv：全国の拠点で共有する（川の防災情報・海上保安庁は相手の負担を減らすため必ず共有）
function __ttlFor(u) {
  if (/www\.river\.go\.jp\/kawabou\/file\/system\/tmCrntTime/.test(u)) return { ttl: 300, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/tmlist\//.test(u)) return { ttl: 600, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/obslist\//.test(u)) return { ttl: 1800, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/(files\/master|gjson)\//.test(u)) return { ttl: 21600, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/map\//.test(u)) return { ttl: 86400, kv: true };
  if (/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/gauge\.php/.test(u)) return { ttl: 120, kv: true };
  if (/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/index\.php/.test(u)) return { ttl: 86400, kv: true };
  if (/\/const\/|\/suisan\/(txt|station)/.test(u)) return { ttl: 86400, kv: true };
  if (/tidelevel\/data\/tide\/tide_obs_/.test(u)) return { ttl: 60, kv: false };
  if (/amedas\/data\//.test(u)) return { ttl: 60, kv: false };
  if (/forecast\/data\//.test(u)) return { ttl: 600, kv: false };
  if (/msearch\.gsi\.go\.jp|mreversegeocoder/.test(u)) return { ttl: 86400, kv: true };
  return { ttl: 300, kv: false };
}
// 1件取る。KV（共有）→ 相手サイトの順。404 は null、失敗は例外
async function __get(u, env, stat) {
  const c = __ttlFor(u), kvKey = 'u:' + u;
  if (c.kv && env.CACHE) {
    try {
      const hit = await env.CACHE.get(kvKey);
      if (hit != null) { stat.kv++; return hit === '__404__' ? null : hit; }
    } catch (e) { /* KV が使えなくても続ける */ }
  }
  stat.up++;
  const host = (/^https?:\/\/([^/?#]+)/.exec(u) || [])[1] || '';
  monInc_(monPend_().sv, host);
  const res = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; my-tide-graph; +https://kotaro9-design.github.io/my-tidegraph/)' },
    cf: { cacheTtl: c.ttl, cacheEverything: true }
  });
  if (res.status === 404) {
    if (c.kv && env.CACHE) stat.waits.push(env.CACHE.put(kvKey, '__404__', { expirationTtl: Math.max(60, Math.min(c.ttl, 300)) }).catch(() => {}));
    return null;
  }
  if (!res.ok) { monFailHost_(u, res.status); throw new Error('取得失敗 ' + res.status); }
  const t = await res.text();
  if (c.kv && env.CACHE && t.length < 20 * 1024 * 1024) stat.waits.push(env.CACHE.put(kvKey, t, { expirationTtl: Math.max(60, c.ttl) }).catch(() => {}));
  return t;
}

// まとめて呼ぶ（Apps Script の callBatch と同じ形で返す。need は返さず、必要なものは自分で取って最後まで処理する）
async function __runBatch(calls, ev, env, stat) {
  if (ev) monRecord_(ev);
  if (!Array.isArray(calls) || !calls.length || calls.length > 12) throw new Error('不正な呼び出しです');
  const api = api_(), done = {}, pre = {};
  let left = calls.filter(c => Array.isArray(c));
  for (let round = 0; round < 15 && left.length; round++) {
    const need = new Set();
    left = left.filter(c => {
      const id = String(c[0]).slice(0, 20), name = c[1], args = c[2];
      if (!Object.prototype.hasOwnProperty.call(api, name) || (args != null && !Array.isArray(args))) { done[id] = { error: '不正な呼び出しです' }; return false; }
      // ここで取ったデータは信頼できるので共有キャッシュに入れてよい
      PRE = pre; PRE_TRUST = {}; Object.keys(pre).forEach(u => { PRE_TRUST[u] = true; }); FROM_PRE = false; PROXY_ON = false;
      const t0 = Date.now();
      try {
        done[id] = { result: api[name].apply(null, args || []) };
        return false;
      } catch (e) {
        if (e && e.needUrls) { e.needUrls.forEach(u => need.add(u)); return true; }
        done[id] = { error: String((e && e.message) || e) };
        if (!(e && e.paused)) monServer_('err', name);
        return false;
      } finally {
        PRE = null; FROM_PRE = false;
        monServerPerf_(name, Date.now() - t0);
      }
    });
    if (!left.length) break;
    await Promise.all([...need].map(u => __get(u, env, stat).then(t => { pre[u] = t; }, () => { pre[u] = { err: 1 }; })));
  }
  left.forEach(c => { done[String(c[0]).slice(0, 20)] = { error: 'データの取得に失敗しました（' + c[1] + '）' }; });
  return { done: done, need: null };
}

function __json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors || {}) });
}

async function __writeMon(env) {
  const rows = __MON_ROWS; __MON_ROWS = [];
  if (!rows.length || !env.DB) return;
  try {
    await env.DB.batch(rows.map(r => env.DB.prepare('INSERT INTO mon (hour, data) VALUES (?, ?)').bind(r[0], r[1])));
  } catch (e) {
    // 初回はテーブルを作ってから書き直す
    if (/no such table/i.test(String(e && e.message))) {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS mon (id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS mon_hour ON mon(hour);');
      await env.DB.batch(rows.map(r => env.DB.prepare('INSERT INTO mon (hour, data) VALUES (?, ?)').bind(r[0], r[1])));
    } else console.log('mon write failed: ' + e);
  }
}

// 利用状況の要約（D1 の記録を時間帯ごとに足し合わせる）
async function __monSummary(env, days) {
  if (!env.DB) return { error: 'D1 がありません' };
  const since = monHourKey_(Date.now() - days * DAY);
  const r = await env.DB.prepare('SELECT hour, data FROM mon WHERE hour >= ? ORDER BY hour').bind(since).all();
  const hours = {};
  (r.results || []).forEach(row => {
    let h; try { h = monFill_(JSON.parse(row.data)); } catch (e) { return; }
    hours[row.hour] = hours[row.hour] ? monMerge_(hours[row.hour], h) : h;
  });
  const all = monEmptyHour_(), byDay = {};
  Object.keys(hours).sort().forEach(hk => {
    const h = hours[hk], d = hk.slice(0, 10), b = byDay[d] || (byDay[d] = { day: d, pv: 0, users: {}, serr: 0, cerr: 0, upstream: 0 });
    b.pv += h.pv; b.serr += h.serr; b.cerr += h.cerr; Object.keys(h.ids).forEach(a => { b.users[a] = 1; });
    Object.keys(h.sv).forEach(k => { b.upstream += h.sv[k]; });
    monMerge_(all, h);
  });
  const top = (o, n) => Object.keys(o).map(k => ({ key: k, n: o[k] })).sort((a, b) => b.n - a.n).slice(0, n || 15);
  return {
    generatedAt: new Date().toISOString(), source: 'cloudflare', days: days, rows: (r.results || []).length,
    byDay: Object.keys(byDay).sort().map(d => ({ day: d, pv: byDay[d].pv, users: Object.keys(byDay[d].users).length, serverErrors: byDay[d].serr, clientErrors: byDay[d].cerr, upstreamFetches: byDay[d].upstream })),
    hourly: Object.keys(hours).sort().slice(-48).map(hk => ({ hour: hk, pv: hours[hk].pv })),
    totals: { pv: all.pv, users: Object.keys(all.ids).length, serverErrors: all.serr, clientErrors: all.cerr },
    failures: top(Object.assign({}, ...Object.keys(all.svf).map(k => ({ ['server|' + k]: all.svf[k] })), ...Object.keys(all.clf).map(k => ({ ['client|' + k]: all.clf[k] }))), 30),
    errors: top(all.err, 20), dataQuality: top(all.q, 15),
    perf: Object.keys(all.perf).map(k => { const p = all.perf[k]; return { name: k.slice(2), place: k[0] === 's' ? 'server' : 'client', n: p[0], avgSec: p[0] ? Math.round(p[1] / p[0] / 100) / 10 : null, maxSec: Math.round(p[2] / 100) / 10, over3sPct: p[0] ? Math.round((p[5] + p[6]) / p[0] * 100) : null }; }),
    upstream: top(all.sv, 20), browser: top(all.cl, 20), referrers: top(all.ref, 10), geo: all.geo, env: top(all.env, 30),
    stations: top(all.st, 10), features: top(all.f, 25)
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    const okOrigin = origin && __ORIGINS.some(r => r.test(origin));
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : 'null', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type' }, cors) });

    // 利用状況の要約（合言葉が必要）
    if (request.method === 'GET' && url.pathname === '/monitor') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return __json({ error: '合言葉が違います' }, 403);
      const days = Math.min(Math.max(+url.searchParams.get('days') || 2, 1), 90);
      return __json(await __monSummary(env, days));
    }
    if (request.method === 'GET' && url.pathname === '/health') return __json({ ok: true, at: new Date().toISOString() }, 200, cors);
    if (request.method !== 'POST') return __json({ error: 'not found' }, 404, cors);
    if (!okOrigin) return __json({ error: 'forbidden' }, 403, cors);

    const stat = { kv: 0, up: 0, waits: [] };
    let out;
    try {
      const req = await request.json();
      const a = req.args || [];
      if (req.fn === 'callBatch') out = { result: await __runBatch(a[0], a[2], env, stat) };
      else if (req.fn === 'track') { monRecord_(a[0]); out = { result: true }; }
      else throw new Error('不正な呼び出しです');
    } catch (e) {
      out = { error: String((e && e.message) || e) };
    }
    monCommit_();
    ctx.waitUntil(Promise.all(stat.waits).then(() => __writeMon(env)));
    return __json(out, 200, Object.assign({ 'x-upstream': String(stat.up), 'x-kv': String(stat.kv) }, cors));
  }
};
