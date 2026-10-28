
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
// key：共有キャッシュの見出し（省略時は URL）。川の防災情報の URL には最新の観測時刻（10分ごと）が入るので、
// 中身が変わらない・毎時の値のものは時刻を外して共有する（Apps Script では名前で6時間・1時間持っていたのと同じ）
const __RV = /^https:\/\/www\.river\.go\.jp\/kawabou\/file\//, __RV_TIME = /\/\d{8}\/\d{4}\//;
// ほとんど変わらないもの（観測所の位置・情報、年ごとの潮位表、地域の一覧など）は長く共有する
const DAY_S = 86400, WEEK_S = 7 * DAY_S, MONTH_S = 30 * DAY_S;
function __ttlFor(u) {
  if (/www\.river\.go\.jp\/kawabou\/file\/system\/tmCrntTime/.test(u)) return { ttl: 300, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/tmlist\/qwtr\//.test(u)) return { ttl: 3600, kv: true, key: u.replace(__RV_TIME, '/') };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/tmlist\//.test(u)) return { ttl: 600, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/obslist\/top\//.test(u)) return { ttl: 21600, kv: true };
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/obslist\//.test(u)) return { ttl: WEEK_S, kv: true };     // 町ごとの水質観測所の一覧
  if (/www\.river\.go\.jp\/kawabou\/file\/gjson\//.test(u)) return { ttl: WEEK_S, kv: true, key: u.replace(__RV_TIME, '/') };   // 町ごとの水位観測所（位置・名前）
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/master\//.test(u)) return { ttl: MONTH_S, kv: true };     // 観測所の情報
  if (/www\.river\.go\.jp\/kawabou\/file\/files\/map\//.test(u)) return { ttl: WEEK_S, kv: true };         // 市区町村の一覧
  if (/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/gauge\.php/.test(u)) return { ttl: 120, kv: true };
  if (/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/index\.php/.test(u)) return { ttl: WEEK_S, kv: true };      // 海保の観測所の一覧
  if (/\/const\/tide_astro\/|\/suisan\/txt\//.test(u)) return { ttl: MONTH_S, kv: true };                   // 年ごとの推算・潮位表
  if (/\/const\/tide_area\.json/.test(u)) return { ttl: DAY_S, kv: true };                                 // 潮位観測所（欠測の情報を含む）
  if (/\/const\/|\/suisan\/station/.test(u)) return { ttl: WEEK_S, kv: true };                             // アメダス・予報区・潮位表の地点の一覧
  if (/tidelevel\/data\/tide\/tide_obs_/.test(u)) return { ttl: 60, kv: false };
  // アメダスの3時間ごとのファイル：終わってから1時間以上たった分は変わらないので全国で共有して長く持つ
  const am = /amedas\/data\/point\/\d+\/(\d{4})(\d{2})(\d{2})_(\d{2})\.json/.exec(u);
  if (am && Date.UTC(+am[1], +am[2] - 1, +am[3], +am[4]) - JST + 4 * HOUR < Date.now()) return { ttl: 86400, kv: true };
  if (/amedas\/data\//.test(u)) return { ttl: 60, kv: false };
  if (/forecast\/data\//.test(u)) return { ttl: 600, kv: false };
  if (/msearch\.gsi\.go\.jp|mreversegeocoder/.test(u)) return { ttl: MONTH_S, kv: true };                 // 住所 ⇔ 位置
  return { ttl: 300, kv: false };
}
// 利用状況での外部サイトの名前。川の防災情報は種類ごとに分けて数える（どれが多いかを見るため）
function __siteOf(u) {
  const host = (/^https?:\/\/([^/?#]+)/.exec(u) || [])[1] || '';
  if (!__RV.test(u)) return host;
  const kind = /system\/tmCrntTime/.test(u) ? 'time' : /tmlist\/qwtr\//.test(u) ? 'qwtr' : /tmlist\//.test(u) ? 'stg'
    : /obslist\/top\//.test(u) ? 'top' : /obslist\//.test(u) ? 'twnlist' : /gjson\//.test(u) ? 'gjson'
    : /files\/master\//.test(u) ? 'master' : /files\/map\//.test(u) ? 'map' : 'other';
  return host + '/' + kind;
}
// 同じ拠点（実行環境）で同時に同じものを取りに行くときは、1回の取得を分け合う
const __INFLIGHT = new Map();
// 1件取る。KV（共有）→ 相手サイトの順。404 は null、失敗は例外
function __get(u, env, stat) {
  const k = (__ttlFor(u).key || u);
  const p = __INFLIGHT.get(k);
  if (p) { stat.kv++; return p; }
  const q = __get1(u, env, stat);
  __INFLIGHT.set(k, q);
  q.then(() => __INFLIGHT.delete(k), () => __INFLIGHT.delete(k));
  return q;
}
// 待つ時間の上限。相手が応答しないと取得が終わらず、画面の読み込みが止まり、同じデータを待つ後の呼び出しも止まるため
const FETCH_TIMEOUT_MS = 10000, KV_TIMEOUT_MS = 3000, BATCH_DEADLINE_MS = 20000;
function __within(p, ms) {
  let tm;
  return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(tm));
}
async function __get1(u, env, stat) {
  const c = __ttlFor(u), kvKey = 'u:' + (c.key || u);
  if (c.kv && env.CACHE) {
    try {
      const hit = await __within(env.CACHE.get(kvKey), KV_TIMEOUT_MS);
      if (hit != null) { stat.kv++; return hit === '__404__' ? null : hit; }
    } catch (e) { /* KV が使えない・遅いときも続ける */ }
  }
  const host = __siteOf(u);
  // 時間切れは本文の読み込みも含めて打ち切る（signal は本文にも効く）
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; my-tide-graph; +https://kotaro9-design.github.io/my-tidegraph/)' },
      cf: { cacheTtl: c.ttl, cacheEverything: true }, signal
    });
  } catch (e) {
    monFailHost_(u, e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'net');
    throw e;
  }
  // Cloudflare の配信網に一時保存されていた分（HIT など）は相手サイトに届いていないので数えない
  const cs = String(res.headers.get('cf-cache-status') || '').toUpperCase();
  if (cs === 'HIT' || cs === 'STALE' || cs === 'UPDATING' || cs === 'REVALIDATED') stat.edge++;
  else { stat.up++; monInc_(monPend_().sv, host); }
  if (res.status === 404) {
    if (c.kv && env.CACHE) stat.waits.push(env.CACHE.put(kvKey, '__404__', { expirationTtl: Math.max(60, Math.min(c.ttl, 300)) }).catch(() => {}));
    return null;
  }
  if (!res.ok) { monFailHost_(u, res.status); throw new Error('取得失敗 ' + res.status); }
  let t;
  try { t = await res.text(); } catch (e) { monFailHost_(u, 'timeout'); throw e; }
  if (c.kv && env.CACHE && t.length < 20 * 1024 * 1024) stat.waits.push(env.CACHE.put(kvKey, t, { expirationTtl: Math.max(60, c.ttl) }).catch(() => {}));
  return t;
}

// まとめて呼ぶ（Apps Script の callBatch と同じ形で返す。need は返さず、必要なものは自分で取って最後まで処理する）
async function __runBatch(calls, ev, env, stat) {
  if (ev) monRecord_(ev);
  if (!Array.isArray(calls) || !calls.length || calls.length > 12) throw new Error('不正な呼び出しです');
  const api = api_(), done = {}, pre = {}, t0 = Date.now();
  let left = calls.filter(c => Array.isArray(c));
  // 東京湾の水温・塩分は D1 に貯めた値を使う（非同期なので、処理の前に読んでおく）
  if (left.some(c => c[1] === 'getBay') && env.DB) {
    try { BAY_DATA = await __within(__bayLoad(env), KV_TIMEOUT_MS * 2); } catch (e) { BAY_DATA = null; }
  }
  // 全体でも時間を区切る（間に合わなかった処理はエラーで返し、画面はほかの結果を表示できる）
  for (let round = 0; round < 15 && left.length && Date.now() - t0 < BATCH_DEADLINE_MS; round++) {
    const need = new Set();
    left = left.filter(c => {
      const id = String(c[0]).slice(0, 20), name = c[1], args = c[2];
      if (!Object.prototype.hasOwnProperty.call(api, name) || (args != null && !Array.isArray(args))) { done[id] = { error: '不正な呼び出しです' }; return false; }
      // ここで取ったデータは信頼できるので共有キャッシュに入れてよい
      PRE = pre; PRE_TRUST = {}; Object.keys(pre).forEach(u => { PRE_TRUST[u] = true; }); FROM_PRE = false; PROXY_ON = false;
      // 処理時間は、まとめた呼び出しの開始からこの処理が終わるまで（外部サイトの取得を待った時間を含む）。
      // Workers では取得などを待っていない間は時計が進まないので、1回分の計算だけを測ると 0 になる
      try {
        done[id] = { result: api[name].apply(null, args || []) };
        monServerPerf_(name, Date.now() - t0);
        return false;
      } catch (e) {
        if (e && e.needUrls) { e.needUrls.forEach(u => need.add(u)); return true; }
        done[id] = { error: String((e && e.message) || e) };
        if (!(e && e.paused)) monServer_('err', name);
        monServerPerf_(name, Date.now() - t0);
        return false;
      } finally {
        PRE = null; FROM_PRE = false;
      }
    });
    if (!left.length) break;
    // 締め切りの残りだけ待つ（取得の時間切れ 10 秒まで待つと全体で 30 秒近くになり、画面が 30 秒で Apps Script に切り替えてしまう）。
    // 待ちきれなかった取得は裏で続き、KV に入るので次の呼び出しで使える
    const rest = BATCH_DEADLINE_MS - (Date.now() - t0);
    await __within(Promise.all([...need].map(u => __get(u, env, stat).then(t => { pre[u] = t; }, () => { pre[u] = { err: 1 }; }))), Math.max(rest, 0)).catch(() => {});
  }
  left.forEach(c => { done[String(c[0]).slice(0, 20)] = { error: 'データの取得に失敗しました（' + c[1] + '）' }; monServerPerf_(c[1], Date.now() - t0); });
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
 *   live     … 匿名IDごとの最後の通信時刻（いま使っている人の数）
 *   live_hist … いま使っている人の数の1分ごとの記録（Cron で記録、2日分。管理画面の折れ線グラフ）
 *   bay      … 東京湾環境情報センターの毎時の水温・塩分（Cron で毎時1回取得、最長30日で自動削除）
 */
// 画面を表示している間は5分ごとに自動更新の通信がある。それより少し長い時間で数える
const LIVE_MS = 7 * 60000;
let __LIVE_BYE = [];   // 閉じた画面の匿名ID（いま使っている人から外す）
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
    'CREATE TABLE IF NOT EXISTS mon_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS live (id TEXT PRIMARY KEY, t INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS live_t ON live(t)',
    'CREATE TABLE IF NOT EXISTS live_hist (t INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS bay (buoy TEXT NOT NULL, t INTEGER NOT NULL, d1 REAL, d2 REAL, d3 REAL, w1 REAL, w2 REAL, w3 REAL, s1 REAL, s2 REAL, s3 REAL, PRIMARY KEY (buoy, t))'
  ].map(s => env.DB.prepare(s)));
  __schemaOk = true;
}
function __seenStmt(env, id, day) {
  return env.DB.prepare('INSERT INTO seen (id, first) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET first = min(first, excluded.first)').bind(id, day);
}

async function __writeMon(env) {
  const rows = __MON_ROWS, bye = __LIVE_BYE; __MON_ROWS = []; __LIVE_BYE = [];
  if ((!rows.length && !bye.length) || !env.DB) return;
  try {
    await __schema(env);
    const stmts = [], now = Date.now();
    rows.forEach(r => {
      stmts.push(env.DB.prepare('INSERT INTO mon (hour, data) VALUES (?, ?)').bind(r[0], r[1]));
      r[2].forEach(id => {
        stmts.push(__seenStmt(env, id, r[0].slice(0, 10)));
        if (bye.indexOf(id) < 0) stmts.push(env.DB.prepare('INSERT INTO live (id, t) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET t = excluded.t').bind(id, now));
      });
    });
    bye.forEach(id => stmts.push(env.DB.prepare('DELETE FROM live WHERE id = ?').bind(id)));
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
    await env.DB.prepare('DELETE FROM live WHERE t < ?').bind(now - DAY).run();
    await env.DB.prepare('INSERT INTO mon_meta (k, v) VALUES (\'last_compact\', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(String(now)).run();
  } finally {
    await env.DB.prepare('UPDATE mon_lock SET until = 0 WHERE name = \'compact\'').run();
  }
  return done;
}

/*
 * 東京湾環境情報センター「東京湾水質連続観測」（利用の了承：2026-10-27、条件：出典の明示・規約の遵守）
 * 取得は Cron から毎時1回、各観測地点につき1回（7地点×24回＝1日最大168回）。保存は毎時の水温・塩分だけで、最長30日で自動削除。
 * 画面には直近3日分の推移と最新値だけを出し、ダウンロードや第三者への提供はしない
 */
const BAY_KEEP_DAYS = 30, BAY_SHOW_DAYS = 3, BAY_MIN = 10;   // BAY_MIN：毎時の取得を始める分（値が載るまでの時間をみて10分過ぎ）
const jstStamp = ms => { const p = jstParts_(ms); return '' + p.y + pad2_(p.m) + pad2_(p.d) + pad2_(p.h) + pad2_(new Date(ms + JST).getUTCMinutes()); };
async function __bayFetch(env, at) {
  await __schema(env);
  const now = at || Date.now(), res = { at: now, ok: 0, fail: 0, rows: 0 };
  for (const b of BAY_BUOYS) {
    try {
      const last = await env.DB.prepare('SELECT max(t) AS t FROM bay WHERE buoy = ?').bind(b.id).first();
      // 通常は直近12時間（値が遅れて載る分を拾う）。最初や止まっていたあとは、最大3日ぶんをさかのぼる
      const back = Math.min(Math.max(12 * HOUR, last && last.t ? now - last.t + 2 * HOUR : BAY_SHOW_DAYS * DAY), BAY_SHOW_DAYS * DAY);
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS * 2);
      const r = await fetch(BAY_LIST, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (compatible; my-tide-graph; +https://kotaro9-design.github.io/my-tidegraph/)' },
        body: 'buoyId=' + b.id + '&sDateTimeId=' + jstStamp(now - back) + '&eDateTimeId=' + jstStamp(now)
      });
      if (!r.ok) throw new Error('status ' + r.status);
      const rows = bayParse_(await r.text());
      if (rows.length) {
        await env.DB.batch(rows.map(x => env.DB.prepare('INSERT INTO bay (buoy, t, d1, d2, d3, w1, w2, w3, s1, s2, s3) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(buoy, t) DO UPDATE SET d1=excluded.d1, d2=excluded.d2, d3=excluded.d3, w1=excluded.w1, w2=excluded.w2, w3=excluded.w3, s1=excluded.s1, s2=excluded.s2, s3=excluded.s3')
          .bind(b.id, x.t, x.d[0], x.d[1], x.d[2], x.w[0], x.w[1], x.w[2], x.s[0], x.s[1], x.s[2])));
      }
      res.ok++; res.rows += rows.length;
    } catch (e) { res.fail++; console.log('bay fetch failed ' + b.id + ': ' + e); }
  }
  // 古い値（30日より前）は消す。取得の結果は管理用に1行だけ残す
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bay WHERE t < ?').bind(now - BAY_KEEP_DAYS * DAY),
    env.DB.prepare('INSERT INTO mon_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('bay_last', JSON.stringify(res))
  ]);
  __BAY_MEM = null;
  return res;
}
// 画面向けの読み出し（直近3日分）。5分は同じ拠点のメモリに置く
let __BAY_MEM = null;
async function __bayLoad(env) {
  if (__BAY_MEM && __BAY_MEM.exp > Date.now()) return __BAY_MEM.v;
  await __schema(env);
  const r = await env.DB.prepare('SELECT buoy, t, d1, d2, d3, w1, w2, w3, s1, s2, s3 FROM bay WHERE t >= ? ORDER BY t DESC').bind(Date.now() - BAY_SHOW_DAYS * DAY).all();
  const v = {};
  (r.results || []).forEach(x => { (v[x.buoy] = v[x.buoy] || []).push([x.t, [x.d1, x.d2, x.d3], [x.w1, x.w2, x.w3], [x.s1, x.s2, x.s3]]); });
  __BAY_MEM = { v, exp: Date.now() + 5 * 60000 };
  return v;
}

/** 潮位観測所の名前（共有キャッシュ経由。取れなければ空） */
async function __stationNames(env) {
  const stat = { kv: 0, up: 0, edge: 0, waits: [] }, names = {};
  try {
    const out = await __runBatch([['s', 'getStations', []]], null, env, stat);
    const list = out.done.s && out.done.s.result;
    (list || []).forEach(s => { names[s.c] = s.n; });
  } catch (e) { /* 名前なしで続ける */ }
  MON_PENDING = null;   // 管理画面の読み込みは利用状況に数えない
  await Promise.all(stat.waits);
  return names;
}

/** いま使っている人の数（直近 LIVE_MS に通信した端末） */
async function __live(env) {
  await __schema(env);
  const now = Date.now(), r = await env.DB.prepare('SELECT count(*) AS n FROM live WHERE t > ?').bind(now - LIVE_MS).first();
  return { n: r ? r.n : 0, windowMin: LIVE_MS / 60000, at: now };
}

/** いま使っている人の数を記録する（Cron から1分ごと。時刻は分の頭にそろえる） */
async function __liveSample(env, at) {
  const l = await __live(env), t = Math.floor((at || l.at) / 60000) * 60000;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO live_hist (t, n) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET n = excluded.n').bind(t, l.n),
    env.DB.prepare('DELETE FROM live_hist WHERE t < ?').bind(t - 2 * DAY)
  ]);
}
/** いま使っている人の数の推移（直近 minutes 分、最大2日） */
async function __liveHist(env, minutes) {
  await __schema(env);
  const m = Math.min(Math.max(Math.round(+minutes) || 180, 10), 2880), now = Date.now();
  const r = await env.DB.prepare('SELECT t, n FROM live_hist WHERE t >= ? ORDER BY t').bind(now - m * 60000).all();
  return { pts: (r.results || []).map(x => [x.t, x.n]), now: now, live: await __live(env) };
}

