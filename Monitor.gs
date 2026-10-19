/**
 * 利用状況のモニタリング
 *
 * - 画面はデータ取得の通信（callWithPre）に利用状況のイベントを相乗りさせて送る（通信回数は増やさない）
 * - サーバーはイベントを1時間ごとにキャッシュへまとめ（mon_h_YYYY-MM-DD HH）、15分ごとのトリガー（flushMonitor）で
 *   終わった時間帯をスプレッドシートに書き込み、異常があればメールで知らせる
 * - 管理画面は ?admin=合言葉 で開く（admin.html）
 *
 * 初回と、権限が増えたときに Apps Script のエディタで setupMonitor() を実行する
 * （スプレッドシート・合言葉・トリガーを用意し、管理画面の URL をログに出す）。
 * 個人を特定する情報は集めない（匿名ID・潮位観測所コード・約10km単位の地域・機能名・エラー名・端末の種類など）。
 */

var MON_SHEETS = {
  hourly: ['日時', '表示回数', '利用者数', 'URL Fetch回数', '上限超え', 'サーバーエラー', '画面エラー', '使用中（5分単位）'],
  users: ['日付', '匿名ID'],
  stations: ['日付', '潮位観測所コード', '潮位観測所名', '回数'],
  areas: ['日付', '地域（約10km）', '回数'],
  features: ['日付', '機能', '回数'],
  errors: ['日付', '種類', '内容', '回数'],
  sites: ['日付', 'サイト', 'サーバーから', 'ブラウザから'],
  referrers: ['日付', '流入元', '回数'],
  failures: ['日付', '場所', 'サイト', '状態', '回数'],
  quality: ['日付', '内容', '回数'],
  perf: ['日付', '場所', '処理', '回数', '合計ms', '最大ms', '1秒未満', '3秒未満', '10秒未満', '10秒以上'],
  env: ['日付', '項目', '回数'],
  geo: ['日付', '結果', '回数'],
  alerts: ['日時', '種類', '内容']
};
var MON_HOST_RE = /^[a-z0-9.\-]{3,80}$/;
// 機能名・エラー名などに使える文字（送られてきた値はこれで絞る）
var MON_NAME_RE = /^[A-Za-z0-9_:.\-]{1,40}$/;
// 通知のしきい値（1時間あたり）。同じ通知は6時間に1回まで
var MON_ALERT = {
  ufWarn: 0.8, ufCrit: 0.95,       // URL Fetch の1日の上限に対する割合
  serverErr: 3,                    // サーバーエラー
  clientErrRate: 0.3, clientErrMin: 10,   // 画面エラー（表示回数に対する割合と最低件数）
  hostFailServer: 3,               // サーバーからの取得失敗（404 以外）
  hostFailClient: 5,               // ブラウザからの取得失敗（404・通信切れ以外）
  hostNetClient: 20,               // ブラウザの通信切れ（多いときはサイト側の停止の可能性）
  stale: 3,                        // 同じ潮位観測所の「更新停止」
  quietHours: 6
};

function monHourKey_(ms) {
  var p = jstParts_(ms);
  return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2) + ' ' + ('0' + p.h).slice(-2);
}
function monBufKey_(hk) { return CACHE_VER + 'mon_h_' + hk; }
var MON_SHARDS = 16;
function monShardKeys_(hk) { var a = []; for (var i = 0; i < MON_SHARDS; i++) a.push(monBufKey_(hk) + '_' + i); return a; }
function monEmptyHour_() {
  return { pv: 0, ids: {}, st: {}, area: {}, f: {}, cerr: 0, serr: 0, lim: 0, err: {}, sv: {}, cl: {}, ref: {},
    svf: {}, clf: {}, q: {}, perf: {}, env: {}, geo: {}, alive: 0 };
}
function monFill_(h) { var e = monEmptyHour_(); Object.keys(e).forEach(function (k) { if (h[k] == null) h[k] = e[k]; }); return h; }

/**
 * この呼び出しの間に起きたことは MON_PENDING に貯め、最後に monCommit_ で1回だけ書く。
 * 書き込みはロックを使わず、16個に分けた一時保存のどれかに足す（順番待ちで利用者を待たせない）。
 */
