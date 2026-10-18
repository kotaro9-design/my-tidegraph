/**
 * 利用状況のモニタリング
 *
 * - 画面はデータ取得の通信（callWithPre）に利用状況のイベントを相乗りさせて送る（通信回数は増やさない）
 * - サーバーはイベントをキャッシュにまとめ（mon_buf）、1時間ごとのトリガーでスプレッドシートに書き込む
 * - 管理画面は ?admin=合言葉 で開く（admin.html）
 *
 * 初回だけ Apps Script のエディタで setupMonitor() を実行する（スプレッドシート・合言葉・トリガーを用意し、管理画面の URL をログに出す）。
 * 個人を特定する情報は集めない（匿名ID・潮位観測所コード・約10km単位の地域・機能名・エラー名のみ）。
 */

var MON_BUF = 'mon_buf';
var MON_SHEETS = {
  hourly: ['日時', '表示回数', '利用者数', 'URL Fetch回数', '上限超え', 'サーバーエラー', '画面エラー'],
  users: ['日付', '匿名ID'],
  stations: ['日付', '潮位観測所コード', '潮位観測所名', '回数'],
  areas: ['日付', '地域（約10km）', '回数'],
  features: ['日付', '機能', '回数'],
  errors: ['日付', '種類', '内容', '回数']
};
// 機能名・エラー名などに使える文字（送られてきた値はこれで絞る）
var MON_NAME_RE = /^[A-Za-z0-9_:.\-]{1,40}$/;

function monHourKey_(ms) {
  var p = jstParts_(ms);
  return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2) + ' ' + ('0' + p.h).slice(-2);
}

/** バッファを読み書きする（ロックで同時更新を防ぐ。取れなければ諦める） */
function monUpdate_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return false;
  try {
    var cache = CacheService.getScriptCache(), k = CACHE_VER + MON_BUF, buf;
    try { buf = JSON.parse(cache.get(k) || 'null'); } catch (e) { buf = null; }
    buf = buf || { h: {} };
    fn(buf);
    try { cache.put(k, JSON.stringify(buf), 21600); } catch (e) { /* 100KB 超：この回の分は捨てる */ }
    return true;
  } finally {
    lock.releaseLock();
  }
}
function monHour_(buf, ms) {
  var hk = monHourKey_(ms);
  return buf.h[hk] || (buf.h[hk] = { pv: 0, ids: {}, st: {}, area: {}, f: {}, cerr: 0, serr: 0, lim: 0, err: {} });
}
function monInc_(o, k, n) { o[k] = (o[k] || 0) + (n || 1); }

/**
 * 画面から届いたイベントを記録する。
 * ev = { aid: 匿名ID, list: [[種類, 値], …] }
 *   種類 pv：表示（値は {st, area}）、st：潮位観測所を選んだ、f：機能を使った、e：画面のエラー
 */
function monRecord_(ev) {
  try {
    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.list) || !ev.list.length) return;
    var aid = /^[A-Za-z0-9]{6,16}$/.test(String(ev.aid || '')) ? String(ev.aid) : '';
    var list = ev.list.slice(0, 50);
    monUpdate_(function (buf) {
      var h = monHour_(buf, Date.now());
      if (aid) h.ids[aid] = 1;
      list.forEach(function (x) {
        if (!Array.isArray(x)) return;
        var kind = x[0], v = x[1];
        if (kind === 'pv') {
          h.pv++;
          if (v && /^\d{6}$/.test(String(v.st || ''))) monInc_(h.st, String(v.st));
          if (v && /^\d{2}\.\d,\d{3}\.\d$/.test(String(v.area || ''))) monInc_(h.area, String(v.area));
        } else if (kind === 'st') {
          if (/^\d{6}$/.test(String(v || ''))) monInc_(h.st, String(v));
        } else if (kind === 'f') {
          if (MON_NAME_RE.test(String(v || ''))) monInc_(h.f, String(v));
        } else if (kind === 'e') {
          h.cerr++;
          if (MON_NAME_RE.test(String(v || ''))) monInc_(h.err, 'client:' + v);
        }
      });
    });
  } catch (e) { /* 記録の失敗でアプリを止めない */ }
}

/** サーバー側の出来事（上限超え・エラー）を記録する */
function monServer_(kind, name) {
  try {
    monUpdate_(function (buf) {
      var h = monHour_(buf, Date.now());
      if (kind === 'lim') h.lim++;
      else { h.serr++; monInc_(h.err, 'server:' + String(name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 30)); }
    });
  } catch (e) { /* 無視 */ }
}

/* ------------------------------------------------------------------ */
/* スプレッドシートへの書き込み（1時間ごとのトリガー）                    */
/* ------------------------------------------------------------------ */

function monSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('MON_SHEET_ID');
  if (!id) throw new Error('setupMonitor() を実行してください');
  return SpreadsheetApp.openById(id);
}

