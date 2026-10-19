/**
 * my tide-graph API（Cloudflare Workers「tide-api」）
 *
 * このファイルは tools/build-worker.js が組み立てたものです。直接編集しないでください。
 *   head.js（Apps Script の機能の置き換え）＋ Code.gs ＋ Monitor.gs ＋ tail.js（Workers の入口）
 *
 * Apps Script（Google）の処理をそのまま動かし、ブラウザに取得を頼んでいた部分は Workers 自身が取りに行く。
 * 必要な設定（バインディング）：
 *   CACHE … KV 名前空間（川の防災情報・海上保安庁などを全国の拠点で共有するキャッシュ）
 *   DB    … D1 データベース（利用状況の記録）
 *   ADMIN_KEY … シークレット（利用状況の要約を読むための合言葉）
 */

/* ---------- Apps Script の機能の置き換え ---------- */
// キャッシュ：この Worker の実行環境（拠点ごと）のメモリ。長く使うものは KV にも置く（tail.js）
const __MEM = new Map();
function __memGet(k) { const v = __MEM.get(k); if (!v) return null; if (v.exp < Date.now()) { __MEM.delete(k); return null; } return v.v; }
function __memPut(k, v, ttl) {
  if (__MEM.size > 4000) { let i = 0; for (const key of __MEM.keys()) { __MEM.delete(key); if (++i > 500) break; } }   // 古いものから捨てる
  __MEM.set(k, { v: String(v), exp: Date.now() + Math.max(1, ttl) * 1000 });
}
const CacheService = {
  getScriptCache() {
    return {
      get: k => __memGet(k),
      put: (k, v, ttl) => __memPut(k, v, ttl || 600),
      remove: k => { __MEM.delete(k); },
      getAll: ks => { const o = {}; ks.forEach(k => { const v = __memGet(k); if (v != null) o[k] = v; }); return o; },
      removeAll: ks => ks.forEach(k => __MEM.delete(k))
    };
  }
};
const __PROPS = new Map();
const PropertiesService = {
  getScriptProperties() {
    return { getProperty: k => (__PROPS.has(k) ? __PROPS.get(k) : null), setProperty: (k, v) => { __PROPS.set(k, String(v)); }, deleteProperty: k => { __PROPS.delete(k); } };
  }
};
const Utilities = {
  base64EncodeWebSafe: s => btoa(unescape(encodeURIComponent(String(s)))).replace(/\+/g, '-').replace(/\//g, '_'),
  getUuid: () => crypto.randomUUID(),
  Charset: { UTF_8: 'utf8' },
  computeHmacSha256Signature: () => { throw new Error('この環境では使いません'); }
};
// 外部取得はすべて「取ってきてほしい」（needUrls）として tail.js が非同期で取る。ここに来るのは取得に失敗したものだけ
const UrlFetchApp = { fetchAll: () => { throw new Error('取得に失敗しました'); } };
const LockService = { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) };
const Logger = { log: m => console.log(String(m)) };
const ContentService = null, HtmlService = null, ScriptApp = null, SpreadsheetApp = null, MailApp = null, Session = null;

/* ==================== ここから Code.gs ==================== */

/**
 * 潮汐グラフ Web アプリ（Google Apps Script）
 *
 * データ源（いずれも気象庁が公開しているもの）
 *  - 観測地点一覧 / 実測潮位（15秒値・潮位偏差付き）/ 天文潮位（毎時）:
 *      気象庁「潮位観測情報」 https://www.jma.go.jp/bosai/map.html#contents=tidelevel
 *      （気象庁・国土交通省港湾局・海上保安庁・国土地理院 等の検潮所を含む）
 *  - 満潮・干潮の時刻と潮位: 気象庁「潮位表」
 *      https://www.data.jma.go.jp/kaiyou/db/tide/suisan/
 *
 * 高さはすべて TP（東京湾平均海面）基準の cm でクライアントへ返す。
 * 潮位表基準面で表示するためのオフセット（潮位表 − TP）も併せて返す。
 */

var BOSAI = 'https://www.jma.go.jp/bosai/tidelevel/';
var SUISAN_PAGE = 'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/';
var SUISAN_TXT = 'https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/';
var JST = 9 * 3600 * 1000;
var HOUR = 3600 * 1000;
var DAY = 24 * HOUR;
var CACHE_VER = 'v4_';
var JCG = 'https://www1.kaiho.mlit.go.jp/TIDE/gauge/';
var RIVER = 'https://www.river.go.jp/kawabou/file/';
var RIVER_TIME_TTL = 600;   // 最新の観測時刻の確認は10分ごと（データが10分ごと。川の防災情報への負担を減らす）
var OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
var AMEDAS = 'https://www.jma.go.jp/bosai/amedas/';
var FORECAST = 'https://www.jma.go.jp/bosai/forecast/';
var GSI_REVGEO = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

var APP_NAME = 'my tide-graph';
// アイコン画像（icon-192.png）の Google ドライブのファイル ID。
// ファイルを「リンクを知っている全員が閲覧可」で共有してから設定する。空ならブラウザ既定のアイコン。
var ICON_FILE_ID = '';