var MON_PENDING = null;
function monPend_() { return MON_PENDING || (MON_PENDING = monEmptyHour_()); }
function monUpdate_(fn) { fn(monPend_()); return true; }
function monCommit_() {
  var p = MON_PENDING;
  MON_PENDING = null;
  if (!p || monIsEmpty_(p)) return;
  try {
    var cache = CacheService.getScriptCache(), k = monBufKey_(monHourKey_(Date.now())) + '_' + Math.floor(Math.random() * MON_SHARDS), h;
    try { h = JSON.parse(cache.get(k) || 'null'); } catch (e) { h = null; }
    h = monMerge_(monFill_(h || {}), p);
    cache.put(k, JSON.stringify(h), 21600);
  } catch (e) { monDrop_(); }   // 100KB 超など
}
function monIsEmpty_(h) {
  return !h.pv && !h.cerr && !h.serr && !h.lim && !h.alive && ['ids', 'st', 'f', 'sv', 'cl', 'svf', 'clf', 'q', 'perf', 'geo', 'err'].every(function (k) { return !Object.keys(h[k]).length; });
}
/** 一時保存どうしを足し合わせる */
function monMerge_(a, b) {
  ['pv', 'cerr', 'serr', 'lim', 'alive'].forEach(function (k) { a[k] = (a[k] || 0) + (b[k] || 0); });
  Object.keys(b.ids || {}).forEach(function (k) { a.ids[k] = 1; });
  ['st', 'area', 'f', 'err', 'sv', 'cl', 'ref', 'svf', 'clf', 'q', 'env', 'geo'].forEach(function (f) {
    Object.keys(b[f] || {}).forEach(function (k) { monInc_(a[f], k, b[f][k]); });
  });
  Object.keys(b.perf || {}).forEach(function (k) { monPerfAdd_(a.perf, k, b.perf[k]); });
  return a;
}
/** その時間帯の一時保存（16個＋以前の形式）をまとめて読む */
function monReadHour_(cache, hk) {
  var keys = monShardKeys_(hk).concat([monBufKey_(hk)]), got = cache.getAll(keys), h = monEmptyHour_(), bytes = 0, found = false;
  keys.forEach(function (k) {
    if (!got[k]) return;
    found = true; bytes = Math.max(bytes, got[k].length);
    try { monMerge_(h, monFill_(JSON.parse(got[k]))); } catch (e) { /* 壊れた分は捨てる */ }
  });
  return found ? { h: h, keys: keys, bytes: bytes } : null;
}
/** 取りこぼしの件数（日ごと） */
function monDrop_() {
  try {
    var props = PropertiesService.getScriptProperties(), today = ymd_(Date.now()), j = {};
    try { j = JSON.parse(props.getProperty('mon_drop') || '{}'); } catch (e) { j = {}; }
    props.setProperty('mon_drop', JSON.stringify({ d: today, n: (j.d === today ? +j.n || 0 : 0) + 1 }));
  } catch (e) { /* 無視 */ }
}
function monInc_(o, k, n) { o[k] = (o[k] || 0) + (n || 1); }
// 応答時間の集計 [回数, 合計ms, 最大ms, 1秒未満, 3秒未満, 10秒未満, 10秒以上]
function monPerfAdd_(o, k, p) {
  var x = o[k] || (o[k] = [0, 0, 0, 0, 0, 0, 0]);
  x[0] += p[0]; x[1] += p[1]; x[2] = Math.max(x[2], p[2]);
  for (var i = 3; i < 7; i++) x[i] += p[i];
}

/**
 * 画面から届いたイベントを記録する。
 * ev = { aid: 匿名ID, list: [[種類, 値], …] }
 *   pv：表示 {st, area, ref, env}、st：潮位観測所を選んだ、f：機能、e：画面のエラー、h：外部サイトごとの回数、
 *   hf：外部サイトの失敗、p：応答時間、q：データの異常、g：位置情報の結果、a：使用中（5分ごと）
 */