/**
 * 管理画面のデータ。days 日ぶん（日ごと）、または hours を指定すると直近 hours 時間ぶん（時間ごと）。
 * 時間ごとのときは users が [時間帯, 匿名ID] になる
 */
async function __monData(env, days, hoursArg) {
  await __schema(env);
  const nHours = hoursArg ? Math.min(Math.max(Math.round(+hoursArg) || 0, 1), 72) : 0;
  days = nHours ? Math.ceil(nHours / 24) : Math.min(Math.max(+days || 30, 1), 365);
  const now = Date.now(), today = ymd_(now), curHour = monHourKey_(now);
  const sinceKey = nHours ? monHourKey_(now - (nHours - 1) * HOUR) : ymd_(now - (days - 1) * DAY), since = sinceKey.slice(0, 10);
  const [a, b, cnt, meta, names, live] = await Promise.all([
    env.DB.prepare('SELECT hour, data FROM mon_hourly WHERE hour >= ?').bind(sinceKey).all(),
    env.DB.prepare('SELECT hour, data FROM mon WHERE hour >= ?').bind(sinceKey).all(),
    env.DB.prepare('SELECT count(*) AS n FROM mon').first(),
    env.DB.prepare('SELECT v FROM mon_meta WHERE k = \'last_compact\'').first(),
    __stationNames(env),
    __live(env)
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
    Object.keys(h.ids).forEach(id => { users[(nHours ? hk : d) + '|' + id] = 1; });
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
    source: 'cloudflare', days: days, hours: nHours || null, since: since, sinceKey: sinceKey, now: now, live: live,
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
      if (url.searchParams.get('format') === 'live') return __json(await __live(env));
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
        if (req.fn === 'getMonitorData') { await __compact(env, 24).catch(e => console.log('compact failed: ' + e)); return __json({ result: await __monData(env, a[1], a[2]) }); }
        // 文章の要約は日単位（時間単位の期間では1日ぶん）
        if (req.fn === 'getMonitorSummaryText') return __json({ result: monSummaryText_(monSummaryFrom_(await __monData(env, a[2] ? 1 : a[1]))) });
        if (req.fn === 'getLive') return __json({ result: await __live(env) });
        if (req.fn === 'getLiveHist') return __json({ result: await __liveHist(env, a[1]) });
        if (req.fn === 'adminFlush') return __json({ result: await __compact(env, 48) });
        return __json({ error: '不正な呼び出しです' }, 400);
      } catch (e) { return __json({ error: String((e && e.message) || e) }, 500); }
    }
    if (request.method === 'GET' && url.pathname === '/health') return __json({ ok: true, at: new Date().toISOString() }, 200, cors);
    if (request.method !== 'POST') return __json({ error: 'not found' }, 404, cors);
    if (!okOrigin) return __json({ error: 'forbidden' }, 403, cors);

    const stat = { kv: 0, up: 0, edge: 0, waits: [] };
    let out;
    try {
      const req = await request.json();
      const a = req.args || [];
      if (req.fn === 'callBatch') out = { result: await __runBatch(a[0], a[2], env, stat) };
      else if (req.fn === 'track') {
        monRecord_(a[0]);
        // 画面を閉じたときの送信（bye）：いま使っている人から外す
        const ev = a[0];
        if (ev && Array.isArray(ev.list) && ev.list.some(x => Array.isArray(x) && x[0] === 'bye') && /^[A-Za-z0-9]{6,16}$/.test(String(ev.aid || ''))) __LIVE_BYE.push(String(ev.aid));
        out = { result: true };
      }
      else throw new Error('不正な呼び出しです');
    } catch (e) {
      out = { error: String((e && e.message) || e) };
    }
    monCommit_();
    ctx.waitUntil(Promise.all(stat.waits).then(() => __writeMon(env)));
    return __json(out, 200, Object.assign({ 'x-upstream': String(stat.up), 'x-edge': String(stat.edge), 'x-kv': String(stat.kv) }, cors));
  },
  // Cron トリガー（1分ごと）：いま使っている人の数を記録。終わった時間帯のまとめは5分に1回
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const at = event.scheduledTime || Date.now();
    ctx.waitUntil(__liveSample(env, at).catch(e => console.log('live sample failed: ' + e)));
    if (new Date(at).getUTCMinutes() === BAY_MIN) ctx.waitUntil(__bayFetch(env, at).catch(e => console.log('bay failed: ' + e)));
    if (Math.floor(at / 60000) % 5 === 0) ctx.waitUntil(__compact(env, 48).catch(e => console.log('compact failed: ' + e)));
  }
};