function doGet(e) {
  // 管理画面（利用状況）：?admin=合言葉
  if (e && e.parameter && e.parameter.admin) {
    if (!monAdminOk_(e.parameter.admin)) return HtmlService.createHtmlOutput('ページが見つかりません').setTitle(APP_NAME);
    // 要約をデータ（json）・文章（text）で返す。スクリーンショットなしで状況を読めるように
    var fmt = e.parameter.format, dd = Math.min(Math.max(+e.parameter.days || 7, 1), 90);
    if (fmt === 'json') return ContentService.createTextOutput(JSON.stringify(getMonitorSummary(e.parameter.admin, dd))).setMimeType(ContentService.MimeType.JSON);
    if (fmt === 'text') return ContentService.createTextOutput(getMonitorSummaryText(e.parameter.admin, dd)).setMimeType(ContentService.MimeType.TEXT);
    var a = HtmlService.createTemplateFromFile('admin');
    a.adminKey = e.parameter.admin;
    return a.evaluate().setTitle(APP_NAME + ' 利用状況')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var t = HtmlService.createTemplateFromFile('index');
  t.initialSt = (e && e.parameter && e.parameter.st) || '';
  // 釣果の予定に付けるアプリへのリンク用
  try { t.appUrl = ScriptApp.getService().getUrl() || ''; } catch (err) { t.appUrl = ''; }
  var out = t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  // ホーム画面に追加したときの名前
  try { out.addMetaTag('apple-mobile-web-app-title', APP_NAME); } catch (err) { /* 未対応なら無視 */ }
  try { out.addMetaTag('mobile-web-app-capable', 'yes'); } catch (err) { /* 同上 */ }
  if (ICON_FILE_ID) {
    // 末尾の &.png は拡張子チェックを通すためのもの
    try { out.setFaviconUrl('https://drive.google.com/uc?id=' + ICON_FILE_ID + '&export=view&.png'); } catch (err) { /* 無視 */ }
  }
  return out;
}

/**
 * GitHub Pages など外部に置いた画面からの呼び出し口。
 * 本文（text/plain）は { fn: 'callWithPre', args: [関数名, 引数, pre] } の JSON。
 * text/plain の POST はプリフライト不要で、応答は Apps Script が CORS を許可して返す。
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var a = req.args || [];
    if (req.fn === 'track') { monRecord_(a[0]); monCommit_(); out = { result: true }; }   // 閉じるときの利用状況
    else if (req.fn === 'callWithPre') out = { result: callWithPre(a[0], a[1], a[2], a[3]) };
    else if (req.fn === 'callBatch') out = { result: callBatch(a[0], a[1], a[2]) };
    else throw new Error('不正な呼び出しです');
  } catch (err) {
    out = { error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* 公開関数（google.script.run から呼ぶ）                              */
/* ------------------------------------------------------------------ */

/** 観測地点一覧（潮位表地点との対応付き） */
function getStations() {
  return cached_('stations', 12 * 3600, function () {
    var area = JSON.parse(fetchAll_([BOSAI + 'const/tide_area.json'])[0]);
    var year = jstParts_(Date.now()).y;
    var suisan = parseSuisanStations_(fetchAll_([SUISAN_PAGE + 'station' + year + '.php'])[0] || '');
    var seen = {};
    var list = [];
    Object.keys(area).forEach(function (c20) {
      (area[c20].class30s || []).forEach(function (c30) {
        (c30.stations || []).forEach(function (s) {
          if (seen[s.code]) return;
          seen[s.code] = true;
          list.push({
            c: s.code,
            n: s.name,
            o: s.typeName ? String(s.typeName).replace(/（.*$/, '') : '',
            a: s.addr || '',
            lat: s.lat,
            lon: s.lon,
            sc: matchSuisan_(s, suisan),
            miss: !!s.missing,
            p20: (s.parents && s.parents.class20) || c20
          });
        });
      });
    });
    // 海上保安庁 リアルタイム験潮データの地点（同名のもの）と、無い地点には30km以内の最寄りの速報地点
    var jcg = {};
    try {
      var idx = fetchAll_([JCG + 'index.php'], true)[0] || '', m, re = /gauge\.php\?s=(\d{4})['"][^>]*>([^<]+)</g;
      while ((m = re.exec(idx))) jcg[m[2].trim()] = m[1];
    } catch (e) { rethrowNeed_(e); /* 取れなければ速報なし */ }
    list.forEach(function (s) { s.jcg = jcg[s.n] || ''; });
    list.forEach(function (s) {
      if (s.jcg) return;
      var best = '', bd = 30;
      list.forEach(function (o) {
        if (!o.jcg) return;
        var d = distKm_(s.lat, s.lon, o.lat, o.lon);
        if (d < bd) { bd = d; best = o.c; }
      });
      s.jn = best;
    });
    return list;
  });
}

/**
 * 指定地点の潮汐データ。
 * @param {string} code 観測地点コード（6桁）
 * @param {string=} dateStr 'YYYY-MM-DD'（JST）。省略時は今日
 */
/**
 * 推算（満潮・干潮）に使える地点：気象庁の潮位表の掲載地点（約240）。
 * obs は同じ地点の潮位観測所のコード（毎時の推算〔TP〕があり、潮位表の基準面と TP の関係がわかる）。無ければ ''（潮位表だけの地点）
 */
function getPredPoints() {
  return cached_('pred_points', 6 * 3600, function () {
    var year = jstParts_(Date.now()).y;
    var pts = parseSuisanStations_(fetchAll_([SUISAN_PAGE + 'station' + year + '.php'])[0] || '');
    var bySc = {};
    getStations().forEach(function (st) { if (st.sc && !bySc[st.sc]) bySc[st.sc] = st.c; });
    return pts.map(function (p) { return { c: p.code, n: p.name, lat: p.lat, lon: p.lon, obs: bySc[p.code] || '' }; });
  });
}

/** 推算の地点の潮位表（毎時の値と満干潮。潮位表の基準面、cm）。同じ地点に潮位観測所があれば基準面と TP の差（offset）も */
function predData_(sc, days, years) {
  var pt = getPredPoints().filter(function (p) { return p.c === sc; })[0];
  if (!pt) throw new Error('推算の地点が見つかりません: ' + sc);
  prefetch_(years.map(function (y) { return ['suisan_' + y + '_' + sc, SUISAN_TXT + y + '/' + sc + '.txt', 24 * 3600]; })
    .concat(pt.obs ? years.map(function (y) { return ['astro_' + y + '_' + pt.obs, BOSAI + 'const/tide_astro/tide_astro_' + y + '_' + pt.obs + '.json', 24 * 3600]; }) : []));
  var rows = {};
  years.forEach(function (y) {
    var txt = cachedText_('suisan_' + y + '_' + sc, 24 * 3600, SUISAN_TXT + y + '/' + sc + '.txt');
    if (txt) parseSuisanTxt_(txt, rows);
  });
  var v = [], ext = [];
  days.forEach(function (d) {
    var r = rows[ymd_(d)];
    for (var h = 0; h < 24; h++) v.push(r ? r.hr[h] : null);
    if (!r) return;
    r.hi.forEach(function (e) { ext.push({ t: d + e[0], h: e[1], k: 'H' }); });
    r.lo.forEach(function (e) { ext.push({ t: d + e[0], h: e[1], k: 'L' }); });
  });
  ext.sort(function (a, b) { return a.t - b.t; });
  var offset = null;
  if (pt.obs) { try { offset = datumOffset_(days, rows, loadAstro_(pt.obs, days)); } catch (e) { rethrowNeed_(e); } }
  return { c: sc, n: pt.n, lat: pt.lat, lon: pt.lon, obs: pt.obs, offset: offset, hr: { start: days[0], step: HOUR, v: v }, ext: ext };
}

function getTideData(code, dateStr, predSc) {
  if (!/^\d{6}$/.test(code)) throw new Error('潮位観測所のコードが不正です');
  if (predSc != null && predSc !== '' && !/^[A-Z0-9]{2}$/.test(String(predSc))) throw new Error('推算の地点の指定が不正です');
  var station = getStations().filter(function (s) { return s.c === code; })[0];
  if (!station) throw new Error('潮位観測所が見つかりません: ' + code);

  var now = Date.now();
  var base = checkDate_(dateStr, now);
  var start = base - DAY;            // 前日 0:00
  var days = [start, base, base + DAY, base + 2 * DAY]; // 補間用に翌々日まで

  // --- 天文潮位（毎時, TP）
  var years = uniq_(days.map(function (d) { return jstParts_(d).y; }));
  // 必要なファイルをまとめて用意する（ブラウザに取ってきてもらうときの往復を減らす）
  var pre = years.map(function (y) { return ['astro_' + y + '_' + code, BOSAI + 'const/tide_astro/tide_astro_' + y + '_' + code + '.json', 24 * 3600]; });
  if (station.sc) years.forEach(function (y) { pre.push(['suisan_' + y + '_' + station.sc, SUISAN_TXT + y + '/' + station.sc + '.txt', 24 * 3600]); });
  for (var pd = start; pd < Math.min(now, base + 2 * DAY) && pd <= now; pd += DAY) {
    pre.push(['obs_' + ymd_(pd) + '_' + code, BOSAI + 'data/tide/tide_obs_' + ymd_(pd).replace(/-/g, '') + '_' + code + '.json', pd + DAY + HOUR < now ? 6 * 3600 : 60]);
  }
  prefetch_(pre);
  var astro = loadAstro_(code, days);

  // --- 潮位表（満干潮）
  var ext = null, offset = null;
  if (station.sc) {
    var rows = {};
    years.forEach(function (y) {
      var txt = cachedText_('suisan_' + y + '_' + station.sc, 24 * 3600,
        SUISAN_TXT + y + '/' + station.sc + '.txt');
      if (txt) parseSuisanTxt_(txt, rows);
    });
    offset = datumOffset_(days, rows, astro);
    if (offset != null) {
      ext = [];
      days.forEach(function (d) {
        var r = rows[ymd_(d)];
        if (!r) return;
        r.hi.forEach(function (e) { ext.push({ t: d + e[0], h: e[1] - offset, k: 'H' }); });
        r.lo.forEach(function (e) { ext.push({ t: d + e[0], h: e[1] - offset, k: 'L' }); });
      });
      ext.sort(function (a, b) { return a.t - b.t; });
    }
  }

  // --- 実測潮位（15秒値 → 1分平均）
  var obs = loadObs_(code, start, Math.min(now, base + 2 * DAY), now);

  // --- 速報（海上保安庁 リアルタイム験潮データ。気象庁の公開より約20分早い）
  var rt = null, near = null;
  if (now >= start && now < base + 2 * DAY) {
    try {
      if (station.jcg) rt = jcgRealtime_(station.jcg, obs);
      else if (station.jn) near = nearRealtime_(station, now);
    } catch (e) { rethrowNeed_(e); /* 速報が取れなくても気象庁のデータは返す */ }
    // この地点の観測が止まっている（配信停止・欠測）ときは、近くの更新されている地点の偏差を使う
    var lastT = obs.tide.length ? obs.start + (obs.tide.length - 1) * obs.step : 0;
    if (rt && rt.pts.length) lastT = Math.max(lastT, rt.pts[rt.pts.length - 1][0]);
    if (near) lastT = Math.max(lastT, near.t);
    if (now - lastT > 40 * 60000) {
      try { near = freshNeighbor_(station, now) || near; } catch (e) { rethrowNeed_(e); }
    }
  }

  // 推算の地点が潮位観測所と別のとき：その地点の潮位表
  var pred = predSc && predSc !== station.sc ? predData_(String(predSc), days, years) : null;

  return {
    station: station,
    base: base,
    now: now,
    pred: pred,
    astro: { start: start, step: HOUR, v: astro },
    ext: ext,
    offset: offset,
    obs: obs,
    rt: rt,
    near: near
  };
}

/**
 * 近くの河川水位観測所（国土交通省「川の防災情報」）の水位。
 * 指定位置（現在地）から一番近い、データのある観測所を返す。値は TP 基準の cm。
 * @param {number} lat
 * @param {number} lon
 */
function getRiver(lat, lon, fcd) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var near = riverNearby_(lat, lon);
  var st = null;
  if (fcd) {
    // 選択された観測所
    if (!/^\d{13}$/.test(fcd)) throw new Error('河川の水位観測所の指定が不正です');
    st = near.stations.filter(function (s) { return s.fcd === fcd; })[0];
    if (!st) {
      var info0 = riverMaster_(fcd);
      if (!info0 || info0.lat == null) return null;
      st = { fcd: fcd, name: info0.obsNm, ofc: info0.ofcCd, obs: info0.obsCd, lat: info0.lat, lon: info0.lon, d: distKm_(lat, lon, info0.lat, info0.lon) };
    }
    var txt = riverSeries_(fcd, near.path);
    st.ts = txt ? JSON.parse(txt) : null;
    if (!st.ts) return null;
    st.noData = riverVals_(st.ts).length === 0;   // 選んだ観測所が欠測中
  } else {
    // 指定位置から一番近い、データのある（TP 換算値のある）観測所
    var cand = near.stations.slice(0, 10);
    if (!cand.length) return null;
    // 自動では、最新値が欠測中の観測所は選ばない
    var usable = function (s) {
      if (s.ts === undefined) { s.ts = null; try { s.ts = JSON.parse(riverSeries_(s.fcd, near.path) || 'null'); } catch (e) { /* 無視 */ } }
      return riverVals_(s.ts).length >= 6 && riverLatestOk_(s.ts);
    };
    // 前回この付近（約1km）で選んだ観測所がまだ使えれば、それだけ調べれば済む
    var cache = CacheService.getScriptCache(), autoKey = CACHE_VER + 'rv_auto_' + lat.toFixed(2) + '_' + lon.toFixed(2);
    var last = cache.get(autoKey);
    st = last ? cand.filter(function (s) { return s.fcd === last; })[0] : null;
    if (st && !usable(st)) st = null;
    if (!st) {
      // 近い順に3か所ずつ調べ、使える観測所が見つかったらそこで止める（URL Fetch の節約）
      for (var bi = 0; bi < cand.length && !st; bi += 3) {
        var batch = cand.slice(bi, bi + 3);
        prefetch_(batch.filter(function (s) { return s.ts === undefined; }).map(function (s) { return riverSeriesItem_(s.fcd, near.path); }));
        st = batch.filter(usable)[0];
      }
      if (!st) return null;
      cache.put(autoKey, st.fcd, 3600);
    }
  }
  var v = riverVals_(st.ts);
  // 潮位と同じ目盛りに重ねられるのは海面に近い高さのときだけ
  var tidal = v.length > 0 && v[0] > -4 && v[0] < 4;
  var noData = v.length === 0;
  var info = riverMaster_(st.fcd) || {};
  var conv = function (arr) {
    // stgCcd が 0 以外は欠測・異常値（0 が入っていることがある）。時刻は 24:00 表記もある
    return (arr || []).filter(function (x) { return x.stgHght != null && !x.stgCcd; }).map(function (x) {
      return [obsTimeMs_(x.obsTime), Math.round(x.stgHght * 1000) / 10];
    }).sort(function (p, q) { return p[0] - q[0]; });
  };
  return {
    fcd: st.fcd,
    name: st.name,
    river: info.rvrNm || '',
    dist: Math.round(st.d * 10) / 10,
    tidal: tidal,
    noData: noData,
    url: 'https://www.river.go.jp/kawabou/pc/tm?itmkndCd=4&ofcCd=' + st.ofc + '&obsCd=' + st.obs + '&isCurrent=true&fld=0',
    min10: conv(st.ts.min10Values),
    hour: conv(st.ts.hrValues)
  };
}

/** 選択用：指定位置の近く（40km 以内）の水位観測所のうち、TP 換算値のあるもの（近い順、最大20）。
 *  取得回数を抑えるため現在水位は載せず、位置（約1km）ごとに6時間キャッシュする */
function getRiverStations(lat, lon) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  // 約5km単位（0.05°）に丸めた位置で一覧を作って共有する
  var glat = Math.round(lat * 20) / 20, glon = Math.round(lon * 20) / 20;
  var list = cached_('rv_list3_' + glat.toFixed(2) + '_' + glon.toFixed(2), 6 * 3600, function () {
  var near = riverNearby_(glat, glon), cand = near.stations.slice(0, 30);
  prefetch_(cand.map(function (s) { return ['rv_m_' + s.fcd, RIVER + 'files/master/obs/stg/' + s.fcd + '.json', 6 * 3600]; }));
  var tops = fetchAll_(cand.map(function (s) { return RIVER + 'files/obslist/top/stg/' + s.fcd + '.json'; }), true);
  var out = [];
  cand.forEach(function (s, i) {
    var v = null;
    try { v = tops[i] && JSON.parse(tops[i]).obsValue; } catch (e) { /* 無視 */ }
    if (!v || v.stgHght == null || out.length >= 20) return;
    var info = riverMaster_(s.fcd) || {};
    out.push({ fcd: s.fcd, name: s.name, river: info.rvrNm || '', lat: s.lat, lon: s.lon });
  });
  return out;
  });
  return list.map(function (x) { return { fcd: x.fcd, name: x.name, river: x.river, dist: Math.round(distKm_(lat, lon, x.lat, x.lon) * 10) / 10 }; })
    .sort(function (a, b) { return a.dist - b.dist; });
}