function monRecord_(ev) {
  try {
    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.list) || !ev.list.length) return;
    var aid = /^[A-Za-z0-9]{6,16}$/.test(String(ev.aid || '')) ? String(ev.aid) : '';
    var list = ev.list.slice(0, 60);
    monUpdate_(function (h) {
      if (aid) h.ids[aid] = 1;
      list.forEach(function (x) {
        if (!Array.isArray(x)) return;
        var kind = x[0], v = x[1];
        if (kind === 'pv') {
          h.pv++;
          if (v && /^\d{6}$/.test(String(v.st || ''))) monInc_(h.st, String(v.st));
          if (v && /^\d{2}\.\d,\d{3}\.\d$/.test(String(v.area || ''))) monInc_(h.area, String(v.area));
          if (v && /^[a-z0-9.:_\-]{1,60}$/.test(String(v.ref || ''))) monInc_(h.ref, String(v.ref));
          if (v && Array.isArray(v.env)) v.env.slice(0, 8).forEach(function (e) { if (MON_NAME_RE.test(String(e))) monInc_(h.env, String(e)); });
        } else if (kind === 'st') {
          if (/^\d{6}$/.test(String(v || ''))) monInc_(h.st, String(v));
        } else if (kind === 'f') {
          if (MON_NAME_RE.test(String(v || ''))) monInc_(h.f, String(v));
        } else if (kind === 'h' || kind === 'hf') {
          // 外部サイトごとの回数 { host: 回数 }／失敗 { 'host|状態': 回数 }
          if (v && typeof v === 'object') Object.keys(v).slice(0, 40).forEach(function (k) {
            var n = Math.floor(+v[k]), host = kind === 'h' ? k : k.split('|')[0], st = kind === 'h' ? '' : k.split('|')[1];
            if (!MON_HOST_RE.test(host) || !(n > 0 && n <= 5000)) return;
            if (kind === 'h') monInc_(h.cl, host, n);
            else if (/^[a-z0-9]{1,10}$/.test(String(st))) monInc_(h.clf, host + '|' + st, n);
          });
        } else if (kind === 'p') {
          if (v && typeof v === 'object') Object.keys(v).slice(0, 20).forEach(function (name) {
            var p = v[name];
            if (!MON_NAME_RE.test(name) || !Array.isArray(p) || p.length !== 7) return;
            p = p.map(function (x) { return Math.max(0, Math.min(+x || 0, 1e8)); });
            monPerfAdd_(h.perf, 'c:' + name, p);
          });
        } else if (kind === 'q') {
          if (MON_NAME_RE.test(String(v || ''))) monInc_(h.q, String(v));
        } else if (kind === 'g') {
          if (/^(gas|pages):(ok|denied|timeout|unavailable|unsupported)$/.test(String(v || ''))) monInc_(h.geo, String(v));
        } else if (kind === 'a') {
          h.alive++;
        } else if (kind === 'e') {
          h.cerr++;
          if (MON_NAME_RE.test(String(v || ''))) monInc_(h.err, 'client:' + v);
        }
      });
    });
  } catch (e) { /* 記録の失敗でアプリを止めない */ }
}

