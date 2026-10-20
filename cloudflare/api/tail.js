
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
  __MON_ROWS.push([monHourKey_(Date.now()), JSON.stringify(p), Object.keys(p.ids || {})]);
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

/*
 * 利用状況の保存（D1）
 *   mon      … 呼び出しごとの記録（その時間帯が終わったら mon_hourly にまとめて消す）
 *   mon_hourly … 1時間ごとにまとめた記録（同じ時間帯に複数行あってもよい。読むときに足し合わせる）
 *   seen     … 匿名IDが初めて現れた日（新規・再訪の判定）
 *   mon_lock … まとめ処理が同時に2つ動かないようにする
 */
let __schemaOk = false;
async function __schema(env) {
  if (__schemaOk) return;
  await env.DB.batch([
    'CREATE TABLE IF NOT EXISTS mon (id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS mon_hour ON mon(hour)',
    'CREATE TABLE IF NOT EXISTS mon_hourly (id INTEGER PRIMARY KEY AUTOINCREMENT, hour TEXT NOT NULL, data TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS mon_hourly_hour ON mon_hourly(hour)',
    'CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, first TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS seen_first ON seen(first)',
    'CREATE TABLE IF NOT EXISTS mon_lock (name TEXT PRIMARY KEY, until INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS mon_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
  ].map(s => env.DB.prepare(s)));
  __schemaOk = true;
}
function __seenStmt(env, id, day) {
  return env.DB.prepare('INSERT INTO seen (id, first) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET first = min(first, excluded.first)').bind(id, day);
}

async function __writeMon(env) {
  const rows = __MON_ROWS; __MON_ROWS = [];
  if (!rows.length || !env.DB) return;
  try {
    await __schema(env);
    const stmts = [];
    rows.forEach(r => {
      stmts.push(env.DB.prepare('INSERT INTO mon (hour, data) VALUES (?, ?)').bind(r[0], r[1]));
      r[2].forEach(id => stmts.push(__seenStmt(env, id, r[0].slice(0, 10))));
    });
    await env.DB.batch(stmts);
  } catch (e) { console.log('mon write failed: ' + e); return; }
  // ときどき、終わった時間帯をまとめる（Cron が無くても溜まりすぎないように）
  if (Math.random() < 0.02) await __compact(env, 6).catch(e => console.log('compact failed: ' + e));
}