/** 終わった時間帯の分をスプレッドシートに書き出す（今の時間帯はバッファに残す） */
function flushMonitor() {
  var now = Date.now(), cur = monHourKey_(now), done = {};
  monUpdate_(function (buf) {
    Object.keys(buf.h).forEach(function (hk) { if (hk < cur) { done[hk] = buf.h[hk]; delete buf.h[hk]; } });
  });
  var hours = Object.keys(done).sort();
  if (!hours.length) return 0;
  var ss = monSheet_(), stations = {};
  try { getStations().forEach(function (s) { stations[s.c] = s.n; }); } catch (e) { /* 名前なしで記録 */ }
  var cache = CacheService.getScriptCache();
  var rows = { hourly: [], users: [], stations: [], areas: [], features: [], errors: [] };
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
    rows.hourly.push([hk + ':00', h.pv, Object.keys(h.ids).length, uf, h.lim, h.serr, h.cerr]);
    Object.keys(h.ids).forEach(function (a) { if (!seen[day + '|' + a]) { seen[day + '|' + a] = 1; rows.users.push([day, a]); } });
    Object.keys(h.st).forEach(function (c) { rows.stations.push([day, c, stations[c] || '', h.st[c]]); });
    Object.keys(h.area).forEach(function (a) { rows.areas.push([day, a, h.area[a]]); });
    Object.keys(h.f).forEach(function (f) { rows.features.push([day, f, h.f[f]]); });
    Object.keys(h.err).forEach(function (k) { var i = k.indexOf(':'); rows.errors.push([day, k.slice(0, i), k.slice(i + 1), h.err[k]]); });
  });
  Object.keys(rows).forEach(function (name) {
    var r = rows[name];
    if (!r.length) return;
    var sh = ss.getSheetByName(name);
    sh.getRange(sh.getLastRow() + 1, 1, r.length, r[0].length).setValues(r);
  });
  return hours.length;
}

/* ------------------------------------------------------------------ */
/* 初回設定（エディタで1回だけ実行）                                     */
/* ------------------------------------------------------------------ */

function setupMonitor() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('MON_SHEET_ID'), ss;
  if (id) { ss = SpreadsheetApp.openById(id); }
  else {
    ss = SpreadsheetApp.create('my tide-graph 利用状況');
    props.setProperty('MON_SHEET_ID', ss.getId());
  }
  Object.keys(MON_SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(MON_SHEETS[name]); sh.setFrozenRows(1); }
  });
  var def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!props.getProperty('ADMIN_KEY')) props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'flushMonitor') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('flushMonitor').timeBased().everyHours(1).create();
  var url = ScriptApp.getService().getUrl();
  Logger.log('スプレッドシート：' + ss.getUrl());
  Logger.log('管理画面：' + url + '?admin=' + props.getProperty('ADMIN_KEY'));
}

/* ------------------------------------------------------------------ */
/* 管理画面                                                             */
/* ------------------------------------------------------------------ */

function monAdminOk_(key) {
  var k = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!k && String(key || '') === k;
}

/** 管理画面のデータ（直近 days 日）。未集計の分（バッファ）も合わせて返す */
function getMonitorData(key, days) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  days = Math.min(Math.max(+days || 30, 1), 365);
  var now = Date.now(), since = ymd_(now - (days - 1) * DAY);
  var ss = monSheet_();
  var read = function (name) {
    var sh = ss.getSheetByName(name), n = sh.getLastRow();
    return n > 1 ? sh.getRange(2, 1, n - 1, sh.getLastColumn()).getDisplayValues() : [];
  };
  var hourly = read('hourly').filter(function (r) { return r[0].slice(0, 10) >= since; })
    .map(function (r) { return [r[0], +r[1], +r[2], +r[3], +r[4], +r[5], +r[6]]; });
  var users = read('users').filter(function (r) { return r[0] >= since; });
  var sum = function (rows, ki, vi) {
    var o = {};
    rows.forEach(function (r) { if (r[0] >= since) o[r[ki]] = (o[r[ki]] || 0) + (+r[vi] || 0); });
    return o;
  };
  var stRows = read('stations'), stNames = {};
  try { getStations().forEach(function (s) { stNames[s.c] = s.n; }); } catch (e) { /* 記録済みの名前を使う */ }
  stRows.forEach(function (r) { if (r[2] && !stNames[r[1]]) stNames[r[1]] = r[2]; });
  var out = {
    days: days, since: since, now: now,
    hourly: hourly,
    users: users.map(function (r) { return [r[0], r[1]]; }),
    stations: sum(stRows, 1, 3), stationNames: stNames,
    areas: sum(read('areas'), 1, 2),
    features: sum(read('features'), 1, 2),
    errors: sum(read('errors').map(function (r) { return [r[0], r[1] + ':' + r[2], r[3]]; }), 1, 2),
    limits: FETCH_LIMIT,
    sheetUrl: ss.getUrl()
  };
  // 未集計の分
  var buf;
  try { buf = JSON.parse(CacheService.getScriptCache().get(CACHE_VER + MON_BUF) || 'null'); } catch (e) { buf = null; }
  out.pending = buf ? Object.keys(buf.h).map(function (hk) {
    var h = buf.h[hk];
    return { hour: hk, pv: h.pv, ids: Object.keys(h.ids), st: h.st, area: h.area, f: h.f, err: h.err, lim: h.lim, serr: h.serr, cerr: h.cerr };
  }) : [];
  var cache = CacheService.getScriptCache();
  out.ufHour = +(cache.get(CACHE_VER + 'uf_h_' + Math.floor(now / HOUR)) || 0);
  try { var j = JSON.parse(PropertiesService.getScriptProperties().getProperty('uf_day') || '{}'); out.ufToday = j.d === ymd_(now) ? +j.n || 0 : 0; } catch (e) { out.ufToday = 0; }
  return out;
}

/** 管理画面から「今すぐ集計」 */
function adminFlush(key) {
  if (!monAdminOk_(key)) throw new Error('合言葉が違います');
  return flushMonitor();
}