/** サーバーでの外部サイトへの取得回数・失敗・処理時間（呼び出しの終わりにまとめて書く） */
function monHostOf_(url) { var m = /^https?:\/\/([^\/?#]+)/.exec(String(url)); return m ? m[1] : ''; }
function monCountHost_(url) { var h = monHostOf_(url); if (h) monInc_(monPend_().sv, h); }
function monFailHost_(url, status) { var h = monHostOf_(url); if (h) monInc_(monPend_().svf, h + '|' + status); }
function monServerPerf_(name, ms) {
  monPerfAdd_(monPend_().perf, 's:' + String(name).replace(/[^A-Za-z]/g, '').slice(0, 30),
    [1, ms, ms, ms < 1000 ? 1 : 0, ms >= 1000 && ms < 3000 ? 1 : 0, ms >= 3000 && ms < 10000 ? 1 : 0, ms >= 10000 ? 1 : 0]);
}
function monFlushHosts_() { monCommit_(); }

/** サーバーで見つけたデータの異常・一時停止など */
function monQuality_(k) {
  try { monUpdate_(function (h) { monInc_(h.q, k); }); } catch (e) { /* 無視 */ }
}

/** サーバー側の出来事（上限超え・エラー）を記録する */
function monServer_(kind, name) {
  try {
    monUpdate_(function (h) {
      if (kind === 'lim') h.lim++;
      else { h.serr++; monInc_(h.err, 'server:' + String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 30)); }
    });
  } catch (e) { /* 無視 */ }
}

/* ------------------------------------------------------------------ */
/* スプレッドシートへの書き込みと通知（15分ごとのトリガー）              */
/* ------------------------------------------------------------------ */

function monSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('MON_SHEET_ID');
  if (!id) throw new Error('setupMonitor() を実行してください');
  return SpreadsheetApp.openById(id);
}
/** 直近6時間の一時保存（キャッシュの保存期間） */
function monRecentHours_(now) {
  var out = [];
  for (var i = 6; i >= 0; i--) out.push(monHourKey_(now - i * HOUR));
  return out;
}

/** 終わった時間帯の分をスプレッドシートに書き出し（今の時間帯は残す）、異常があれば通知する */
function flushMonitor() {
  var now = Date.now(), cur = monHourKey_(now), done = {}, cache = CacheService.getScriptCache();
  monRecentHours_(now).forEach(function (hk) {
    if (hk >= cur) return;
    var r = monReadHour_(cache, hk);
    if (r) { done[hk] = r.h; cache.removeAll(r.keys); }
  });
  // 以前の形式（mon_buf）に残っている分
  var old = cache.get(CACHE_VER + 'mon_buf');
  if (old) {
    try { var ob = JSON.parse(old).h || {}; Object.keys(ob).forEach(function (hk) { if (hk < cur && !done[hk]) done[hk] = monFill_(ob[hk]); }); } catch (e) { /* 無視 */ }
    cache.remove(CACHE_VER + 'mon_buf');
  }
  var hours = Object.keys(done).sort(), ss = monSheet_();
  monEnsureSheets_(ss);
  if (hours.length) monWrite_(ss, hours, done, cache);
  var props = PropertiesService.getScriptProperties();
  props.setProperty('mon_last_flush', JSON.stringify({ t: now, hours: hours.length }));
  // 通知：今の時間帯（途中まで）と、いま書き出した直近の時間帯
  try {
    var cr = monReadHour_(cache, cur), curH = cr ? cr.h : monEmptyHour_();
    monCheckAlerts_(ss, now, [curH].concat(hours.length ? [done[hours[hours.length - 1]]] : []));
    monDailySummary_(ss, now);
  } catch (e) { Logger.log('通知の確認に失敗：' + e); }
  return hours.length;
}

function monWrite_(ss, hours, done, cache) {
  var stations = {};
  try { getStations().forEach(function (s) { stations[s.c] = s.n; }); } catch (e) { /* 名前なしで記録 */ }
  var rows = {};
  Object.keys(MON_SHEETS).forEach(function (n) { rows[n] = []; });
  // 利用者の重複は日ごとに除く（既に書いた匿名IDは飛ばす）
  var userSheet = ss.getSheetByName('users'), seen = {};
  var last = userSheet.getLastRow();
  if (last > 1) {
    var from = Math.max(2, last - 5000);
    userSheet.getRange(from, 1, last - from + 1, 2).getDisplayValues().forEach(function (r) { seen[r[0] + '|' + r[1]] = 1; });
  }
  hours.forEach(function (hk) {
    var h = done[hk], day = hk.slice(0, 10);
    var hourStart = Date.UTC(+hk.slice(0, 4), +hk.slice(5, 7) - 1, +hk.slice(8, 10), +hk.slice(11, 13)) - JST;
    var uf = +(cache.get(CACHE_VER + 'uf_h_' + Math.floor(hourStart / HOUR)) || 0);
    rows.hourly.push([hk + ':00', h.pv, Object.keys(h.ids).length, uf, h.lim, h.serr, h.cerr, h.alive]);
    Object.keys(h.ids).forEach(function (a) { if (!seen[day + '|' + a]) { seen[day + '|' + a] = 1; rows.users.push([day, a]); } });
    Object.keys(h.st).forEach(function (c) { rows.stations.push([day, c, stations[c] || '', h.st[c]]); });
    Object.keys(h.area).forEach(function (a) { rows.areas.push([day, a, h.area[a]]); });
    Object.keys(h.f).forEach(function (f) { rows.features.push([day, f, h.f[f]]); });
    Object.keys(h.err).forEach(function (k) { var i = k.indexOf(':'); rows.errors.push([day, k.slice(0, i), k.slice(i + 1), h.err[k]]); });
    var hosts = {};
    Object.keys(h.sv).concat(Object.keys(h.cl)).forEach(function (k) { hosts[k] = 1; });
    Object.keys(hosts).forEach(function (k) { rows.sites.push([day, k, h.sv[k] || 0, h.cl[k] || 0]); });
    Object.keys(h.ref).forEach(function (k) { rows.referrers.push([day, k, h.ref[k]]); });
    [['server', h.svf], ['client', h.clf]].forEach(function (x) {
      Object.keys(x[1]).forEach(function (k) { var p = k.split('|'); rows.failures.push([day, x[0], p[0], p[1], x[1][k]]); });
    });
    Object.keys(h.q).forEach(function (k) { rows.quality.push([day, k, h.q[k]]); });
    Object.keys(h.perf).forEach(function (k) {
      var p = h.perf[k], i = k.indexOf(':');
      rows.perf.push([day, k.slice(0, i) === 's' ? 'server' : 'client', k.slice(i + 1)].concat(p));
    });
    Object.keys(h.env).forEach(function (k) { rows.env.push([day, k, h.env[k]]); });
    Object.keys(h.geo).forEach(function (k) { rows.geo.push([day, k, h.geo[k]]); });
  });
  Object.keys(rows).forEach(function (name) {
    var r = rows[name];
    if (!r.length) return;
    var sh = ss.getSheetByName(name);
    sh.getRange(sh.getLastRow() + 1, 1, r.length, r[0].length).setValues(r);
  });
}

/** 後から増えたシート・列を足す */
function monEnsureSheets_(ss) {
  Object.keys(MON_SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name), head = MON_SHEETS[name];
    if (sh.getLastRow() === 0) { sh.appendRow(head); sh.setFrozenRows(1); }
    else if (sh.getLastColumn() < head.length) sh.getRange(1, 1, 1, head.length).setValues([head]);
  });
}

