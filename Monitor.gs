/**
 * 利用状況のモニタリング（記録の形と要約）
 *
 * - 画面はデータ取得の通信に利用状況のイベントを相乗りさせて送る（通信回数は増やさない）
 * - 記録・保存・管理画面は Cloudflare Workers（tide-api、cloudflare/api/tail.js）。D1 に保存し、/admin で管理画面を開く
 * - このファイルは記録の形（monRecord_ など）と要約（monSummaryFrom_・monSummaryText_）で、tools/build-worker.js が Workers に組み込む
 * - Apps Script（Code.gs）では記録しない（monCommit_ は何もしない）。Apps Script の監視（スプレッドシート・トリガー・メール）は monitor v2.0.0 で廃止
 *
 * 個人を特定する情報は集めない（匿名ID・潮位観測所コード・約10km単位の地域・機能名・エラー名・端末の種類など）。
 */

// 利用状況アプリ（Monitor.gs と admin.html）のバージョン。更新したら CHANGELOG-monitor.md にも書き、monitor-vX.Y.Z のタグを付ける
var MONITOR_VERSION = '2.5.2', MONITOR_DATE = '2026-10-21';

var MON_HOST_RE = /^[a-z0-9.\-]{3,80}$/;
// 機能名・エラー名などに使える文字（送られてきた値はこれで絞る）
var MON_NAME_RE = /^[A-Za-z0-9_:.\-]{1,40}$/;

/** 時間帯のキー 'YYYY-MM-DD HH'（JST） */
function monHourKey_(ms) {
  var p = jstParts_(ms);
  return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2) + ' ' + ('0' + p.h).slice(-2);
}
/** 1時間ぶんの記録の形 */
function monEmptyHour_() {
  return { pv: 0, ids: {}, st: {}, area: {}, f: {}, cerr: 0, serr: 0, lim: 0, err: {}, sv: {}, cl: {}, ref: {},
    svf: {}, clf: {}, q: {}, perf: {}, env: {}, geo: {}, alive: 0 };
}
function monFill_(h) { var e = monEmptyHour_(); Object.keys(e).forEach(function (k) { if (h[k] == null) h[k] = e[k]; }); return h; }

/**
 * この呼び出しの間に起きたことは MON_PENDING に貯め、最後に monCommit_ で1回だけ書く。
 * 書き先は Workers（tail.js が monCommit_ を D1 への書き込みに置き換える）。Apps Script では捨てる
 */
var MON_PENDING = null;
function monPend_() { return MON_PENDING || (MON_PENDING = monEmptyHour_()); }
function monUpdate_(fn) { fn(monPend_()); return true; }
function monCommit_() { MON_PENDING = null; }
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
/* 要約（JSON・テキスト）：スクリーンショットなしで状況を読めるように   */
/* ------------------------------------------------------------------ */