/** 終わった時間帯の記録を1時間1行にまとめる（最大 maxHours 時間分）。まとめた時間帯の数を返す */
async function __compact(env, maxHours) {
  await __schema(env);
  const now = Date.now();
  const lock = await env.DB.prepare('INSERT INTO mon_lock (name, until) VALUES (\'compact\', ?) ON CONFLICT(name) DO UPDATE SET until = excluded.until WHERE mon_lock.until < ?')
    .bind(now + 120000, now).run();
  if (!lock.meta || !lock.meta.changes) return 0;   // ほかで実行中
  let done = 0;
  try {
    const cur = monHourKey_(now);
    const hs = await env.DB.prepare('SELECT DISTINCT hour FROM mon WHERE hour < ? ORDER BY hour LIMIT ?').bind(cur, maxHours).all();
    for (const row of hs.results || []) {
      const r = await env.DB.prepare('SELECT id, data FROM mon WHERE hour = ? ORDER BY id LIMIT 20000').bind(row.hour).all();
      const list = r.results || [];
      if (!list.length) continue;
      const h = monEmptyHour_(), maxId = list[list.length - 1].id, day = row.hour.slice(0, 10);
      list.forEach(x => { try { monMerge_(h, monFill_(JSON.parse(x.data))); } catch (e) { /* 壊れた行は捨てる */ } });
      // まとめの追加・元の行の削除・新規の記録を1つのトランザクションで
      const stmts = [
        env.DB.prepare('INSERT INTO mon_hourly (hour, data) VALUES (?, ?)').bind(row.hour, JSON.stringify(h)),
        env.DB.prepare('DELETE FROM mon WHERE hour = ? AND id <= ?').bind(row.hour, maxId)
      ];
      Object.keys(h.ids).forEach(a => stmts.push(__seenStmt(env, a, day)));
      for (let i = 0; i < stmts.length; i += 500) {
        // 1回の batch は大きすぎないように（最初の塊にまとめと削除が入る）
        await env.DB.batch(stmts.slice(i, i + 500));
      }
      done++;
    }
    // 古い記録（400日より前）は消す
    await env.DB.prepare('DELETE FROM mon_hourly WHERE hour < ?').bind(monHourKey_(now - 400 * DAY)).run();
    await env.DB.prepare('INSERT INTO mon_meta (k, v) VALUES (\'last_compact\', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(String(now)).run();
  } finally {
    await env.DB.prepare('UPDATE mon_lock SET until = 0 WHERE name = \'compact\'').run();
  }
  return done;
}

/** 潮位観測所の名前（共有キャッシュ経由。取れなければ空） */
async function __stationNames(env) {
  const stat = { kv: 0, up: 0, waits: [] }, names = {};
  try {
    const out = await __runBatch([['s', 'getStations', []]], null, env, stat);
    const list = out.done.s && out.done.s.result;
    (list || []).forEach(s => { names[s.c] = s.n; });
  } catch (e) { /* 名前なしで続ける */ }
  MON_PENDING = null;   // 管理画面の読み込みは利用状況に数えない
  await Promise.all(stat.waits);
  return names;
}

/** 管理画面のデータ（Apps Script の getMonitorData と同じ形） */
async function __monData(env, days) {
  await __schema(env);
  days = Math.min(Math.max(+days || 30, 1), 365);
  const now = Date.now(), since = ymd_(now - (days - 1) * DAY), today = ymd_(now), curHour = monHourKey_(now);
  const [a, b, cnt, meta, names] = await Promise.all([
    env.DB.prepare('SELECT hour, data FROM mon_hourly WHERE hour >= ?').bind(since).all(),
    env.DB.prepare('SELECT hour, data FROM mon WHERE hour >= ?').bind(since).all(),
    env.DB.prepare('SELECT count(*) AS n FROM mon').first(),
    env.DB.prepare('SELECT v FROM mon_meta WHERE k = \'last_compact\'').first(),
    __stationNames(env)
  ]);
  const hours = {};
  [a, b].forEach(r => (r.results || []).forEach(row => {
    let h; try { h = monFill_(JSON.parse(row.data)); } catch (e) { return; }
    hours[row.hour] = hours[row.hour] ? monMerge_(hours[row.hour], h) : h;
  }));
  const all = monEmptyHour_(), users = {}, hourly = [];
  Object.keys(hours).sort().forEach(hk => {
    const h = hours[hk], up = Object.keys(h.sv).reduce((s, k) => s + h.sv[k], 0), d = hk.slice(0, 10);
    hourly.push([hk, h.pv, Object.keys(h.ids).length, up, h.lim, h.serr, h.cerr, h.alive]);
    Object.keys(h.ids).forEach(id => { users[d + '|' + id] = 1; });
    monMerge_(all, h);
  });
  // 初めて現れた日（期間内に初めて現れた人だけ記録にある。ほかは期間より前からの利用者）
  const firstSeen = {};
  Object.keys(all.ids).forEach(id => { firstSeen[id] = '0000-00-00'; });
  const fs = await env.DB.prepare('SELECT id, first FROM seen WHERE first >= ?').bind(since).all();
  (fs.results || []).forEach(r => { if (firstSeen[r.id]) firstSeen[r.id] = r.first; });
  const pre = (o, p) => { const x = {}; Object.keys(o).forEach(k => { x[p + k] = o[k]; }); return x; };
  const sites = {};
  Object.keys(all.sv).forEach(k => { (sites[k] = sites[k] || { sv: 0, cl: 0 }).sv += all.sv[k]; });
  Object.keys(all.cl).forEach(k => { (sites[k] = sites[k] || { sv: 0, cl: 0 }).cl += all.cl[k]; });
  const th = hours[curHour], ufHour = th ? Object.keys(th.sv).reduce((s, k) => s + th.sv[k], 0) : 0;
  const ufToday = hourly.filter(r => r[0].slice(0, 10) === today).reduce((s, r) => s + r[3], 0);
  const lc = meta ? +meta.v : null;
  return {
    source: 'cloudflare', days: days, since: since, now: now,
    hourly: hourly,
    users: Object.keys(users).map(k => k.split('|')),
    firstSeen: firstSeen,
    stations: all.st, stationNames: names,
    areas: all.area, features: all.f, errors: all.err, sites: sites, referrers: all.ref,
    failures: Object.assign(pre(all.svf, 'server|'), pre(all.clf, 'client|')),
    quality: all.q, perf: all.perf, env: all.env, geo: all.geo,
    alerts: [], limits: null,
    version: MONITOR_VERSION, versionDate: MONITOR_DATE,
    sheetUrl: null, pending: [], ufHour: ufHour, ufToday: ufToday,
    health: { lastFlush: lc ? { t: lc } : null, rawRows: cnt ? cnt.n : 0, dbBytes: a.meta && a.meta.size_after || null, trigger: null, dropToday: 0, cells: 0, alerts: false, daily: false, alertTo: '' }
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    const okOrigin = origin && __ORIGINS.some(r => r.test(origin));
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : 'null', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type' }, cors) });

    // 利用状況（合言葉が必要）
    const keyOk = k => !!env.ADMIN_KEY && typeof k === 'string' && k === env.ADMIN_KEY;
    // 要約：JSON（format=text で文章）
    if (request.method === 'GET' && url.pathname === '/monitor') {
      if (!keyOk(url.searchParams.get('key'))) return __json({ error: '合言葉が違います' }, 403);
      if (!env.DB) return __json({ error: 'D1 がありません' }, 500);
      const days = Math.min(Math.max(+url.searchParams.get('days') || 2, 1), 365);
      await __compact(env, 24).catch(e => console.log('compact failed: ' + e));
      const s = monSummaryFrom_(await __monData(env, days));
      if (url.searchParams.get('format') === 'text') return new Response(monSummaryText_(s), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      return __json(s);
    }
    // 管理画面
    if (request.method === 'GET' && url.pathname === '/admin') {
      const k = url.searchParams.get('key');
      if (!keyOk(k)) return new Response('合言葉が違います', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const html = __ADMIN_HTML.replace('<?= adminKey ?>', k.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
    }
    // 管理画面からの呼び出し（同じ場所から。合言葉を本文で受け取る）
    if (request.method === 'POST' && url.pathname === '/admin/api') {
      if (origin && origin !== url.origin) return __json({ error: 'forbidden' }, 403);
      let req; try { req = await request.json(); } catch (e) { return __json({ error: '不正な呼び出しです' }, 400); }
      const a = Array.isArray(req.args) ? req.args : [];
      if (!keyOk(a[0])) return __json({ error: '合言葉が違います' }, 403);
      if (!env.DB) return __json({ error: 'D1 がありません' }, 500);
      try {
        if (req.fn === 'getMonitorData') { await __compact(env, 24).catch(e => console.log('compact failed: ' + e)); return __json({ result: await __monData(env, a[1]) }); }
        if (req.fn === 'getMonitorSummaryText') return __json({ result: monSummaryText_(monSummaryFrom_(await __monData(env, a[1]))) });
        if (req.fn === 'adminFlush') return __json({ result: await __compact(env, 48) });
        return __json({ error: '不正な呼び出しです' }, 400);
      } catch (e) { return __json({ error: String((e && e.message) || e) }, 500); }
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
  },
  // Cron トリガー（任意。設定すれば終わった時間帯を定期的にまとめる）
  async scheduled(event, env, ctx) {
    if (env.DB) ctx.waitUntil(__compact(env, 48).catch(e => console.log('compact failed: ' + e)));
  }
};