/* ------------------------------------------------------------------ */
/* 通知（メール）                                                       */
/* ------------------------------------------------------------------ */

function monAlertCfg_() {
  var props = PropertiesService.getScriptProperties(), cfg = {};
  try { cfg = JSON.parse(props.getProperty('MON_ALERT_CFG') || '{}'); } catch (e) { cfg = {}; }
  return { alerts: cfg.alerts !== false, daily: cfg.daily !== false, to: props.getProperty('ALERT_TO') || '' };
}
function monAlertTo_() {
  var to = monAlertCfg_().to;
  if (to) return to;
  try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
}
function monSendMail_(subject, body) {
  var to = monAlertTo_();
  if (!to) return false;
  MailApp.sendEmail({ to: to, subject: '[my tide-graph] ' + subject, body: body + '\n\n管理画面とスプレッドシートで詳しい状況を確認できます。\n（このメールは my tide-graph の監視から自動で送っています）' });
  return true;
}
/** 1時間ぶんの集計から異常を探して通知する（同じ通知は6時間に1回まで） */
function monCheckAlerts_(ss, now, hs) {
  var cfg = monAlertCfg_();
  if (!cfg.alerts) return;
  var props = PropertiesService.getScriptProperties(), sent = {};
  try { sent = JSON.parse(props.getProperty('mon_alert_sent') || '{}'); } catch (e) { sent = {}; }
  var items = [];
  var add = function (key, kind, text) {
    if (sent[key] && now - sent[key] < MON_ALERT.quietHours * HOUR) return;
    if (items.some(function (x) { return x.key === key; })) return;
    items.push({ key: key, kind: kind, text: text });
  };
  // URL Fetch の1日の使用量
  var uf = 0;
  try { var j = JSON.parse(props.getProperty('uf_day') || '{}'); uf = j.d === ymd_(now) ? +j.n || 0 : 0; } catch (e) { uf = 0; }
  if (uf >= FETCH_LIMIT.day * MON_ALERT.ufCrit) add('uf_crit_' + ymd_(now), 'URL Fetch 上限間近', '今日の URL Fetch が ' + uf + ' 回（上限 ' + FETCH_LIMIT.day + ' 回の ' + Math.round(uf / FETCH_LIMIT.day * 100) + '%）です。まもなく新しいデータを取得できなくなります。');
  else if (uf >= FETCH_LIMIT.day * MON_ALERT.ufWarn) add('uf_warn_' + ymd_(now), 'URL Fetch 注意', '今日の URL Fetch が ' + uf + ' 回（上限 ' + FETCH_LIMIT.day + ' 回の ' + Math.round(uf / FETCH_LIMIT.day * 100) + '%）に達しました。');
  var stNames = null;
  hs.forEach(function (h) {
    if (!h) return;
    if (h.lim > 0) add('lim', '上限超え', 'アクセスが集中し、' + h.lim + ' 回の取得を断りました（1時間あたりの上限 ' + FETCH_LIMIT.hour + ' 回）。');
    if (h.serr >= MON_ALERT.serverErr) add('serr', 'サーバーエラー', '1時間にサーバーエラーが ' + h.serr + ' 件ありました：' + monTop_(h.err, 'server:'));
    if (h.cerr >= MON_ALERT.clientErrMin && h.cerr >= h.pv * MON_ALERT.clientErrRate) add('cerr', '画面エラー', '1時間に画面でのエラーが ' + h.cerr + ' 件（表示 ' + h.pv + ' 回）ありました：' + monTop_(h.err, 'client:'));
    // 外部サイトの失敗
    var byHost = {};
    [['server', h.svf], ['client', h.clf]].forEach(function (x) {
      Object.keys(x[1]).forEach(function (k) {
        var p = k.split('|'), st = p[1], n = x[1][k];
        if (st === '404') return;   // 404 はまだ公開されていないファイルなど、普段から起きる
        var b = byHost[p[0]] || (byHost[p[0]] = { server: 0, client: 0, net: 0, detail: [] });
        if (x[0] === 'client' && st === 'net') b.net += n; else b[x[0]] += n;
        b.detail.push((x[0] === 'server' ? 'サーバー' : 'ブラウザ') + ' ' + st + '×' + n);
      });
    });
    Object.keys(byHost).forEach(function (host) {
      var b = byHost[host];
      if (b.server >= MON_ALERT.hostFailServer || b.client >= MON_ALERT.hostFailClient || b.net >= MON_ALERT.hostNetClient) {
        add('host_' + host, 'データ元の異常', host + ' からの取得に失敗しています（' + b.detail.join('、') + '）。サイトの停止や仕様変更の可能性があります。');
      }
    });
    // データの異常（更新停止）
    Object.keys(h.q).forEach(function (k) {
      var m = /^tide_stale:(\d{6})$/.exec(k);
      if (!m || h.q[k] < MON_ALERT.stale) return;
      if (!stNames) { stNames = {}; try { getStations().forEach(function (s) { stNames[s.c] = s.n; }); } catch (e) { /* 無視 */ } }
      add('stale_' + m[1], '潮位の更新停止', '潮位観測所「' + (stNames[m[1]] || m[1]) + '」の観測データが更新されていないと、' + h.q[k] + ' 回表示されました。配信元の停止の可能性があります。');
    });
  });
  // 集計が止まっていた（前回の集計から1時間以上）
  try {
    var lf = JSON.parse(props.getProperty('mon_last_flush_prev') || 'null');
    if (lf && now - lf.t > HOUR + 20 * MIN) add('flush_gap', '集計の遅れ', '前回の集計から ' + Math.round((now - lf.t) / MIN) + ' 分たっていました。トリガーが止まっていた可能性があります。');
  } catch (e) { /* 無視 */ }
  props.setProperty('mon_last_flush_prev', JSON.stringify({ t: now }));
  if (!items.length) return;
  var body = items.map(function (x) { return '■ ' + x.kind + '\n' + x.text; }).join('\n\n');
  if (monSendMail_(items.length === 1 ? items[0].kind : '異常 ' + items.length + ' 件（' + items.map(function (x) { return x.kind; }).join('・') + '）', body)) {
    items.forEach(function (x) { sent[x.key] = now; });
    Object.keys(sent).forEach(function (k) { if (now - sent[k] > 2 * DAY) delete sent[k]; });
    props.setProperty('mon_alert_sent', JSON.stringify(sent));
    var sh = ss.getSheetByName('alerts');
    var t = monHourKey_(now) + ':' + ('0' + new Date(now + JST).getUTCMinutes()).slice(-2);
    sh.getRange(sh.getLastRow() + 1, 1, items.length, 3).setValues(items.map(function (x) { return [t, x.kind, x.text]; }));
  }
}
function monTop_(o, prefix) {
  return Object.keys(o).filter(function (k) { return k.indexOf(prefix) === 0; }).sort(function (a, b) { return o[b] - o[a]; }).slice(0, 5)
    .map(function (k) { return k.slice(prefix.length) + '×' + o[k]; }).join('、') || '（内訳なし）';
}
/** 毎朝7時以降の最初の集計で、前日の要約を送る */
function monDailySummary_(ss, now) {
  var cfg = monAlertCfg_(), props = PropertiesService.getScriptProperties(), today = ymd_(now);
  if (!cfg.daily || jstParts_(now).h < 7 || props.getProperty('mon_daily_sent') === today) return;
  var y = ymd_(now - DAY);
  var read = function (name) {
    var sh = ss.getSheetByName(name), n = sh.getLastRow();
    if (n < 2) return [];
    var from = Math.max(2, n - 3000);
    return sh.getRange(from, 1, n - from + 1, sh.getLastColumn()).getDisplayValues().filter(function (r) { return r[0].slice(0, 10) === y; });
  };
  var hourly = read('hourly'), pv = 0, uf = 0, lim = 0, serr = 0, cerr = 0;
  hourly.forEach(function (r) { pv += +r[1]; uf += +r[3]; lim += +r[4]; serr += +r[5]; cerr += +r[6]; });
  var users = read('users').length;
  var fails = {};
  read('failures').forEach(function (r) { if (r[3] !== '404') fails[r[2]] = (fails[r[2]] || 0) + (+r[4] || 0); });
  var q = {};
  read('quality').forEach(function (r) { q[r[1]] = (q[r[1]] || 0) + (+r[2] || 0); });
  var lines = [
    y + ' の利用状況',
    '・表示回数：' + pv + ' 回／利用者：' + users + ' 人',
    '・URL Fetch：' + uf + ' 回（上限 ' + FETCH_LIMIT.day + ' 回の ' + Math.round(uf / FETCH_LIMIT.day * 100) + '%）／上限超え：' + lim + ' 回',
    '・エラー：サーバー ' + serr + ' 件／画面 ' + cerr + ' 件',
    '・データ元の取得失敗（404 を除く）：' + (Object.keys(fails).length ? Object.keys(fails).map(function (k) { return k + ' ' + fails[k] + ' 回'; }).join('、') : 'なし'),
    '・データの異常：' + (Object.keys(q).length ? Object.keys(q).map(function (k) { return k + ' ' + q[k] + ' 回'; }).join('、') : 'なし')
  ];
  if (monSendMail_('毎日の要約（' + y + '）', lines.join('\n'))) props.setProperty('mon_daily_sent', today);
}