/** 指定位置の近くの水位観測所（近い順、重複なし） */
function riverNearby_(lat, lon) {
  var towns = cached_('rv_towns', 24 * 3600, function () {
    var a = JSON.parse(fetchAll_([RIVER + 'files/map/twn/twnarea.json'])[0]).towns || [];
    return a.filter(function (t) { return t.stgExistFlg; })
      .map(function (t) { return [t.twnCd, Math.round(t.lat * 1e4) / 1e4, Math.round(t.lon * 1e4) / 1e4]; });
  });
  var tm = JSON.parse(cachedText_('rv_time', RIVER_TIME_TTL, RIVER + 'system/tmCrntTime.json')).crntObsTime; // "YYYY/MM/DD HH:mm"
  var path = tm.substr(0, 10).replace(/\//g, '') + '/' + tm.substr(11, 5).replace(':', '');
  // 近い市区町村（重心）から観測所を集める
  var nearTowns = towns.map(function (t) { return [t[0], distKm_(lat, lon, t[1], t[2])]; })
    .filter(function (t) { return t[1] < 40; })
    .sort(function (a, b) { return a[1] - b[1]; }).slice(0, 5);
  var stations = [], seen = {};
  prefetch_(nearTowns.map(function (t) { return ['rv_twn_' + t[0], RIVER + 'gjson/obs/' + path + '/stg/' + t[0] + '.json', 6 * 3600]; }));
  nearTowns.forEach(function (t) {
    var txt = cachedText_('rv_twn_' + t[0], 6 * 3600, RIVER + 'gjson/obs/' + path + '/stg/' + t[0] + '.json', true);
    if (!txt) return;
    try {
      (JSON.parse(txt).features || []).forEach(function (f) {
        var p = f.properties;
        if (seen[p.obs_fcd]) return;
        seen[p.obs_fcd] = true;
        stations.push({ fcd: p.obs_fcd, name: p.obs_nm, ofc: p.ofc_cd, obs: p.obs_cd, lat: p.lat, lon: p.lon, d: distKm_(lat, lon, p.lat, p.lon) });
      });
    } catch (e) { /* 壊れたファイルは無視 */ }
  });
  stations.sort(function (a, b) { return a.d - b.d; });
  return { path: path, stations: stations };
}

function riverMaster_(fcd) {
  var m = cachedText_('rv_m_' + fcd, 6 * 3600, RIVER + 'files/master/obs/stg/' + fcd + '.json', true);
  try { return m ? JSON.parse(m).obsInfo || null : null; } catch (e) { return null; }
}

/** 観測所の推移（10分値・毎時値）。データの更新時刻ごとにキャッシュ */
function riverSeriesItem_(fcd, path) {
  return ['rv_ts_' + fcd + '_' + path.replace('/', ''), RIVER + 'files/tmlist/stg/' + path + '/' + fcd + '.json', 900];
}
function riverSeries_(fcd, path) {
  var it = riverSeriesItem_(fcd, path);
  return cachedText_(it[0], it[2], it[1], true);
}

/** 最新の10分値（値の入っている最初のもの）が正常か */
function riverLatestOk_(ts) {
  var a = ts ? ts.min10Values || [] : [];
  for (var i = 0; i < a.length; i++) {
    if (a[i].stg == null && a[i].stgHght == null) continue;   // まだ値の入っていない時刻
    return !a[i].stgCcd && a[i].stgHght != null;
  }
  return false;
}

/** 10分値のうち有効な TP 水位（m、新しい順） */
function riverVals_(ts) {
  return ts ? (ts.min10Values || []).filter(function (x) { return !x.stgCcd && x.stgHght != null; }).map(function (x) { return x.stgHght; }) : [];
}

/**
 * 近くの水質観測所（国土交通省「川の防災情報」）の水温・塩分濃度。
 * 指定位置から 10km 以内に観測所があるときだけ返す。上層・下層など水深別の観測は層ごとに返す。
 */
function getWaterQuality(lat, lon) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var LIMIT_KM = 10;
  // 近くに水質観測所が無いとわかった地点（約5km単位）は、しばらく探しに行かない
  var cache = CacheService.getScriptCache(), noneKey = CACHE_VER + 'wq_none_' + (Math.round(lat * 20) / 20).toFixed(2) + '_' + (Math.round(lon * 20) / 20).toFixed(2);
  if (cache.get(noneKey)) return null;
  var none = function () { cache.put(noneKey, '1', 21600); return null; };
  var towns = cached_('wq_towns', 24 * 3600, function () {
    var a = JSON.parse(fetchAll_([RIVER + 'files/map/twn/twnarea.json'])[0]).towns || [];
    return a.filter(function (t) { return t.qwtrExistFlg; })
      .map(function (t) { return [t.twnCd, Math.round(t.lat * 1e4) / 1e4, Math.round(t.lon * 1e4) / 1e4]; });
  });
  var near = towns.map(function (t) { return [t[0], distKm_(lat, lon, t[1], t[2])]; })
    .filter(function (t) { return t[1] < 20; }).sort(function (a, b) { return a[1] - b[1]; }).slice(0, 4);
  if (!near.length) return none();

  // 観測所の一覧と位置（位置が未登録のものは住所から求める）
  prefetch_(near.map(function (t) { return ['wq_twn_' + t[0], RIVER + 'files/obslist/obs/twnlist/' + t[0] + '.json', 6 * 3600]; }));
  var stations = [];
  // 観測所の情報もまとめて用意する（1件ずつだと、ブラウザ経由のときに往復が増える）
  var masters = [];
  near.forEach(function (t) {
    var txt = cachedText_('wq_twn_' + t[0], 6 * 3600, RIVER + 'files/obslist/obs/twnlist/' + t[0] + '.json', true);
    try { ((txt && JSON.parse(txt).obsList || {}).obsQwtr || []).forEach(function (q) { masters.push(['wq_m_' + q.obsFcd, RIVER + 'files/master/obs/qwtr/' + q.obsFcd + '.json', 6 * 3600]); }); } catch (e) { /* 無視 */ }
  });
  if (masters.length) prefetch_(masters);
  near.forEach(function (t) {
    var txt = cachedText_('wq_twn_' + t[0], 6 * 3600, RIVER + 'files/obslist/obs/twnlist/' + t[0] + '.json', true);
    if (!txt) return;
    ((JSON.parse(txt).obsList || {}).obsQwtr || []).forEach(function (q) {
      var mt = cachedText_('wq_m_' + q.obsFcd, 6 * 3600, RIVER + 'files/master/obs/qwtr/' + q.obsFcd + '.json', true);
      var info = mt ? JSON.parse(mt).obsInfo || {} : {};
      var la = info.lat, lo = info.lon;
      if ((la == null || lo == null) && info.obsAdr) {
        var g = geocode_(info.obsAdr);
        if (g) { la = g[0]; lo = g[1]; }
      }
      if (la == null || lo == null) return;
      stations.push({ fcd: q.obsFcd, name: q.obsNm, ofc: q.ofcCd, obs: q.obsCd, river: info.rvrNm || '', place: info.obsSadr || '',
        lat: la, lon: lo, d: distKm_(lat, lon, la, lo) });
    });
  });
  stations.sort(function (a, b) { return a.d - b.d; });
  if (!stations.length || stations[0].d > LIMIT_KM) return none();

  // 同じ地点の水深別（平均・上層・中層・下層など）をまとめる
  var LAYER = /(平均|表層|上層|中層|下層|底層)$/;
  var site = stations[0], siteName = site.name.replace(LAYER, '');
  var group = stations.filter(function (s) { return s.name.replace(LAYER, '') === siteName && s.d - site.d < 0.5; });
  var tm = JSON.parse(cachedText_('rv_time', RIVER_TIME_TTL, RIVER + 'system/tmCrntTime.json')).crntObsTime;
  var path = tm.substr(0, 10).replace(/\//g, '') + '/' + tm.substr(11, 5).replace(':', '');
  var wqItems = group.map(function (s) { return ['wq_ts1h_' + s.fcd, RIVER + 'files/tmlist/qwtr/' + path + '/' + s.fcd + '.json', 3600]; });
  prefetch_(wqItems);
  var res = wqItems.map(function (it) { return cachedText_(it[0], it[2], it[1], true); });
  var order = ['表層', '上層', '中層', '下層', '底層', '平均', ''];
  var layers = group.map(function (s, i) {
    var hv = [];
    try { hv = (res[i] && JSON.parse(res[i]).hrValues) || []; } catch (e) { /* 無視 */ }
    // 品質コードが 0 の値だけ使う（160 などは欠測）。新しい順
    var pick = function (k) {
      for (var j = 0; j < hv.length; j++) if (hv[j][k] != null && !hv[j][k + 'Ccd']) return { v: hv[j][k], t: obsTimeMs_(hv[j].obsTime) };
      return null;
    };
    var m = LAYER.exec(s.name);
    return { layer: m ? m[1] : '', temp: pick('wtrtmp'), salt: pick('slt') };
  }).filter(function (l) { return l.temp || l.salt; })
    .sort(function (a, b) { return order.indexOf(a.layer) - order.indexOf(b.layer); });
  return {
    name: siteName, river: site.river, place: site.place, dist: Math.round(site.d * 10) / 10,
    url: 'https://www.river.go.jp/kawabou/pc/tm?itmkndCd=6&ofcCd=' + site.ofc + '&obsCd=' + site.obs + '&isCurrent=true&fld=0',
    layers: layers
  };
}

/** 住所 → [緯度, 経度]（国土地理院 住所検索） */
function geocode_(adr) {
  var txt = cachedText_('geo_' + Utilities.base64EncodeWebSafe(adr).substr(0, 200), 6 * 3600,
    'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(adr), true);
  try {
    var a = JSON.parse(txt || '[]');
    return a.length ? [a[0].geometry.coordinates[1], a[0].geometry.coordinates[0]] : null;
  } catch (e) { return null; }
}

/** "YYYY/MM/DD HH:mm"（JST）→ ms */
function obsTimeMs_(q) {
  return Date.UTC(+q.substr(0, 4), +q.substr(5, 2) - 1, +q.substr(8, 2), +q.substr(11, 2), +q.substr(14, 2)) - JST;
}

/** 毎時の天文潮位（TP）を days の各日 0〜23 時について並べる */
function loadAstro_(code, days) {
  var astroYear = {};
  uniq_(days.map(function (d) { return jstParts_(d).y; })).forEach(function (y) {
    var txt = cachedText_('astro_' + y + '_' + code, 24 * 3600,
      BOSAI + 'const/tide_astro/tide_astro_' + y + '_' + code + '.json');
    astroYear[y] = txt ? JSON.parse(txt).tide : null;
  });
  var astro = [];
  days.forEach(function (d) {
    var p = jstParts_(d);
    var arr = astroYear[p.y] && astroYear[p.y][pad2_(p.m) + pad2_(p.d)];
    for (var h = 0; h < 24; h++) astro.push(arr && arr[h] != null ? arr[h] : null);
  });
  return astro;
}

/** 気象庁の実測潮位（15秒値）を start〜end の1分平均にする。末尾の欠損は切り詰める */
function loadObs_(code, start, end, now) {
  var obs = { start: start, step: 60000, tide: [], dep: [] };
  var n = Math.max(0, Math.round((end - start) / 60000));
  for (var i = 0; i < n; i++) { obs.tide.push(null); obs.dep.push(null); }
  for (var d = start; d < end && d <= now; d += DAY) {
    var isPast = d + DAY + HOUR < now;
    var url = BOSAI + 'data/tide/tide_obs_' + ymd_(d).replace(/-/g, '') + '_' + code + '.json';
    var txt = cachedText_('obs_' + ymd_(d) + '_' + code, isPast ? 6 * 3600 : 60, url, true);
    if (!txt) continue;
    var o = JSON.parse(txt);
    var t0 = Date.parse(o.time);
    var iv = (o.interval || 15) * 1000;
    var sum = {};
    (o.tide || []).forEach(function (v, k) {
      if (v == null) return;
      var m = Math.floor((t0 + k * iv - start) / 60000);
      if (m < 0 || m >= n) return;
      var s = sum[m] || (sum[m] = [0, 0, 0, 0]);
      s[0] += v; s[1]++;
      var dv = o.departure && o.departure[k];
      if (dv != null) { s[2] += dv; s[3]++; }
    });
    Object.keys(sum).forEach(function (m) {
      var s = sum[m];
      obs.tide[m] = Math.round(s[0] / s[1] * 10) / 10;
      obs.dep[m] = s[3] ? Math.round(s[2] / s[3] * 10) / 10 : null;
    });
  }
  var last = obs.tide.length - 1;
  while (last >= 0 && obs.tide[last] == null) last--;
  obs.tide.length = last + 1;
  obs.dep.length = last + 1;
  return obs;
}

/**
 * 海上保安庁 リアルタイム験潮データ（5分毎、公開の遅れ数分）のうち、気象庁の最新値より新しいものを TP に換算して返す。
 * 基準面の差は、両者が重なる時間帯の差の中央値から求める（ばらつきが大きければ別物とみなし使わない）。
 */
function jcgRealtime_(jcg, obs) {
  var html = cachedText_('jcg_' + jcg, 180, JCG + 'gauge.php?s=' + jcg, true);
  var pts = html ? parseJcg_(html) : [];
  if (!pts.length) return null;
  var diffs = [];
  pts.forEach(function (p) {
    var v = obs.tide[Math.round((p[0] - obs.start) / obs.step)];
    if (v != null) diffs.push(p[1] - v);
  });
  var cache = CacheService.getScriptCache(), key = CACHE_VER + 'jcgoff_' + jcg, off;
  if (diffs.length >= 6) {
    diffs.sort(function (a, b) { return a - b; });
    off = diffs[diffs.length >> 1];
    var spread = diffs[Math.floor(diffs.length * 0.9)] - diffs[Math.floor(diffs.length * 0.1)];
    if (spread > 4) return null;
    cache.put(key, String(off), 21600);
  } else {
    // 日付が変わった直後など重なりが無いときは前回の差を使う
    var c = cache.get(key);
    if (c == null) return null;
    off = +c;
  }
  var lastJma = obs.tide.length ? obs.start + (obs.tide.length - 1) * obs.step : -Infinity;
  return {
    off: off,
    pts: pts.filter(function (p) { return p[0] > lastJma; })
      .map(function (p) { return [p[0], Math.round((p[1] - off) * 10) / 10]; })
  };
}

/** gauge.php の「5分毎瞬間値」テキスト → [[時刻ms, cm]] */
function parseJcg_(html) {
  var re = /(\d{4}) (\d{2}) (\d{2}) (\d{2}) (\d{2}) +(-?\d+)/g, m, out = [];
  while ((m = re.exec(html))) {
    if (m[6] === '9999') continue;
    out.push([Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - JST, +m[6]]);
  }
  out.sort(function (a, b) { return a[0] - b[0]; });
  return out;
}

/**
 * 海上保安庁の速報が無い地点（港湾局の検潮所など）向けに、
 * 近くの速報のある地点の最新の潮位偏差を返す。
 */
function nearRealtime_(station, now) {
  var ns = getStations().filter(function (s) { return s.c === station.jn; })[0];
  if (!ns || !ns.jcg) return null;
  var day0 = jstMidnight_(ymd_(now)) - DAY;
  var r = jcgRealtime_(ns.jcg, loadObs_(ns.c, day0, now, now));
  if (!r || !r.pts.length) return null;
  var p = r.pts[r.pts.length - 1];
  var astro = loadAstro_(ns.c, [day0, day0 + DAY, day0 + 2 * DAY]);
  var a = catmullRom_(astro, (p[0] - day0) / HOUR);
  if (a == null) return null;
  return {
    src: ns.n,
    dist: Math.round(distKm_(station.lat, station.lon, ns.lat, ns.lon) * 10) / 10,
    t: p[0],
    dep: Math.round((p[1] - a) * 10) / 10
  };
}

/**
 * 40km 以内で、気象庁の実測が30分以内に更新されている最寄りの地点の最新の潮位偏差（直近10分平均）。
 * 観測が止まった地点の「現在の推定」と偏差補正予測に使う。
 */
function freshNeighbor_(station, now) {
  var day0 = jstMidnight_(ymd_(now)) - DAY;
  var cand = getStations().filter(function (s) { return s.c !== station.c && !s.miss; })
    .map(function (s) { return { s: s, d: distKm_(station.lat, station.lon, s.lat, s.lon) }; })
    .filter(function (x) { return x.d < 40; })
    .sort(function (a, b) { return a.d - b.d; }).slice(0, 4);
  for (var i = 0; i < cand.length; i++) {
    var o = loadObs_(cand[i].s.c, day0, now, now), n = o.tide.length;
    if (!n) continue;
    var t = o.start + (n - 1) * o.step;
    if (now - t > 30 * 60000) continue;
    var sum = 0, k = 0;
    for (var j = n - 1; j >= Math.max(0, n - 10); j--) if (o.dep[j] != null) { sum += o.dep[j]; k++; }
    if (!k) continue;
    return { src: cand[i].s.n, dist: Math.round(cand[i].d * 10) / 10, t: t, dep: Math.round(sum / k * 10) / 10, fallback: true };
  }
  return null;
}

/** 等間隔の値列を x（添字の実数）で Catmull-Rom 補間 */
function catmullRom_(v, x) {
  var i = Math.floor(x), t = x - i;
  var p = [v[i - 1], v[i], v[i + 1], v[i + 2]];
  if (p[1] == null || p[2] == null) return null;
  if (p[0] == null) p[0] = 2 * p[1] - p[2];
  if (p[3] == null) p[3] = 2 * p[2] - p[1];
  return 0.5 * ((2 * p[1]) + (-p[0] + p[2]) * t + (2 * p[0] - 5 * p[1] + 4 * p[2] - p[3]) * t * t +
    (-p[0] + 3 * p[1] - 3 * p[2] + p[3]) * t * t * t);
}

/**
 * 指定位置の天気（気象庁 天気予報）と風（最寄りアメダスの実況）。
 * @param {number} lat
 * @param {number} lon
 * @param {string=} c20 位置から予報区を引けない場合（海上など）に使う市区町村コード（7桁）
 */
function getWeather(lat, lon, c20) {
  lat = +lat; lon = +lon;
  if (c20 != null && c20 !== '' && !/^\d{7}$/.test(String(c20))) throw new Error('地域コードが不正です');
  checkPos_(lat, lon);
  var out = { amedas: null, forecast: null };
  try { out.amedas = amedasNear_(lat, lon); } catch (e) { rethrowNeed_(e); out.amedasError = String(e.message || e); }
  try { out.forecast = forecastAt_(lat, lon, c20); } catch (e) { rethrowNeed_(e); out.forecastError = String(e.message || e); }
  return out;
}

/**
 * 風の推移と予報（指定日の 0〜24 時）。
 *  - 実況：最寄りのアメダス（風を観測している地点）の毎正時の値
 *  - 予報：Open-Meteo（気象庁 MSM/GSM モデル、地点の毎時値）
 * @param {number} lat
 * @param {number} lon
 * @param {string=} dateStr 'YYYY-MM-DD'（省略時は今日）
 */
function getWind(lat, lon, dateStr) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var now = Date.now();
  var base = checkDate_(dateStr, now);
  var out = { base: base, obs: [], fc: [], station: null };

  // 実況（アメダス）
  try {
    var table = amedasTable_();
    var near = table.map(function (s) { return { s: s, d: distKm_(lat, lon, s[2], s[3]) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
    var blocks = [];
    for (var h = 0; h < 24; h += 3) { if (base + h * HOUR <= now) blocks.push(ymd_(base).replace(/-/g, '') + '_' + pad2_(h)); }
    for (var i = 0; i < near.length && blocks.length; i++) {
      var s = near[i].s, pts = [];
      blocks.forEach(function (b) {
        var past = jstMidnight_(b.substr(0, 4) + '-' + b.substr(4, 2) + '-' + b.substr(6, 2)) + (+b.substr(9, 2) + 3) * HOUR < now - HOUR;
        var txt = cachedText_('amedas_pt_' + s[0] + '_' + b, past ? 6 * 3600 : 120, AMEDAS + 'data/point/' + s[0] + '/' + b + '.json', true);
        if (!txt) return;
        var o = JSON.parse(txt);
        Object.keys(o).forEach(function (k) {
          if (k.substr(10, 2) !== '00') return;   // 毎正時
          var w = val_(o[k].wind);
          if (w != null) pts.push([keyMs_(k), w, val_(o[k].windDirection)]);
        });
      });
      if (pts.length) {
        out.obs = pts.sort(function (a, b) { return a[0] - b[0]; });
        out.station = { name: s[1], dist: Math.round(near[i].d * 10) / 10 };
        break;
      }
    }
  } catch (e) { rethrowNeed_(e); out.obsError = String(e.message || e); }

  // 予報（Open-Meteo）
  try {
    var key = 'om_' + lat.toFixed(2) + '_' + lon.toFixed(2);
    var url = OPEN_METEO + '?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=Asia%2FTokyo' +
      '&models=jma_seamless&past_days=2&forecast_days=4';
    var j = JSON.parse(cachedText_(key, 1800, url));
    var hr = j.hourly || {};
    (hr.time || []).forEach(function (t, k) {
      var ms = Date.parse(t + ':00+09:00');
      if (ms < base || ms > base + DAY) return;
      var sp = hr.wind_speed_10m[k];
      if (sp == null) return;
      out.fc.push([ms, Math.round(sp * 10) / 10, hr.wind_direction_10m[k], hr.wind_gusts_10m ? hr.wind_gusts_10m[k] : null]);
    });
  } catch (e) { rethrowNeed_(e); out.fcError = String(e.message || e); }
  return out;
}

function amedasTable_() {
  return cached_('amedas_table', 24 * 3600, function () {
    var t = JSON.parse(fetchAll_([AMEDAS + 'const/amedastable.json'])[0]);
    // elems の3桁目が風
    return Object.keys(t).filter(function (k) { return String(t[k].elems).charAt(2) === '1'; })
      .map(function (k) {
        var s = t[k];
        return [k, s.kjName, s.lat[0] + s.lat[1] / 60, s.lon[0] + s.lon[1] / 60];
      });
  });
}

/** 最寄りの（風を観測している）アメダス地点の最新値 */
function amedasNear_(lat, lon) {
  var table = amedasTable_();
  var latest = Date.parse(cachedText_('amedas_latest', 60, AMEDAS + 'data/latest_time.txt').trim());
  var near = table.map(function (s) { return { s: s, d: distKm_(lat, lon, s[2], s[3]) }; })
    .sort(function (a, b) { return a.d - b.d; }).slice(0, 3);

  // 3時間ごとのファイル（JST）。ブロック切替直後に備え直前のブロックも見る
  var blocks = [latest, latest - 3 * HOUR].map(function (t) {
    var d = new Date(t + JST);
    return ymd_(t).replace(/-/g, '') + '_' + pad2_(Math.floor(d.getUTCHours() / 3) * 3);
  });

  for (var i = 0; i < near.length; i++) {
    var s = near[i].s, entries = {};
    blocks.forEach(function (b) {
      var txt = cachedText_('amedas_pt_' + s[0] + '_' + b, 120,
        AMEDAS + 'data/point/' + s[0] + '/' + b + '.json', true);
      if (txt) {
        var o = JSON.parse(txt);
        Object.keys(o).forEach(function (k) { entries[k] = o[k]; });
      }
    });
    var keys = Object.keys(entries).sort();
    var series = [], cur = null, curKey = null;
    keys.forEach(function (k) {
      var v = entries[k];
      if (val_(v.wind) == null) return;
      series.push([keyMs_(k), val_(v.wind), val_(v.windDirection)]);
      cur = v; curKey = k;
    });
    if (!cur || keyMs_(curKey) < latest - 2 * HOUR) continue;
    return {
      code: s[0], name: s[1], dist: Math.round(near[i].d * 10) / 10,
      time: keyMs_(curKey),
      wind: val_(cur.wind),
      dir: val_(cur.windDirection),          // 0=静穏, 1=北北東 … 16=北
      gust: val_(cur.gust),                   // 日最大瞬間風速（0時から）
      gustDir: val_(cur.gustDirection),
      gustTime: utcHmToJst_(curKey, cur.gustTime),
      temp: val_(cur.temp),
      precip1h: val_(cur.precipitation1h),
      precip24h: val_(cur.precipitation24h),
      humidity: val_(cur.humidity),
      series: series.slice(-18)
    };
  }
  return null;
}

/** 位置の予報区の天気予報（今日・明日） */
function forecastAt_(lat, lon, c20) {
  var area = cached_('jma_area', 24 * 3600, function () {
    var a = JSON.parse(fetchAll_(['https://www.jma.go.jp/bosai/common/const/area.json'])[0]);
    var m = { c20: {}, c15: {}, c10: {}, off: {} };
    Object.keys(a.class20s).forEach(function (k) { m.c20[k] = a.class20s[k].parent; });
    Object.keys(a.class15s).forEach(function (k) { m.c15[k] = a.class15s[k].parent; });
    Object.keys(a.class10s).forEach(function (k) { m.c10[k] = a.class10s[k].parent; });
    Object.keys(a.offices).forEach(function (k) { m.off[k] = a.offices[k].name; });
    return m;
  });

  // 位置 → 市区町村コード（国土地理院 逆ジオコーダ）。海上などで引けなければ観測地点の市区町村
  var code = null, src = 'station';
  try {
    var rg = cachedText_('rg_' + lat.toFixed(3) + '_' + lon.toFixed(3), 24 * 3600,
      GSI_REVGEO + '?lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5), true);
    var muni = rg && JSON.parse(rg).results && JSON.parse(rg).results.muniCd;
    if (muni) {
      muni = ('00000' + muni).slice(-5);
      // 政令市の区は市のコードで登録されている場合がある
      [muni + '00', muni.slice(0, 3) + '0000', muni.slice(0, 4) + '000'].some(function (c) {
        if (area.c20[c]) { code = c; return true; }
        return false;
      });
      if (code) src = 'location';
    }
  } catch (e) { rethrowNeed_(e); /* フォールバック */ }
  if (!code && c20 && area.c20[c20]) code = c20;
  if (!code) return null;

  var c10 = area.c15[area.c20[code]];
  var office = area.c10[c10];
  if (!office) return null;
  var fc = JSON.parse(cachedText_('fc_' + office, 600, FORECAST + 'data/forecast/' + office + '.json'));
  var ts = fc[0].timeSeries;
  var pick = function (s) {
    return s.areas.filter(function (a) { return a.area.code === c10; })[0] || s.areas[0];
  };
  var w = pick(ts[0]);
  var days = ts[0].timeDefines.map(function (t, i) {
    var wc = w.weatherCodes && w.weatherCodes[i];
    var tel = TELOPS[wc] || null;
    return {
      t: Date.parse(t),
      code: wc,
      text: clean_(w.weathers && w.weathers[i] || (tel && tel[2]) || ''),
      wind: clean_(w.winds && w.winds[i] || ''),
      wave: clean_(w.waves && w.waves[i] || ''),
      short: tel ? tel[2] : '',
      icon: tel ? tel[0] : null,
      iconNight: tel ? tel[1] : null
    };
  });
  var pops = [];
  if (ts[1]) {
    var p = pick(ts[1]);
    pops = ts[1].timeDefines.map(function (t, i) { return [Date.parse(t), p.pops && p.pops[i] !== '' ? +p.pops[i] : null]; });
  }
  return {
    office: office, officeName: area.off[office] || '', area: w.area.name,
    report: Date.parse(fc[0].reportDatetime), src: src,
    days: days.slice(0, 2), pops: pops
  };
}

/** 予報文の空白をまとめ、全角数字を半角にする */
function clean_(s) {
  return String(s).replace(/[\s　]+/g, ' ').trim()
    .replace(/[０-９．]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
}
function val_(a) { return a && a[0] != null ? a[0] : null; }
function keyMs_(k) {
  return Date.UTC(+k.substr(0, 4), +k.substr(4, 2) - 1, +k.substr(6, 2), +k.substr(8, 2), +k.substr(10, 2)) - JST;
}
/** アメダスの日最大値の時刻（UTC の時分）を、その日の JST 時刻に直す */
function utcHmToJst_(key, hm) {
  if (!hm || hm.hour == null) return null;
  var day = jstMidnight_(key.substr(0, 4) + '-' + key.substr(4, 2) + '-' + key.substr(6, 2));
  return day + (((hm.hour + 9) % 24) * 60 + hm.minute) * 60000;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 潮位表掲載地点一覧 HTML → [{code,name,lat,lon}] */
function parseSuisanStations_(html) {
  var re = /<td>([A-Z0-9]{2})<\/td><td><a[^>]*>([^<]+)<\/a><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  var out = [], m;
  while ((m = re.exec(html))) {
    out.push({ code: m[1], name: m[2].trim(), lat: dm_(m[3]), lon: dm_(m[4]) });
  }
  return out;
}

function dm_(s) {
  var q = String(s).match(/(\d+)\D+(\d+)/);
  return q ? +q[1] + q[2] / 60 : NaN;
}

/** 観測地点に対応する潮位表地点コード（同名かつ近傍のもの） */
function matchSuisan_(s, suisan) {
  var best = null, bestD = Infinity;
  suisan.forEach(function (p) {
    var d = distKm_(s.lat, s.lon, p.lat, p.lon);
    var sameName = p.name === s.name || p.name === s.name.replace(/港$/, '');
    if ((sameName && d < 15) || d < 1) {
      if (d < bestD) { best = p.code; bestD = d; }
    }
  });
  return best || '';
}

/**
 * 潮位表テキスト（1日1行, 固定長）を rows['YYYY-MM-DD'] = {hr:[24], hi:[[ms,cm]], lo:[[ms,cm]]} に格納。
 * 1-72桁: 毎時潮位 3桁×24, 73-78: 年月日, 79-80: 地点記号,
 * 81-108: 満潮 時刻4桁+潮位3桁 ×4, 109-136: 干潮 同上（9999/999 は無し）
 */
function parseSuisanTxt_(txt, rows) {
  txt.split(/\r?\n/).forEach(function (l) {
    if (l.length < 136) return;
    var y = 2000 + +l.substr(72, 2), mo = +l.substr(74, 2), d = +l.substr(76, 2);
    if (!mo || !d) return;
    var hr = [];
    for (var i = 0; i < 24; i++) hr.push(+l.substr(i * 3, 3));
    var ev = function (off) {
      var r = [];
      for (var k = 0; k < 4; k++) {
        var tt = l.substr(off + k * 7, 4), hh = l.substr(off + k * 7 + 4, 3);
        if (tt === '9999' || hh === '999') continue;
        // 時・分はそれぞれ空白詰めの2桁（例 " 2 5" = 2:05）
        var th = +tt.substr(0, 2), tm = +tt.substr(2, 2);
        if (isNaN(th) || isNaN(tm) || isNaN(+hh)) continue;
        r.push([(th * 60 + tm) * 60000, +hh]);
      }
      return r;
    };
    rows[y + '-' + pad2_(mo) + '-' + pad2_(d)] = { hr: hr, hi: ev(80), lo: ev(108) };
  });
}

/**
 * 潮位表の毎時値と天文潮位（TP）の差から基準面オフセットを求める。
 * 同じ調和定数による推算なら差は一定になる。一定でなければ別地点とみなし null。
 */
function datumOffset_(days, rows, astro) {
  var diffs = [];
  days.forEach(function (d, i) {
    var r = rows[ymd_(d)];
    if (!r) return;
    for (var h = 0; h < 24; h++) {
      var a = astro[i * 24 + h];
      if (a != null) diffs.push(r.hr[h] - a);
    }
  });
  if (diffs.length < 24) return null;
  diffs.sort(function (a, b) { return a - b; });
  if (diffs[diffs.length - 1] - diffs[0] > 2) return null;
  return diffs[Math.floor(diffs.length / 2)];
}

/* ------------------------------------------------------------------ */
/* 取得・キャッシュ                                                     */
/* ------------------------------------------------------------------ */

// ブラウザから直接取得できる（CORS を許可している）サイトのうち、更新の頻繁なデータ。
// callWithPre 経由で呼ばれたときは、サーバーで取りに行かずブラウザに取ってきてもらい、
// URL Fetch の1日の上限を節約する。
// ブラウザから渡された本文は偽物の可能性があるので、その利用者への応答にだけ使い、共有キャッシュには入れない。
// 地点一覧・年間の推算などの長く使い回す基本データ（/const/ 以下や潮位表）はサーバーで取得して共有する。
// ※ www.river.go.jp は CDN のキャッシュ応答に CORS ヘッダーが付かないことがあるため、サーバーで取得してキャッシュする
var CLIENT_HOSTS = ['www.jma.go.jp', 'api.open-meteo.com', 'mreversegeocoder.gsi.go.jp'];
var PRE = null;        // ブラウザから渡された { url: 本文 | null(404) | {err:1}(ブラウザで取れなかった) }
var FROM_PRE = false;  // この処理でブラウザから渡された本文を使ったか（使ったら共有キャッシュに入れない）

// サーバーからの外部取得の上限（無料アカウントの1日2万回を使い切らないよう余裕を残す）
var FETCH_LIMIT = { hour: 2500, day: 18000, fallbackHour: 300, lowShare: 0.7 };   // lowShare：河川・水質はこの割合まで

/**
 * ブラウザから呼ぶ入口。必要なデータが揃っていなければ { need: [url…] } を返し、
 * ブラウザが取ってきて pre に入れて呼び直す。揃えば { result }。
 */
// 画面から呼べる処理
function api_() {
  return { getStations: getStations, getTideData: getTideData, getWeather: getWeather, getRiver: getRiver,
    getRiverStations: getRiverStations, getWind: getWind, getWaterQuality: getWaterQuality, getPredPoints: getPredPoints };
}
function callWithPre(name, args, pre, ev) {
  if (ev) monRecord_(ev);   // 利用状況（Monitor.gs。書き込みは最後にまとめて）
  var t0 = Date.now();
  var api = api_();
  if (!Object.prototype.hasOwnProperty.call(api, name)) throw new Error('不正な呼び出しです: ' + name);
  if (args != null && !Array.isArray(args)) throw new Error('不正な呼び出しです');
  setupPre_(pre);
  try {
    return { result: api[name].apply(null, args || []) };
  } catch (e) {
    if (e && e.needUrls) return { need: e.needUrls };
    if (!/アクセスが集中/.test(String(e && e.message)) && !(e && e.paused)) monServer_('err', name);
    throw e;
  } finally {
    PRE = null; FROM_PRE = false; PROXY_ON = false;
    monServerPerf_(name, Date.now() - t0);
    monCommit_();
  }
}

/**
 * まとめて呼ぶ入口（起動時などに、潮位・天気・風などを1回の呼び出しで処理する。同時実行の枠を節約）。
 * calls = [[番号, 処理名, 引数], …]。終わったものは done に、ブラウザに取ってきてほしい URL は need に（全部の分をまとめて）返す。
 * 画面は need を取ってきて、まだ終わっていないものだけを pre と一緒に呼び直す。
 */
function callBatch(calls, pre, ev) {
  if (ev) monRecord_(ev);
  if (!Array.isArray(calls) || !calls.length || calls.length > 12) throw new Error('不正な呼び出しです');
  var api = api_(), done = {}, need = {};
  setupPre_(pre);
  try {
    calls.forEach(function (c) {
      if (!Array.isArray(c)) return;
      var id = String(c[0]).slice(0, 20), name = c[1], args = c[2], t0 = Date.now();
      if (!Object.prototype.hasOwnProperty.call(api, name) || (args != null && !Array.isArray(args))) { done[id] = { error: '不正な呼び出しです' }; return; }
      FROM_PRE = false;
      try {
        done[id] = { result: api[name].apply(null, args || []) };
      } catch (e) {
        if (e && e.needUrls) e.needUrls.forEach(function (u) { need[u] = 1; });
        else {
          done[id] = { error: String(e && e.message || e) };
          if (!/アクセスが集中/.test(String(e && e.message)) && !(e && e.paused)) monServer_('err', name);
        }
      } finally {
        monServerPerf_(name, Date.now() - t0);
      }
    });
    var nu = Object.keys(need);
    return { done: done, need: nu.length ? nu : null };
  } finally {
    PRE = null; FROM_PRE = false; PROXY_ON = false;
    monCommit_();
  }
}

/** ブラウザから渡されたデータを受け入れる（こちらが求めたサイトの URL の本文だけ。中継のデータは署名を確かめる） */
function setupPre_(pre) {
  PRE = {};
  PRE_TRUST = {};
  PROXY_ON = !!(pre && pre.__proxy === 1);
  if (pre && typeof pre === 'object') {
    Object.keys(pre).forEach(function (u) {
      var v = pre[u];
      if (!clientUrl_(u)) return;
      if (proxyUrl_(u)) {
        // 中継のデータは署名が正しいものだけ使う（正しくなければサーバーで取り直す）
        if (v && typeof v === 'object' && !v.err && (typeof v.b === 'string' || v.n === 1) && proxyVerify_(u, v.n === 1 ? '__404__' : v.b, v.s)) {
          PRE[u] = v.n === 1 ? null : v.b; PRE_TRUST[u] = true;
        } else PRE[u] = { err: 1 };
        return;
      }
      if (v === null || typeof v === 'string' || (v && typeof v === 'object' && v.err)) PRE[u] = typeof v === 'object' && v ? { err: 1 } : v;
    });
  }
}

/** ブラウザに取ってきてもらう URL か */
function clientUrl_(url) {
  var m = /^https:\/\/([^\/]+)(\/[^?#]*)?/.exec(String(url));
  if (!m) return false;
  if (CLIENT_HOSTS.indexOf(m[1]) >= 0 && !/\/const\//.test(m[2] || '')) return true;
  if (proxyUrl_(url)) return true;
  // 非常時モード：Google の URL Fetch の上限に達している間は、気象庁のデータ（地点一覧・潮位表など）もブラウザから取る
  return EMERGENCY_HOSTS.indexOf(m[1]) >= 0 && ufBlocked_();
}
var EMERGENCY_HOSTS = ['www.jma.go.jp', 'www.data.jma.go.jp'];
// 中継（Cloudflare Workers）経由でブラウザに取ってきてもらうデータ元。署名を確かめてから共有キャッシュに入れる
var PROXY_HOSTS = ['www.river.go.jp', 'www1.kaiho.mlit.go.jp'];
var PROXY_SECRET = null, PRE_TRUST = {}, PROXY_ON = false;   // PROXY_ON：画面が中継に対応している（pre.__proxy）
function proxySecret_() {
  if (PROXY_SECRET == null) PROXY_SECRET = PropertiesService.getScriptProperties().getProperty('PROXY_SECRET') || '';
  return PROXY_SECRET;
}
// 市区町村の一覧（files/map、1MB 超）はブラウザから送ると重いので、サーバーで取って1日キャッシュする
function proxyUrl_(url) {
  var m = /^https:\/\/([^\/]+)\//.exec(String(url));
  // ただし Google の上限に達している間（非常時モード）は、市区町村の一覧も中継から取る
  return PROXY_ON && !!m && PROXY_HOSTS.indexOf(m[1]) >= 0 && (!/\/files\/map\//.test(url) || ufBlocked_()) && !!proxySecret_();
}
/** 中継の署名（HMAC-SHA256、16進）を確かめる */
function proxyVerify_(url, body, sig) {
  var key = proxySecret_();
  if (!key || !/^[0-9a-f]{64}$/.test(String(sig || ''))) return false;
  var raw = Utilities.computeHmacSha256Signature(url + '\n' + body, key, Utilities.Charset.UTF_8);
  var hex = raw.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  return hex === sig;
}
var UF_BLOCKED = null;   // この実行の中での判定（キャッシュを何度も読まない）
function ufBlocked_() {
  if (UF_BLOCKED == null) UF_BLOCKED = !!CacheService.getScriptCache().get(CACHE_VER + 'uf_blocked');
  return UF_BLOCKED;
}
function isQuotaError_(e) { return /urlfetch|回数が多すぎ|too many times|Bandwidth quota/i.test(String(e && e.message || e)); }
function needError_(urls) { var e = new Error('ブラウザでの取得が必要です'); e.needUrls = urls; return e; }
/** 「ブラウザに取ってきてほしい」は握りつぶさずに上へ伝える */
function rethrowNeed_(e) { if (e && e.needUrls) throw e; }

/** 位置（日本の周辺）のチェック */
function checkPos_(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon) || lat < 20 || lat > 46 || lon < 122 || lon > 154) throw new Error('位置が不正です');
}
/** 日付（今日の前後400日以内）のチェック。0:00（JST）の時刻を返す */
function checkDate_(dateStr, now) {
  var base = dateStr ? jstMidnight_(dateStr) : jstMidnight_(ymd_(now));
  if (Math.abs(base - now) > 400 * DAY) throw new Error('日付が範囲外です');
  return base;
}

/**
 * サーバーからの外部取得の回数を数え、上限を超えるなら止める。
 * 時間ごとは CacheService、日ごとは ScriptProperties で数える（厳密ではないが目安として十分）。
 */
function spendFetch_(n, fallback, low) {   // fallback：そのうちブラウザで取れなかった分の代行の数、low：優先度の低い取得（河川・水質）
  var cache = CacheService.getScriptCache(), now = Date.now();
  var hk = CACHE_VER + 'uf_h_' + Math.floor(now / HOUR), fk = CACHE_VER + 'uf_f_' + Math.floor(now / HOUR);
  var h = +(cache.get(hk) || 0), f = +(cache.get(fk) || 0);
  var props = PropertiesService.getScriptProperties(), today = ymd_(now), d = 0;
  try { var j = JSON.parse(props.getProperty('uf_day') || '{}'); d = j.d === today ? +j.n || 0 : 0; } catch (e) { d = 0; }
  if (low && (h + n > FETCH_LIMIT.hour * FETCH_LIMIT.lowShare || d + n > FETCH_LIMIT.day * FETCH_LIMIT.lowShare)) {
    monQuality_('river_paused');
    var pe = new Error('アクセスが集中しているため、河川・水質の表示を一時的に止めています（潮位は表示を続けます）。');
    pe.paused = true;
    throw pe;
  }
  if (h + n > FETCH_LIMIT.hour || d + n > FETCH_LIMIT.day || (fallback && f + fallback > FETCH_LIMIT.fallbackHour)) {
    monServer_('lim');
    throw new Error('アクセスが集中しているため、新しいデータを取得できません。しばらくしてからお試しください。');
  }
  cache.put(hk, String(h + n), 2 * 3600);
  if (fallback) cache.put(fk, String(f + fallback), 2 * 3600);
  try { props.setProperty('uf_day', JSON.stringify({ d: today, n: d + n })); } catch (e) { /* 書き込み上限など */ }
}

function fetchAll_(urls, allow404) {
  var out = new Array(urls.length), server = [], need = [], fallback = 0;
  urls.forEach(function (u, i) {
    if (PRE && clientUrl_(u)) {
      if (Object.prototype.hasOwnProperty.call(PRE, u)) {
        var v = PRE[u];
        if (v && typeof v === 'object') { server.push(i); fallback++; return; }   // ブラウザで取れなかった → サーバーで取る
        out[i] = v;                                                                // 本文、または null（404）
        if (!PRE_TRUST[u]) FROM_PRE = true;                                         // 署名つきの中継データは共有してよい
        return;
      }
      need.push(u);
      return;
    }
    server.push(i);
  });
  if (need.length) throw needError_(need);
  // 中継に対応していない古い画面からの呼び出しでは、川の防災情報・海上保安庁をサーバーで取りに行かない
  // （Google の URL Fetch の上限を使い切る主な原因だったため。新しい画面は中継経由で取る）
  if (PRE && !PROXY_ON && server.some(function (i) { var m = /^https:\/\/([^\/]+)\//.exec(urls[i]); return m && PROXY_HOSTS.indexOf(m[1]) >= 0; })) {
    monQuality_('old_client_blocked');
    var oe = new Error('古い画面のため、河川水位・海上保安庁の速報を表示できません。ページを再読み込みしてください。');
    oe.paused = true;
    throw oe;
  }
  if (server.length) {
    spendFetch_(server.length, fallback, server.every(function (i) { return /^https:\/\/www\.river\.go\.jp\//.test(urls[i]); }));
    server.forEach(function (i) { monCountHost_(urls[i]); });   // 利用状況：外部サイトごとの回数（Monitor.gs）
    var res;
    try {
      res = UrlFetchApp.fetchAll(server.map(function (i) {
        return { url: urls[i], muteHttpExceptions: true, followRedirects: true };
      }));
    } catch (e) {
      var quota = isQuotaError_(e);
      server.forEach(function (i) { monFailHost_(urls[i], quota ? 'quota' : 'ex'); });   // 通信の失敗・時間切れ・上限（利用状況）
      if (quota) {
        // Google の上限に達した：1時間は非常時モード。ブラウザから取れるものは取ってきてもらう
        CacheService.getScriptCache().put(CACHE_VER + 'uf_blocked', '1', 3600);
        UF_BLOCKED = true;
        monQuality_('urlfetch_quota');
        var alt = PRE ? server.map(function (i) { return urls[i]; }).filter(function (u) { return clientUrl_(u) && !Object.prototype.hasOwnProperty.call(PRE, u); }) : [];
        if (alt.length) throw needError_(alt);
      }
      throw e;
    }
    res.forEach(function (r, j) {
      var i = server[j], code = r.getResponseCode();
      if (code !== 200) monFailHost_(urls[i], code);
      if (code === 200) out[i] = r.getContentText('UTF-8');
      else if (allow404 || code === 404) out[i] = null;
      else throw new Error('取得失敗 ' + code + ': ' + urls[i]);
    });
  }
  return out;
}

/**
 * まとめて取得してキャッシュに入れておく（items: [[キャッシュキー, URL, 秒]]）。
 * 足りないものをブラウザに一度に頼めるので往復が減る。サーバーで取るときも並列になる。
 */
function prefetch_(items) {
  var cache = CacheService.getScriptCache();
  var miss = items.filter(function (it) { return cache.get(CACHE_VER + it[0]) == null; });
  if (!miss.length) return;
  var txts = fetchAll_(miss.map(function (it) { return it[1]; }), true);
  miss.forEach(function (it, i) {
    if (PRE && clientUrl_(it[1]) && !PRE_TRUST[it[1]]) return;   // ブラウザ由来は共有しない（署名つきの中継データは共有）
    try { cache.put(CACHE_VER + it[0], txts[i] == null ? '__404__' : txts[i], Math.min(it[2], 21600)); } catch (e) { /* 100KB 超など */ }
  });
}

function cachedText_(key, ttl, url, allow404) {
  var cache = CacheService.getScriptCache();
  var k = CACHE_VER + key;
  var hit = cache.get(k);
  if (hit != null) return hit === '__404__' ? null : hit;
  var txt = fetchAll_([url], allow404)[0];
  if (PRE && clientUrl_(url) && !PRE_TRUST[url]) return txt;   // ブラウザ由来は共有しない（署名つきの中継データは共有）
  try { cache.put(k, txt == null ? '__404__' : txt, Math.min(ttl, 21600)); } catch (e) { /* 100KB 超など */ }
  return txt;
}

function cached_(key, ttl, fn) {
  var cache = CacheService.getScriptCache();
  var k = CACHE_VER + key;
  var hit = cache.get(k);
  if (hit != null) return JSON.parse(hit);
  var before = FROM_PRE;
  FROM_PRE = false;
  var v = fn(), used = FROM_PRE;
  FROM_PRE = before || used;
  // ブラウザから渡された本文をもとにした結果は共有しない
  if (!used) { try { cache.put(k, JSON.stringify(v), Math.min(ttl, 21600)); } catch (e) { /* ignore */ } }
  return v;
}

/* ------------------------------------------------------------------ */
/* ユーティリティ（JST は固定 +9h で扱う）                               */
/* ------------------------------------------------------------------ */

function jstParts_(ms) {
  var d = new Date(ms + JST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
function ymd_(ms) {
  var p = jstParts_(ms);
  return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d);
}
function jstMidnight_(s) {
  var q = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!q) throw new Error('日付が不正です: ' + s);
  return Date.UTC(+q[1], +q[2] - 1, +q[3]) - JST;
}
/** 天気コード → [昼アイコン, 夜アイコン, 短文]（気象庁 天気予報ページの TELOPS より） */
var TELOPS = {"100":["100","500","晴"],"101":["101","501","晴時々曇"],"102":["102","502","晴一時雨"],"103":["102","502","晴時々雨"],"104":["104","504","晴一時雪"],"105":["104","504","晴時々雪"],"106":["102","502","晴一時雨か雪"],"107":["102","502","晴時々雨か雪"],"108":["102","502","晴一時雨か雷雨"],"110":["110","510","晴後時々曇"],"111":["110","510","晴後曇"],"112":["112","512","晴後一時雨"],"113":["112","512","晴後時々雨"],"114":["112","512","晴後雨"],"115":["115","515","晴後一時雪"],"116":["115","515","晴後時々雪"],"117":["115","515","晴後雪"],"118":["112","512","晴後雨か雪"],"119":["112","512","晴後雨か雷雨"],"120":["102","502","晴朝夕一時雨"],"121":["102","502","晴朝の内一時雨"],"122":["112","512","晴夕方一時雨"],"123":["100","500","晴山沿い雷雨"],"124":["100","500","晴山沿い雪"],"125":["112","512","晴午後は雷雨"],"126":["112","512","晴昼頃から雨"],"127":["112","512","晴夕方から雨"],"128":["112","512","晴夜は雨"],"130":["100","500","朝の内霧後晴"],"131":["100","500","晴明け方霧"],"132":["101","501","晴朝夕曇"],"140":["102","502","晴時々雨で雷を伴う"],"160":["104","504","晴一時雪か雨"],"170":["104","504","晴時々雪か雨"],"181":["115","515","晴後雪か雨"],"200":["200","200","曇"],"201":["201","601","曇時々晴"],"202":["202","202","曇一時雨"],"203":["202","202","曇時々雨"],"204":["204","204","曇一時雪"],"205":["204","204","曇時々雪"],"206":["202","202","曇一時雨か雪"],"207":["202","202","曇時々雨か雪"],"208":["202","202","曇一時雨か雷雨"],"209":["200","200","霧"],"210":["210","610","曇後時々晴"],"211":["210","610","曇後晴"],"212":["212","212","曇後一時雨"],"213":["212","212","曇後時々雨"],"214":["212","212","曇後雨"],"215":["215","215","曇後一時雪"],"216":["215","215","曇後時々雪"],"217":["215","215","曇後雪"],"218":["212","212","曇後雨か雪"],"219":["212","212","曇後雨か雷雨"],"220":["202","202","曇朝夕一時雨"],"221":["202","202","曇朝の内一時雨"],"222":["212","212","曇夕方一時雨"],"223":["201","601","曇日中時々晴"],"224":["212","212","曇昼頃から雨"],"225":["212","212","曇夕方から雨"],"226":["212","212","曇夜は雨"],"228":["215","215","曇昼頃から雪"],"229":["215","215","曇夕方から雪"],"230":["215","215","曇夜は雪"],"231":["200","200","曇海上海岸は霧か霧雨"],"240":["202","202","曇時々雨で雷を伴う"],"250":["204","204","曇時々雪で雷を伴う"],"260":["204","204","曇一時雪か雨"],"270":["204","204","曇時々雪か雨"],"281":["215","215","曇後雪か雨"],"300":["300","300","雨"],"301":["301","701","雨時々晴"],"302":["302","302","雨時々止む"],"303":["303","303","雨時々雪"],"304":["300","300","雨か雪"],"306":["300","300","大雨"],"308":["308","308","雨で暴風を伴う"],"309":["303","303","雨一時雪"],"311":["311","711","雨後晴"],"313":["313","313","雨後曇"],"314":["314","314","雨後時々雪"],"315":["314","314","雨後雪"],"316":["311","711","雨か雪後晴"],"317":["313","313","雨か雪後曇"],"320":["311","711","朝の内雨後晴"],"321":["313","313","朝の内雨後曇"],"322":["303","303","雨朝晩一時雪"],"323":["311","711","雨昼頃から晴"],"324":["311","711","雨夕方から晴"],"325":["311","711","雨夜は晴"],"326":["314","314","雨夕方から雪"],"327":["314","314","雨夜は雪"],"328":["300","300","雨一時強く降る"],"329":["300","300","雨一時みぞれ"],"340":["400","400","雪か雨"],"350":["300","300","雨で雷を伴う"],"361":["411","811","雪か雨後晴"],"371":["413","413","雪か雨後曇"],"400":["400","400","雪"],"401":["401","801","雪時々晴"],"402":["402","402","雪時々止む"],"403":["403","403","雪時々雨"],"405":["400","400","大雪"],"406":["406","406","風雪強い"],"407":["406","406","暴風雪"],"409":["403","403","雪一時雨"],"411":["411","811","雪後晴"],"413":["413","413","雪後曇"],"414":["414","414","雪後雨"],"420":["411","811","朝の内雪後晴"],"421":["413","413","朝の内雪後曇"],"422":["414","414","雪昼頃から雨"],"423":["414","414","雪夕方から雨"],"425":["400","400","雪一時強く降る"],"426":["400","400","雪後みぞれ"],"427":["400","400","雪一時みぞれ"],"450":["400","400","雪で雷を伴う"]};

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function uniq_(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }
function distKm_(la1, lo1, la2, lo2) {
  var r = Math.PI / 180;
  var x = (lo2 - lo1) * r * Math.cos((la1 + la2) / 2 * r);
  var y = (la2 - la1) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

/* ==================== ここから Monitor.gs ==================== */
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

// 利用状況アプリ（Monitor.gs と admin.html）のバージョン。更新したら CHANGELOG-monitor.md にも書き、monitor-vX.Y.Z のタグを付ける
var MONITOR_VERSION = '1.5.1', MONITOR_DATE = '2026-10-20';

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
  Logger.log('利用状況アプリ：monitor v' + MONITOR_VERSION + '（' + MONITOR_DATE + '）');
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
    version: MONITOR_VERSION, versionDate: MONITOR_DATE,
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

/* ------------------------------------------------------------------ */
/* 要約（JSON・テキスト）：スクリーンショットなしで状況を読めるように   */
/* ------------------------------------------------------------------ */

/**
 * 直近 days 日の要約。集計済み（スプレッドシート）と未集計（一時保存）を合わせて、
 * 判断に必要な数字だけを並べる（匿名IDの一覧などの細かいデータは含めない）。
 */
function getMonitorSummary(key, days) {
  var d = getMonitorData(key, days || 7), now = d.now, today = ymd_(now);
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
    generatedAt: new Date(now).toISOString(), monitor: d.version, period: { days: d.days, since: d.since },
    limits: d.limits,
    today: { day: today, pv: byDay[today] ? byDay[today].pv : 0, users: byDay[today] ? byDay[today].users : 0, urlFetch: d.ufToday, urlFetchThisHour: d.ufHour },
    totals: { pv: sum('pv'), users: Object.keys(all).length, limitHits: sum('lim'), serverErrors: sum('serr'), clientErrors: sum('cerr') },
    health: { lastFlushMinAgo: d.health.lastFlush ? Math.round((now - d.health.lastFlush.t) / 60000) : null, trigger: d.health.trigger,
      dropsToday: d.health.dropToday, sheetCells: d.health.cells, mailAlerts: d.health.alerts, alertTo: !!d.health.alertTo },
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
  L.push('my tide-graph 利用状況の要約（monitor v' + s.monitor + '、' + s.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC 時点、直近' + s.period.days + '日）');
  L.push('');
  L.push('■ 今日（' + s.today.day + '）');
  L.push('表示 ' + s.today.pv + ' 回／利用者 ' + s.today.users + ' 人／URL Fetch ' + s.today.urlFetch + ' 回（上限 ' + s.limits.day + ' の ' + pct(s.today.urlFetch, s.limits.day) + '）／この1時間 ' + s.today.urlFetchThisHour + ' 回');
  L.push('■ 監視の状態');
  L.push('最後の集計 ' + s.health.lastFlushMinAgo + ' 分前／トリガー ' + (s.health.trigger ? 'あり' : 'なし') + '／取りこぼし（今日） ' + s.health.dropsToday + ' 件／スプレッドシート ' + s.health.sheetCells + ' セル／メール通知 ' + (s.health.mailAlerts && s.health.alertTo ? 'オン' : '無効'));
  L.push('■ 期間の合計');
  L.push('表示 ' + s.totals.pv + ' 回／利用者 ' + s.totals.users + ' 人／上限超え ' + s.totals.limitHits + ' 回／エラー サーバー ' + s.totals.serverErrors + '・画面 ' + s.totals.clientErrors);
  L.push('■ 日ごと（日付 表示 利用者[新規] URLFetch 上限超え エラー(サーバー/画面)）');
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
function getMonitorSummaryText(key, days) { return monSummaryText_(getMonitorSummary(key, days)); }


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