/** 管理画面のデータ（cloudflare/api/tail.js の __monData の形）から要約を作る */
function monSummaryFrom_(d) {
  var now = d.now, today = ymd_(now);
  var dayList = [];
  for (var i = d.days - 1; i >= 0; i--) dayList.push(ymd_(now - i * DAY));
  var byDay = {}, hourly = {}, users = {}, all = {};
  dayList.forEach(function (x) { byDay[x] = { day: x, pv: 0, users: 0, newUsers: 0, uf: 0, lim: 0, serr: 0, cerr: 0, alive: 0 }; users[x] = {}; });
  d.hourly.forEach(function (r) {
    var x = r[0].slice(0, 10), b = byDay[x];
    if (!b) return;
    b.pv += r[1]; b.uf += r[3]; b.lim += r[4]; b.serr += r[5]; b.cerr += r[6]; b.alive += r[7] || 0;
    hourly[r[0].slice(0, 13)] = (hourly[r[0].slice(0, 13)] || 0) + r[1];
  });
  d.users.forEach(function (r) { if (users[r[0]]) { users[r[0]][r[1]] = 1; all[r[1]] = 1; } });
  var add = function (o, src, pre) { Object.keys(src || {}).forEach(function (k) { var kk = (pre || '') + k; o[kk] = (o[kk] || 0) + src[k]; }); };
  var st = Object.assign({}, d.stations), ar = Object.assign({}, d.areas), fe = Object.assign({}, d.features), er = Object.assign({}, d.errors);
  var rf = Object.assign({}, d.referrers), fa = Object.assign({}, d.failures), qa = Object.assign({}, d.quality), en = Object.assign({}, d.env), ge = Object.assign({}, d.geo);
  var si = {}, pf = {};
  Object.keys(d.sites).forEach(function (k) { si[k] = { sv: d.sites[k].sv, cl: d.sites[k].cl }; });
  Object.keys(d.perf).forEach(function (k) { pf[k] = d.perf[k].slice(); });
  d.pending.forEach(function (p) {
    var x = p.hour.slice(0, 10), b = byDay[x];
    if (!b) return;
    b.pv += p.pv; b.lim += p.lim; b.serr += p.serr; b.cerr += p.cerr; b.alive += p.alive || 0;
    hourly[p.hour] = (hourly[p.hour] || 0) + p.pv;
    p.ids.forEach(function (a) { users[x][a] = 1; all[a] = 1; });
    add(st, p.st); add(ar, p.area); add(fe, p.f); add(er, p.err); add(rf, p.ref); add(qa, p.q); add(en, p.env); add(ge, p.geo);
    Object.keys(p.svf || {}).forEach(function (k) { fa['server|' + k] = (fa['server|' + k] || 0) + p.svf[k]; });
    Object.keys(p.clf || {}).forEach(function (k) { fa['client|' + k] = (fa['client|' + k] || 0) + p.clf[k]; });
    Object.keys(p.sv || {}).forEach(function (k) { (si[k] = si[k] || { sv: 0, cl: 0 }).sv += p.sv[k]; });
    Object.keys(p.cl || {}).forEach(function (k) { (si[k] = si[k] || { sv: 0, cl: 0 }).cl += p.cl[k]; });
    Object.keys(p.perf || {}).forEach(function (k) { monPerfAdd_(pf, k, p.perf[k]); });
  });
  dayList.forEach(function (x) {
    var ids = Object.keys(users[x]);
    byDay[x].users = ids.length;
    byDay[x].newUsers = ids.filter(function (a) { return (d.firstSeen[a] || x) >= x; }).length;
  });
  if (byDay[today]) byDay[today].uf = Math.max(byDay[today].uf, d.ufToday);
  var top = function (o, n, name) {
    return Object.keys(o).map(function (k) { return { key: k, name: name ? name(k) : k, n: o[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, n || 10);
  };
  var sum = function (k) { return dayList.reduce(function (s, x) { return s + byDay[x][k]; }, 0); };
  var hours48 = [];
  for (var h = 47; h >= 0; h--) { var hk = monHourKey_(now - h * HOUR); hours48.push({ hour: hk, pv: hourly[hk] || 0 }); }
  return {
    generatedAt: new Date(now).toISOString(), monitor: d.version, source: d.source || 'apps-script', period: { days: d.days, since: d.since },
    live: d.live ? { n: d.live.n, windowMin: d.live.windowMin } : null,
    limits: d.limits,
    today: { day: today, pv: byDay[today] ? byDay[today].pv : 0, users: byDay[today] ? byDay[today].users : 0, urlFetch: d.ufToday, urlFetchThisHour: d.ufHour },
    totals: { pv: sum('pv'), users: Object.keys(all).length, limitHits: sum('lim'), serverErrors: sum('serr'), clientErrors: sum('cerr') },
    health: { lastFlushMinAgo: d.health.lastFlush ? Math.round((now - d.health.lastFlush.t) / 60000) : null, trigger: d.health.trigger,
      dropsToday: d.health.dropToday, sheetCells: d.health.cells, mailAlerts: d.health.alerts, alertTo: !!d.health.alertTo,
      rawRows: d.health.rawRows, dbBytes: d.health.dbBytes },
    byDay: dayList.map(function (x) { return byDay[x]; }),
    hourly48: hours48,
    failures: Object.keys(fa).map(function (k) { var p = k.split('|'); return { place: p[0], host: p[1], status: p[2], n: fa[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 30),
    dataQuality: top(qa, 15),
    errors: top(er, 20),
    perf: Object.keys(pf).map(function (k) {
      var p = pf[k];
      return { name: k.slice(2), place: k[0] === 's' ? 'server' : 'client', n: p[0], avgSec: p[0] ? Math.round(p[1] / p[0] / 100) / 10 : null,
        maxSec: Math.round(p[2] / 100) / 10, over3sPct: p[0] ? Math.round((p[5] + p[6]) / p[0] * 100) : null };
    }).sort(function (a, b) { return a.name.localeCompare(b.name) || a.place.localeCompare(b.place); }),
    sites: Object.keys(si).map(function (k) { return { host: k, server: si[k].sv, browser: si[k].cl }; }).sort(function (a, b) { return (b.server + b.browser) - (a.server + a.browser); }),
    referrers: top(rf, 10),
    geo: ge, env: top(en, 30),
    stations: top(st, 10, function (c) { return (d.stationNames[c] || '') + '(' + c + ')'; }),
    areas: top(ar, 10),
    features: top(fe, 25),
    recentAlerts: (d.alerts || []).slice(0, 10)
  };
}

/** 要約を人が読める文章に */
function monSummaryText_(s) {
  var L = [];
  var pct = function (a, b) { return b ? Math.round(a / b * 100) + '%' : '-'; };
  var cf = s.source === 'cloudflare';
  L.push('my tide-graph 利用状況の要約（monitor v' + s.monitor + '、' + (cf ? 'Cloudflare' : 'Apps Script') + '、' + s.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC 時点、直近' + s.period.days + '日）');
  L.push('');
  if (s.live) L.push('■ いま使っている人：' + s.live.n + ' 人（直近' + s.live.windowMin + '分に画面を表示中）');
  L.push('■ 今日（' + s.today.day + '）');
  L.push('表示 ' + s.today.pv + ' 回／利用者 ' + s.today.users + ' 人／' + (cf ? '外部サイトからの取得 ' + s.today.urlFetch + ' 回／この1時間 ' + s.today.urlFetchThisHour + ' 回' :
    'URL Fetch ' + s.today.urlFetch + ' 回（上限 ' + s.limits.day + ' の ' + pct(s.today.urlFetch, s.limits.day) + '）／この1時間 ' + s.today.urlFetchThisHour + ' 回'));
  L.push('■ 監視の状態');
  L.push(cf ? '最後のまとめ ' + s.health.lastFlushMinAgo + ' 分前／未まとめの記録 ' + s.health.rawRows + ' 行／D1 ' + Math.round((s.health.dbBytes || 0) / 1048576) + ' MB' :
    '最後の集計 ' + s.health.lastFlushMinAgo + ' 分前／トリガー ' + (s.health.trigger ? 'あり' : 'なし') + '／取りこぼし（今日） ' + s.health.dropsToday + ' 件／スプレッドシート ' + s.health.sheetCells + ' セル／メール通知 ' + (s.health.mailAlerts && s.health.alertTo ? 'オン' : '無効'));
  L.push('■ 期間の合計');
  L.push('表示 ' + s.totals.pv + ' 回／利用者 ' + s.totals.users + ' 人／上限超え ' + s.totals.limitHits + ' 回／エラー サーバー ' + s.totals.serverErrors + '・画面 ' + s.totals.clientErrors);
  L.push('■ 日ごと（日付 表示 利用者[新規] ' + (cf ? '外部取得' : 'URLFetch') + ' 上限超え エラー(サーバー/画面)）');
  s.byDay.forEach(function (b) { if (b.pv || b.uf) L.push(b.day + ' ' + b.pv + ' ' + b.users + '[' + b.newUsers + '] ' + b.uf + ' ' + b.lim + ' ' + b.serr + '/' + b.cerr); });
  L.push('■ データ元の失敗（場所 サイト 状態 回数）');
  s.failures.slice(0, 15).forEach(function (f) { L.push(f.place + ' ' + f.host + ' ' + f.status + ' ' + f.n); });
  L.push('■ データの異常');
  s.dataQuality.forEach(function (q) { L.push(q.key + ' ' + q.n); });
  L.push('■ エラー');
  s.errors.forEach(function (e) { L.push(e.key + ' ' + e.n); });
  L.push('■ 表示の速さ（処理 場所 回数 平均秒 最大秒 3秒以上%）');
  s.perf.forEach(function (p) { L.push(p.name + ' ' + p.place + ' ' + p.n + ' ' + p.avgSec + ' ' + p.maxSec + ' ' + p.over3sPct + '%'); });
  L.push('■ 外部サイト（サイト サーバーから ブラウザから）');
  s.sites.forEach(function (x) { L.push(x.host + ' ' + x.server + ' ' + x.browser); });
  L.push('■ 流入元'); s.referrers.forEach(function (x) { L.push(x.key + ' ' + x.n); });
  L.push('■ 位置情報'); Object.keys(s.geo).forEach(function (k) { L.push(k + ' ' + s.geo[k]); });
  L.push('■ 利用環境'); s.env.forEach(function (x) { L.push(x.key + ' ' + x.n); });
  L.push('■ よく使われる潮位観測所'); s.stations.forEach(function (x) { L.push(x.name + ' ' + x.n); });
  L.push('■ 機能'); s.features.forEach(function (x) { L.push(x.key + ' ' + x.n); });
  if (s.recentAlerts.length) { L.push('■ 最近の通知'); s.recentAlerts.forEach(function (a) { L.push(a.join(' ')); }); }
  return L.join('\n');
}