/* ------------------------------------------------------------------ */
/* 初回設定（エディタで実行）                                           */
/* ------------------------------------------------------------------ */

function setupMonitor() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('MON_SHEET_ID'), ss;
  if (id) { ss = SpreadsheetApp.openById(id); }
  else {
    ss = SpreadsheetApp.create('my tide-graph 利用状況');
    props.setProperty('MON_SHEET_ID', ss.getId());
  }
  monEnsureSheets_(ss);
  var def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'flushMonitor') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('flushMonitor').timeBased().everyMinutes(15).create();
  var url = ScriptApp.getService().getUrl();
  Logger.log('スプレッドシート：' + ss.getUrl());
  Logger.log('管理画面：' + url + '?admin=' + props.getProperty('ADMIN_KEY'));
  Logger.log('通知先：' + (monAlertTo_() || '（未設定）'));
}

/* ------------------------------------------------------------------ */
/* 管理画面                                                             */
/* ------------------------------------------------------------------ */

function monAdminOk_(key) {
  var k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!k && String(key || '') === k;
}

/** 管理画面のデータ（直近 days 日）。未集計の分も合わせて返す */
function getMonitorData(key, days) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  days = Math.min(Math.max(+days || 30, 1), 365);
  var now = Date.now(), since = ymd_(now - (days - 1) * DAY), today = ymd_(now);
  var ss = monSheet_(), props = PropertiesService.getScriptProperties(), cache = CacheService.getScriptCache();
  monEnsureSheets_(ss);
  var sizes = {};
  var read = function (name, all) {
    var sh = ss.getSheetByName(name), n = sh.getLastRow();
    sizes[name] = Math.max(0, n - 1) * sh.getLastColumn();
    var rows = n > 1 ? sh.getRange(2, 1, n - 1, sh.getLastColumn()).getDisplayValues() : [];
    return all ? rows : rows.filter(function (r) { return r[0].slice(0, 10) >= since; });
  };
  var sum = function (rows, ki, vi) {
    var o = {};
    rows.forEach(function (r) { o[r[ki]] = (o[r[ki]] || 0) + (+r[vi] || 0); });
    return o;
  };
  var hourly = read('hourly').map(function (r) { return [r[0], +r[1], +r[2], +r[3], +r[4], +r[5], +r[6], +r[7] || 0]; });
  // 新規・再訪：匿名IDの初めての日（全期間）で分ける
  var usersAll = read('users', true), first = {};
  usersAll.forEach(function (r) { if (!first[r[1]] || r[0] < first[r[1]]) first[r[1]] = r[0]; });
  var users = usersAll.filter(function (r) { return r[0] >= since; });
  var stRows = read('stations'), stNames = {};
  try { getStations().forEach(function (s) { stNames[s.c] = s.n; }); } catch (e) { /* 記録済みの名前を使う */ }
  stRows.forEach(function (r) { if (r[2] && !stNames[r[1]]) stNames[r[1]] = r[2]; });
  var perf = {};
  read('perf').forEach(function (r) { monPerfAdd_(perf, (r[1] === 'server' ? 's:' : 'c:') + r[2], r.slice(3, 10).map(Number)); });
  var out = {
    days: days, since: since, now: now,
    hourly: hourly,
    users: users.map(function (r) { return [r[0], r[1]]; }),
    firstSeen: (function () { var o = {}; users.forEach(function (r) { o[r[1]] = first[r[1]]; }); return o; })(),
    stations: sum(stRows, 1, 3), stationNames: stNames,
    areas: sum(read('areas'), 1, 2),
    features: sum(read('features'), 1, 2),
    errors: sum(read('errors').map(function (r) { return [r[0], r[1] + ':' + r[2], r[3]]; }), 1, 2),
    sites: (function () {
      var o = {};
      read('sites').forEach(function (r) { var x = o[r[1]] || (o[r[1]] = { sv: 0, cl: 0 }); x.sv += +r[2] || 0; x.cl += +r[3] || 0; });
      return o;
    })(),
    referrers: sum(read('referrers'), 1, 2),
    failures: sum(read('failures').map(function (r) { return [r[0], r[1] + '|' + r[2] + '|' + r[3], r[4]]; }), 1, 2),
    quality: sum(read('quality'), 1, 2),
    perf: perf,
    env: sum(read('env'), 1, 2),
    geo: sum(read('geo'), 1, 2),
    alerts: read('alerts', true).slice(-20).reverse(),
    limits: FETCH_LIMIT,
    sheetUrl: ss.getUrl()
  };
  // 未集計の分（直近6時間）
  out.pending = [];
  monRecentHours_(now).forEach(function (hk) {
    var r = monReadHour_(cache, hk);
    if (!r) return;
    var h = r.h, txt = { length: r.bytes };
    var ids = Object.keys(h.ids);
    ids.forEach(function (a) { if (!out.firstSeen[a]) out.firstSeen[a] = first[a] || hk.slice(0, 10); });
    out.pending.push({ hour: hk, bytes: txt.length, pv: h.pv, ids: ids, st: h.st, area: h.area, f: h.f, err: h.err, lim: h.lim, serr: h.serr, cerr: h.cerr,
      sv: h.sv, cl: h.cl, ref: h.ref, svf: h.svf, clf: h.clf, q: h.q, perf: h.perf, env: h.env, geo: h.geo, alive: h.alive });
  });
  out.ufHour = +(cache.get(CACHE_VER + 'uf_h_' + Math.floor(now / HOUR)) || 0);
  try { var j = JSON.parse(props.getProperty('uf_day') || '{}'); out.ufToday = j.d === today ? +j.n || 0 : 0; } catch (e) { out.ufToday = 0; }
  // 監視そのものの状態
  var health = { sizes: sizes, cells: Object.keys(sizes).reduce(function (s, k) { return s + sizes[k]; }, 0) };
  try { health.lastFlush = JSON.parse(props.getProperty('mon_last_flush') || 'null'); } catch (e) { health.lastFlush = null; }
  try { var dj = JSON.parse(props.getProperty('mon_drop') || '{}'); health.dropToday = dj.d === today ? +dj.n || 0 : 0; } catch (e) { health.dropToday = 0; }
  try { health.trigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'flushMonitor'; }); } catch (e) { health.trigger = null; }
  var cfg = monAlertCfg_();
  health.alerts = cfg.alerts; health.daily = cfg.daily; health.alertTo = monAlertTo_();
  out.health = health;
  return out;
}

/** 管理画面から「今すぐ集計」 */
function adminFlush(key) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  return flushMonitor();
}
/** 管理画面から通知の設定 */
function adminSetAlerts(key, cfg) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  cfg = cfg || {};
  var props = PropertiesService.getScriptProperties();
  props.setProperty('MON_ALERT_CFG', JSON.stringify({ alerts: cfg.alerts !== false, daily: cfg.daily !== false }));
  if (cfg.to != null) {
    var to = String(cfg.to).trim();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('メールアドレスの形式が正しくありません');
    if (to) props.setProperty('ALERT_TO', to); else props.deleteProperty('ALERT_TO');
  }
  return monAlertCfg_();
}
/** 管理画面からテストメール */
function adminTestMail(key) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  if (!monSendMail_('テスト通知', 'my tide-graph の監視からのテストメールです。異常があると、このアドレスに通知が届きます。')) throw new Error('通知先のメールアドレスがありません');
  return monAlertTo_();
}
