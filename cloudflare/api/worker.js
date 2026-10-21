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
    lat: st.lat, lon: st.lon,
    tidal: tidal,
    noData: noData,
    url: 'https://www.river.go.jp/kawabou/pc/tm?itmkndCd=4&ofcCd=' + st.ofc + '&obsCd=' + st.obs + '&isCurrent=true&fld=0',
    min10: conv(st.ts.min10Values),
    hour: conv(st.ts.hrValues)
  };
}

/** 選択用・地図用：指定位置の近くの水位観測所（近い順、最大30）。
 *  川の防災情報への取得を増やさないよう、河川水位の表示でも使う町ごとの観測所一覧（gjson、全国で共有）だけから作る。
 *  観測所ごとの最新値・情報は取りに行かないので、潮位と同じ目盛りに重ねられない観測所（標高の高い所）も含む */
function getRiverStations(lat, lon) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var g = listGrid_(lat, lon);
  var list = cached_('rv_list4_' + g.key, 6 * 3600, function () {
    // 一覧は約10km単位で共有するので、端の人の近くも入るよう多めの市区町村から集める
    return riverNearby_(g.lat, g.lon, 9).stations.slice(0, 60).map(function (s) { return { fcd: s.fcd, name: s.name, lat: s.lat, lon: s.lon }; });
  });
  return list.map(function (x) { return { fcd: x.fcd, name: x.name, river: '', lat: x.lat, lon: x.lon, dist: Math.round(distKm_(lat, lon, x.lat, x.lon) * 10) / 10 }; })
    .sort(function (a, b) { return a.dist - b.dist; }).slice(0, 30);
}

/** 観測所の一覧を共有する単位（約10km＝0.1°に丸めた位置）。河川・水質の一覧と、水質観測所の選択で同じものを使う */
function listGrid_(lat, lon) {
  var glat = Math.round(lat * 10) / 10, glon = Math.round(lon * 10) / 10;
  return { lat: glat, lon: glon, key: glat.toFixed(1) + '_' + glon.toFixed(1) };
}

/** 指定位置の近くの水位観測所（近い順、重複なし）。nTowns：観測所を集める市区町村の数（既定5） */
function riverNearby_(lat, lon, nTowns) {
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
    .sort(function (a, b) { return a[1] - b[1]; }).slice(0, nTowns || 5);
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
 * 指定位置から 10km 以内に観測所があるときだけ返す（fcd で観測所を選んだときは距離によらずその観測所）。
 * 上層・下層など水深別の観測は層ごとに返す。
 */
function getWaterQuality(lat, lon, fcd) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  if (fcd && !/^\d{13}$/.test(fcd)) throw new Error('水質観測所の指定が不正です');
  var LIMIT_KM = 10;
  // 近くに水質観測所が無いとわかった地点（約5km単位）は、しばらく探しに行かない
  var cache = CacheService.getScriptCache(), noneKey = CACHE_VER + 'wq_none_' + (Math.round(lat * 20) / 20).toFixed(2) + '_' + (Math.round(lon * 20) / 20).toFixed(2);
  if (!fcd && cache.get(noneKey)) return null;
  var none = function () { if (!fcd) cache.put(noneKey, '1', 21600); return null; };
  // 選んだ観測所は、地図の一覧（getWQStations）と同じ単位の位置の近くから探す
  var gq = listGrid_(lat, lon);
  var stations = fcd ? wqNearby_(gq.lat, gq.lon) : wqNearby_(lat, lon);
  var site = fcd ? stations.filter(function (s) { return s.fcd === fcd; })[0] : stations[0];
  if (!site || (!fcd && site.d > LIMIT_KM)) return none();
  if (fcd) site.d = distKm_(lat, lon, site.lat, site.lon);

  // 同じ地点の水深別（平均・上層・中層・下層など）をまとめる
  var siteName = site.name.replace(WQ_LAYER, '');
  var group = stations.filter(function (s) { return s.name.replace(WQ_LAYER, '') === siteName && distKm_(s.lat, s.lon, site.lat, site.lon) < 0.5; });
  return wqSite_(site, siteName, group);
}

// 水深別の観測所の名前の末尾（「波崎上流上層（自動）」のように括弧書きが付くこともある）
var WQ_LAYER = /(平均|表層|上層|中層|下層|底層)(（[^）]*）)?$/;

/** 地図用：指定位置の近くの水質観測所（水深別は1地点にまとめる、近い順）。約10km単位で6時間共有 */
function getWQStations(lat, lon) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var g = listGrid_(lat, lon);
  var list = cached_('wq_list2_' + g.key, 6 * 3600, function () {
    var out = [];
    wqNearby_(g.lat, g.lon).forEach(function (s) {
      var name = s.name.replace(WQ_LAYER, '');
      if (out.some(function (x) { return x.name === name && distKm_(x.lat, x.lon, s.lat, s.lon) < 0.5; })) return;
      out.push({ fcd: s.fcd, name: name, river: s.river, lat: s.lat, lon: s.lon });
    });
    return out;
  });
  return list.map(function (x) { return { fcd: x.fcd, name: x.name, river: x.river, lat: x.lat, lon: x.lon, dist: Math.round(distKm_(lat, lon, x.lat, x.lon) * 10) / 10 }; })
    .sort(function (a, b) { return a.dist - b.dist; });
}

/** 指定位置の近く（市区町村の重心が20km以内）の水質観測所（近い順） */
function wqNearby_(lat, lon) {
  var towns = cached_('wq_towns', 24 * 3600, function () {
    var a = JSON.parse(fetchAll_([RIVER + 'files/map/twn/twnarea.json'])[0]).towns || [];
    return a.filter(function (t) { return t.qwtrExistFlg; })
      .map(function (t) { return [t.twnCd, Math.round(t.lat * 1e4) / 1e4, Math.round(t.lon * 1e4) / 1e4]; });
  });
  var near = towns.map(function (t) { return [t[0], distKm_(lat, lon, t[1], t[2])]; })
    .filter(function (t) { return t[1] < 20; }).sort(function (a, b) { return a[1] - b[1]; }).slice(0, 4);
  if (!near.length) return [];

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
  return stations;
}

/** 水質観測所（水深別のまとまり）の最新の水温・塩分濃度 */
function wqSite_(site, siteName, group) {
  var LAYER = WQ_LAYER;
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
    fcd: site.fcd, name: siteName, river: site.river, place: site.place, dist: Math.round(site.d * 10) / 10, lat: site.lat, lon: site.lon,
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
        out.station = { name: s[1], dist: Math.round(near[i].d * 10) / 10, lat: s[2], lon: s[3] };
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
    // 実際に使われたモデルの格子点（Open-Meteo が返す）。画面でどこの値かを示すため
    if (j.latitude != null) out.grid = { lat: j.latitude, lon: j.longitude, dist: Math.round(distKm_(lat, lon, j.latitude, j.longitude) * 10) / 10 };
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

/**
 * 指定位置の気圧：最寄りの気圧を観測しているアメダス（80km 以内、山頂は除く）の直近48時間の海面気圧（10分ごと）と、
 * Open-Meteo（気象庁モデル）の推移・予報（1時間ごと、前後3日）。
 * 利用者ごとに気象庁から取らず、サーバーのキャッシュで共有する（過去の3時間ごとのファイルは変わらないので長く持つ）
 */
function getPressure(lat, lon) {
  lat = +lat; lon = +lon;
  checkPos_(lat, lon);
  var now = Date.now(), out = { station: null, obs: [], fc: [] };
  try {
    var st = null;
    presTable_().forEach(function (s) {
      var d = distKm_(lat, lon, s[2], s[3]);
      if (d < 80 && (!st || d < st.dist)) st = { code: s[0], name: s[1], dist: Math.round(d * 10) / 10, lat: s[2], lon: s[3] };
    });
    if (st) {
      out.station = st;
      var b0 = Math.floor((now + JST) / (3 * HOUR)) * 3 * HOUR - JST, items = [];
      for (var t = b0 - 15 * 3 * HOUR; t <= b0; t += 3 * HOUR) {
        var b = ymd_(t).replace(/-/g, '') + '_' + pad2_(jstParts_(t).h);
        // 新しい2つは更新中の可能性があるので短く、それより前は変わらない
        items.push(['amedas_pt_' + st.code + '_' + b, AMEDAS + 'data/point/' + st.code + '/' + b + '.json', t >= b0 - 3 * HOUR ? 120 : 6 * 3600]);
      }
      prefetch_(items);
      items.forEach(function (it) {
        var txt = cachedText_(it[0], it[2], it[1], true);
        if (!txt) return;
        var o = JSON.parse(txt);
        Object.keys(o).forEach(function (k) {
          var v = o[k].normalPressure;
          if (v && v[0] != null && v[1] === 0) out.obs.push([keyMs_(k), v[0]]);   // 2つ目は品質（0 が正常）
        });
      });
      out.obs.sort(function (a, b) { return a[0] - b[0]; });
    }
  } catch (e) { rethrowNeed_(e); out.obsError = String(e.message || e); }
  try {
    // 約1km単位に丸めて、近くの利用者と共有する
    var la = lat.toFixed(2), lo = lon.toFixed(2);
    var j = JSON.parse(cachedText_('om_p_' + la + '_' + lo, 1800, OPEN_METEO + '?latitude=' + la + '&longitude=' + lo +
      '&hourly=pressure_msl&past_days=3&forecast_days=3&models=jma_seamless&timeformat=unixtime&timezone=GMT'));
    if (j.latitude != null) out.grid = { lat: j.latitude, lon: j.longitude, dist: Math.round(distKm_(lat, lon, j.latitude, j.longitude) * 10) / 10 };
    var h = j.hourly || {};
    (h.time || []).forEach(function (t, i) { if (h.pressure_msl[i] != null) out.fc.push([t * 1000, h.pressure_msl[i]]); });
  } catch (e) { rethrowNeed_(e); out.fcError = String(e.message || e); }
  return out;
}

/** 気圧を観測しているアメダス（観測所一覧の8番目の印が気圧。山頂の富士山〔type F〕は除く） */
function presTable_() {
  return cached_('amedas_ptable', 24 * 3600, function () {
    var t = JSON.parse(fetchAll_([AMEDAS + 'const/amedastable.json'])[0]);
    return Object.keys(t).filter(function (k) { return t[k].elems && t[k].elems.charAt(7) === '1' && t[k].type !== 'F'; })
      .map(function (k) { var s = t[k]; return [k, s.kjName, s.lat[0] + s.lat[1] / 60, s.lon[0] + s.lon[1] / 60]; });
  });
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
      code: s[0], name: s[1], dist: Math.round(near[i].d * 10) / 10, lat: s[2], lon: s[3],
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

  // 位置 → 市区町村コード（国土地理院 逆ジオコーダ）。海上などで引けなければ観測地点の市区町村。
  // 天気の地域を決めるだけなので、約1km単位に丸めて引き、利用者どうしで共有する
  var code = null, src = 'station';
  try {
    var rlat = lat.toFixed(2), rlon = lon.toFixed(2);
    var rg = cachedText_('rg2_' + rlat + '_' + rlon, 24 * 3600, GSI_REVGEO + '?lat=' + rlat + '&lon=' + rlon, true);
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
    getRiverStations: getRiverStations, getWind: getWind, getWaterQuality: getWaterQuality, getWQStations: getWQStations, getPredPoints: getPredPoints, getPressure: getPressure };
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


/* ==================== 管理画面（admin.html） ==================== */
const __ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"ja\">\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>my tide-graph 利用状況</title>\n<style>\n:root {\n  color-scheme: light;\n  --bg: #f4f4f2; --surface: #fcfcfb; --surface-2: #efeeea; --border: #e2e1dc;\n  --text: #0b0b0b; --text-2: #52514d; --text-3: #8a8984;\n  --bar: #2a78d6; --bar-2: #9ec1ec; --grid: #e7e6e1;\n  --good: #1f8a4c; --warn: #b7791f; --crit: #c53030;\n  --font: system-ui, -apple-system, \"Hiragino Sans\", \"Noto Sans JP\", sans-serif;\n}\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n    color-scheme: dark;\n    --bg: #111110; --surface: #1a1a19; --surface-2: #242422; --border: #2e2e2b;\n    --text: #f0efec; --text-2: #b5b4ae; --text-3: #7d7c77;\n    --bar: #3987e5; --bar-2: #2c5a93; --grid: #2a2a28;\n    --good: #48bb78; --warn: #ecc94b; --crit: #fc8181;\n  }\n}\n:root[data-theme=\"dark\"] {\n  color-scheme: dark;\n  --bg: #111110; --surface: #1a1a19; --surface-2: #242422; --border: #2e2e2b;\n  --text: #f0efec; --text-2: #b5b4ae; --text-3: #7d7c77;\n  --bar: #3987e5; --bar-2: #2c5a93; --grid: #2a2a28;\n  --good: #48bb78; --warn: #ecc94b; --crit: #fc8181;\n}\n* { box-sizing: border-box; }\n[hidden] { display: none !important; }\nbody { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; }\n.wrap { max-width: 960px; margin: 0 auto; padding: 12px 16px 40px; }\nh1 { font-size: 18px; margin: 4px 0 2px; }\nh1 .ver { font-size: 12px; font-weight: 400; color: var(--text-3); margin-left: 6px; font-variant-numeric: tabular-nums; }\n.sub { color: var(--text-2); font-size: 12px; }\n.bar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }\n.seg { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 2px; }\n.seg button { border: 0; background: none; padding: 6px 10px; border-radius: 8px; font: inherit; font-size: 13px; color: var(--text-2); cursor: pointer; }\n.seg button[aria-pressed=\"true\"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.08); }\n.btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 10px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }\n.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 8px 0 14px; }\n.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 10px 12px; }\n.tile .k { font-size: 12px; color: var(--text-2); }\n.tile .v { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }\n.tile .v small { font-size: 13px; font-weight: 500; color: var(--text-2); margin-left: 2px; }\n.tile .s { font-size: 11px; color: var(--text-3); margin-top: 2px; }\n.meter { height: 6px; border-radius: 3px; background: var(--surface-2); margin-top: 6px; overflow: hidden; }\n.meter i { display: block; height: 100%; border-radius: 3px; background: var(--good); }\n.status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; margin-top: 4px; }\n.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }\n.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 12px; margin-bottom: 10px; min-width: 0; }\n.card h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: baseline; }\n.card h2 span { font-size: 11px; font-weight: 400; color: var(--text-3); }\nsvg.chart { width: 100%; height: 180px; display: block; }\nsvg.chart text { font-size: 10px; fill: var(--text-3); font-family: var(--font); }\n.hbar { display: grid; grid-template-columns: minmax(0, 1fr) 2fr auto; align-items: center; gap: 8px; font-size: 13px; padding: 3px 0; }\n.hbar .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.hbar .t { height: 10px; background: var(--surface-2); border-radius: 0 4px 4px 0; }\n.hbar .t i { display: block; height: 100%; background: var(--bar); border-radius: 0 4px 4px 0; min-width: 2px; }\n.hbar .c { font-variant-numeric: tabular-nums; color: var(--text-2); min-width: 3em; text-align: right; }\n.empty { color: var(--text-3); font-size: 13px; padding: 8px 0; }\ntable.sites { width: 100%; border-collapse: collapse; font-size: 13px; }\ntable.sites th, table.sites td { padding: 6px 6px; border-bottom: 1px solid var(--border); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }\ntable.sites th { font-size: 11px; font-weight: 600; color: var(--text-2); }\ntable.sites th:first-child, table.sites td:first-child { text-align: left; white-space: normal; }\ntable.sites td small { display: block; color: var(--text-3); font-size: 11px; }\ntable.sites .bar { width: 30%; }\ntable.sites .bar i { display: block; height: 8px; background: var(--bar); border-radius: 0 3px 3px 0; min-width: 2px; }\n.sites-wrap { overflow-x: auto; }\ntable.errs td:first-child { overflow-wrap: anywhere; word-break: break-word; }\n#tip { position: fixed; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.15); display: none; z-index: 9; white-space: nowrap; }\n.msg { color: var(--crit); font-size: 13px; margin: 8px 0; }\n.tiles.mini { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); margin: 0; }\n.tiles.mini .tile { background: var(--surface-2); border: 0; }\n.tiles.mini .v { font-size: 18px; }\n.h3 { font-size: 13px; margin: 14px 0 4px; color: var(--text-2); }\n.lg { display: inline-flex; gap: 6px; align-items: center; }\n.lg i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }\n.ok { color: var(--good); } .warn { color: var(--warn); } .crit { color: var(--crit); }\n.muted td { color: var(--text-3); }\n.env .card { margin: 0; padding: 0; border: 0; background: none; }\n.env h4 { font-size: 12px; margin: 4px 0; color: var(--text-2); }\n.form { display: grid; gap: 8px; font-size: 13px; }\n.form input[type=email] { width: 100%; margin-top: 4px; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: inherit; }\n.alog { font-size: 12px; border-bottom: 1px solid var(--border); padding: 6px 0; }\n.alog b { margin-right: 6px; }\n.alog .t { color: var(--text-3); margin-right: 6px; font-variant-numeric: tabular-nums; }\n.note { font-size: 11px; color: var(--text-3); line-height: 1.6; margin-top: 14px; }\n.live { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }\n.live .v { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }\n.live .v small { font-size: 14px; font-weight: 500; color: var(--text-2); margin-left: 2px; }\n.live .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--good); box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 25%, transparent); }\n.live .s { font-size: 12px; color: var(--text-3); }\n/* いま使っている人の推移（オシロスコープ風。画面は明るい・暗い表示どちらでも暗い計器の見た目） */\n.scope-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 12px 0 8px; }\n.scope-read { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }\n.scope { --sc-bg: #07120d; --sc-grid: rgba(90, 255, 170, .10); --sc-axis: rgba(90, 255, 170, .26); --sc-trace: #57ffa8; --sc-text: rgba(170, 255, 210, .72);\n  position: relative; height: 210px; border-radius: 10px; overflow: hidden; background: radial-gradient(ellipse at center, #0c1f16 0%, var(--sc-bg) 75%);\n  box-shadow: inset 0 0 0 1px rgba(90, 255, 170, .18), inset 0 0 24px rgba(0, 0, 0, .7); touch-action: pan-y; }\n.scope svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }\n.scope .g { stroke: var(--sc-grid); stroke-width: 1; }\n.scope .a { stroke: var(--sc-axis); stroke-width: 1; stroke-dasharray: 2 3; }\n.scope .tr { fill: none; stroke: var(--sc-trace); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }\n.scope .lb { fill: var(--sc-text); font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }\n.scope .hd { fill: var(--sc-trace); }\n.scope .pulse { fill: var(--sc-trace); opacity: .35; animation: sc-pulse 1.6s ease-out infinite; transform-box: fill-box; transform-origin: center; }\n.scope .cur { stroke: rgba(170, 255, 210, .5); stroke-width: 1; }\n.scope .scan { position: absolute; top: 0; bottom: 0; width: 60px; left: -60px; background: linear-gradient(90deg, transparent, rgba(90, 255, 170, .07)); animation: sc-scan 6s linear infinite; pointer-events: none; }\n.scope .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--sc-text); font-size: 12px; }\n@keyframes sc-pulse { from { transform: scale(1); opacity: .5; } to { transform: scale(3.2); opacity: 0; } }\n@keyframes sc-scan { to { left: 100%; } }\n@media (prefers-reduced-motion: reduce) { .scope .pulse, .scope .scan { animation: none; display: none; } }\n</style>\n</head>\n<body data-key=\"<?= adminKey ?>\">\n<div class=\"wrap\">\n  <h1>my tide-graph 利用状況 <span class=\"ver\" id=\"ver\"></span></h1>\n  <div class=\"sub\" id=\"upd\">読み込み中…</div>\n  <div class=\"bar-row\">\n    <div class=\"seg\" id=\"daysSeg\" role=\"group\" aria-label=\"期間\">\n      <button data-h=\"6\" aria-pressed=\"false\">6時間</button>\n      <button data-h=\"12\" aria-pressed=\"false\">12時間</button>\n      <button data-h=\"24\" aria-pressed=\"false\">1日</button>\n      <button data-d=\"7\" aria-pressed=\"false\">7日</button>\n      <button data-d=\"30\" aria-pressed=\"true\">30日</button>\n      <button data-d=\"90\" aria-pressed=\"false\">90日</button>\n    </div>\n    <button class=\"btn\" id=\"flushBtn\">今すぐ集計</button>\n    <button class=\"btn\" id=\"reloadBtn\">再読み込み</button>\n    <button class=\"btn\" id=\"copyBtn\" title=\"今の期間の要約を文章でコピー\">要約をコピー</button>\n    <a class=\"btn\" id=\"sheetLink\" href=\"#\" target=\"_blank\" rel=\"noopener\" hidden>スプレッドシート</a>\n  </div>\n  <div class=\"msg\" id=\"msg\" hidden></div>\n\n  <div class=\"card\" id=\"liveCard\" hidden><h2>いま使っている人 <span id=\"liveSub\"></span></h2>\n    <div class=\"live\"><span class=\"dot\" aria-hidden=\"true\"></span><div class=\"v\" id=\"liveN\">--<small>人</small></div><div class=\"s\" id=\"liveNote\"></div></div>\n    <div class=\"scope-bar\">\n      <div class=\"seg\" id=\"scopeSeg\" role=\"group\" aria-label=\"グラフの範囲\">\n        <button data-m=\"30\" aria-pressed=\"false\">30分</button>\n        <button data-m=\"180\" aria-pressed=\"true\">3時間</button>\n        <button data-m=\"1440\" aria-pressed=\"false\">24時間</button>\n      </div>\n      <div class=\"scope-read\" id=\"scopeRead\"></div>\n    </div>\n    <div class=\"scope\" id=\"scope\" role=\"img\" aria-label=\"いま使っている人の数の推移\"><svg id=\"scopeSvg\"></svg><div class=\"scan\" aria-hidden=\"true\"></div></div>\n  </div>\n  <div class=\"card\"><h2>監視の状態 <span id=\"healthSub\"></span></h2><div class=\"tiles mini\" id=\"health\"></div></div>\n  <div class=\"card\"><h2>データ元の異常 <span>回（404 は普段から起きるため薄く表示）</span></h2><div id=\"tFails\"></div>\n    <h3 class=\"h3\">画面で見つかったデータの異常</h3><div id=\"tQuality\"></div></div>\n\n  <div class=\"tiles\" id=\"tiles\"></div>\n\n  <div class=\"grid2\">\n    <div class=\"card\"><h2 id=\"pvTitle\">日ごとの表示回数 <span>回</span></h2><svg class=\"chart\" id=\"cPv\"></svg></div>\n    <div class=\"card\"><h2><span id=\"usersTitle\" style=\"font-size:14px;font-weight:700;color:var(--text)\">日ごとの利用者数</span> <span class=\"lg\"><i style=\"background:var(--bar)\"></i>再訪 <i style=\"background:var(--bar-2)\"></i>新規</span></h2><svg class=\"chart\" id=\"cUsers\"></svg></div>\n    <div class=\"card\" id=\"hourCard\"><h2>時間帯別の表示回数（期間合計） <span>回</span></h2><svg class=\"chart\" id=\"cHour\"></svg></div>\n    <div class=\"card\"><h2 id=\"ufTitle\">日ごとの URL Fetch 回数 <span>回（点線は1日の上限）</span></h2><svg class=\"chart\" id=\"cUf\"></svg></div>\n  </div>\n  <div class=\"grid2\">\n    <div class=\"card\"><h2>よく使われる潮位観測所 <span>回</span></h2><div id=\"tStations\"></div></div>\n    <div class=\"card\"><h2>よく使われる地域（約10km） <span>回</span></h2><div id=\"tAreas\"></div></div>\n    <div class=\"card\"><h2>機能の利用 <span>回</span></h2><div id=\"tFeatures\"></div></div>\n  </div>\n  <div class=\"card\"><h2>表示の速さ <span id=\"perfSub\">利用者の端末で計測（サーバーは Apps Script の処理時間）</span></h2><div id=\"tPerf\"></div></div>\n  <div class=\"card\"><h2>エラー <span>件</span></h2><div id=\"tErrors\"></div></div>\n  <div class=\"card\"><h2>外部サイトへのアクセス（期間合計） <span>回</span></h2><div id=\"tSites\"></div></div>\n  <div class=\"grid2\">\n    <div class=\"card\"><h2>流入元（どこから開いたか） <span>回</span></h2><div id=\"tRefs\"></div></div>\n    <div class=\"card\"><h2>位置情報（GPS）が使えたか <span>起動時</span></h2><div id=\"tGeo\"></div></div>\n  </div>\n  <div class=\"card\"><h2>利用環境 <span>表示回数</span></h2><div class=\"grid2 env\" id=\"tEnv\"></div></div>\n  <div class=\"grid2\" id=\"alertsArea\">\n    <div class=\"card\"><h2>通知の設定</h2>\n      <div class=\"form\">\n        <label><input type=\"checkbox\" id=\"alOn\"> 異常があればメールで知らせる（15分ごとに確認）</label>\n        <label><input type=\"checkbox\" id=\"alDaily\"> 毎朝7時ごろに前日の要約を送る</label>\n        <label>通知先 <input type=\"email\" id=\"alTo\" placeholder=\"空欄なら Apps Script の持ち主のアドレス\"></label>\n        <div class=\"bar-row\"><button class=\"btn\" id=\"alSave\">保存</button><button class=\"btn\" id=\"alTest\">テストメールを送る</button><span class=\"sub\" id=\"alMsg\"></span></div>\n      </div>\n    </div>\n    <div class=\"card\"><h2>最近の通知 <span>最大20件</span></h2><div id=\"tAlerts\"></div></div>\n  </div>\n  <p class=\"note\" id=\"cfNote\" hidden>\n    この画面は Cloudflare（v2.1.0 以降の記録）です。記録は利用者の呼び出しごとに保存し、終わった時間帯は1時間1行にまとめます（この画面を開いたときにも実行）。\n    「外部サイトからの取得」は Cloudflare Workers が気象庁・海上保安庁などから取得した回数です（Google の URL Fetch のような1日の上限はありません。全国共有のキャッシュや Cloudflare の配信網に一時保存されていた分から返したものは、相手サイトに届いていないので数えません。2026/10/20 午前までの記録は配信網から返した分も含みます）。\n    記録は v2.1.0（2026/10/20 朝）からです。それより前の Apps Script での記録は引き継いでいないため、以前からの利用者も最初の日は「新規」として数えます。\n    利用者数は端末ごとの匿名IDの数です（ブラウザのデータを消すと別の人として数えます）。地域は約10km単位に丸めた位置で、名前は国土地理院の逆ジオコーダで求めた目安です。\n    エラーの「画面」は利用者の端末でデータを受け取れなかった回数（通信の切れ目なども含む）、「サーバー」は Workers での処理の失敗です。データ元の異常の「net」はブラウザの通信の失敗です（利用者側の電波の弱さでも起きます）。\n    表示の速さの「起動〜表示」は、ページを開いてから潮位のグラフが出るまでの時間です。\n    流入元はページを開いたときの直前のページのサイト名です。X や LINE のアプリ内から開いた場合は「直接」になることがあります。リンクに ?from=名前 を付けると、その名前で数えます。\n  </p>\n  <p class=\"note\" id=\"gasNote\">\n    データは1時間ごとにスプレッドシートへ集計されます（今の1時間の分も含めて表示）。利用者数は端末ごとの匿名IDの数です（ブラウザのデータを消すと別の人として数えます）。\n    地域は約10km単位に丸めた位置で、名前は国土地理院の逆ジオコーダで求めた目安です。\n    エラーの「画面」は利用者の端末でデータを受け取れなかった回数（通信の切れ目なども含む）、「サーバー」は Apps Script での処理の失敗です。\n    外部サイトの「サーバーから」は Apps Script の URL Fetch（1日の上限に数える）、「ブラウザから」は利用者の端末からの取得です（上限には数えない。地図タイルは端末ごとに初回のみ数える）。\n    データ元の異常の「ex」はサーバーからの通信の失敗・時間切れ、「net」はブラウザの通信の失敗です（利用者側の電波の弱さでも起きます）。\n    表示の速さの「起動〜表示」は、ページを開いてから潮位のグラフが出るまでの時間です。\n    流入元はページを開いたときの直前のページのサイト名です。X や LINE のアプリ内から開いた場合は「直接」になることがあります。リンクに ?from=名前 を付けると、その名前で数えます。\n  </p>\n</div>\n<div id=\"tip\"></div>\n<script>\n(function () {\n  'use strict';\n  var KEY = document.body.dataset.key, DAYS = 30, HOURS = 0, D = null;   // HOURS：時間単位の期間（0 なら日単位）\n  var FEATURES = {\n    guide_open: '利用ガイドを開く', catch_open: '釣果の記録を開く', catch_share: '釣果：写真と文章を共有', catch_copy: '釣果：投稿文をコピー',\n    catch_cal: '釣果：Googleカレンダー', catch_savephoto: '釣果：写真を保存', today_btn: '今日に戻る', prev_day: '前日へ', next_day: '翌日へ',\n    date_pick: 'カレンダーで日付選択', refresh_btn: '更新ボタン', loc_btn: '現在地ボタン', picker_open: '潮位観測所の一覧を開く',\n    picker_select: '潮位観測所を選ぶ', river_sel: '河川の水位観測所を選ぶ', river_list: '河川の水位観測所の一覧', 'river_1': '河川水位・水質：表示',\n    'river_0': '河川水位・水質：非表示', datum_table: '高さ：潮位表基準面', datum_tp: '高さ：TP', filter_all: '一覧：すべて', filter_jcg: '一覧：海保のみ',\n    picker_auto: '位置情報なしで一覧を自動で開いた', pred_sel: '推算の地点を手動で選ぶ', pred_auto: '推算の地点を自動に戻す', view_3d: '表示：3日', view_day: '表示：1日', view_h12: '表示：±12h', view_h6: '表示：±6h', view_h3: '表示：±3h', view_h1: '表示：±1h',\n    map_open: '地図を開く', map_place: '地図で地点を指定', map_tide: '地図で潮位観測所を選ぶ', map_pred: '地図で潮位表の地点を選ぶ', map_river: '地図で河川の水位観測所を選ぶ',\n    map_wq: '地図で水質観測所を選ぶ', catch_safe: '釣果記録のデータの扱いを読む', update_btn: '新しい版の「更新」を押した', map_gps: '地図で現在地に戻す', map_river_on: '地図から河川水位・水質を表示'\n  };\n  var SITES = {\n    'www.jma.go.jp': '気象庁（観測・予報）', 'www.data.jma.go.jp': '気象庁（潮位表）', 'www1.kaiho.mlit.go.jp': '海上保安庁（験潮）',\n    'www.river.go.jp': '川の防災情報', 'www.river.go.jp/gjson': '川の防災情報（町ごとの観測所）', 'www.river.go.jp/stg': '川の防災情報（水位）', 'www.river.go.jp/qwtr': '川の防災情報（水質）',\n    'www.river.go.jp/top': '川の防災情報（一覧用の最新値）', 'www.river.go.jp/twnlist': '川の防災情報（町ごとの水質観測所）', 'www.river.go.jp/master': '川の防災情報（観測所の情報）',\n    'www.river.go.jp/time': '川の防災情報（最新の観測時刻）', 'www.river.go.jp/map': '川の防災情報（市区町村の一覧）', 'www.river.go.jp/other': '川の防災情報（その他）',\n    'api.open-meteo.com': 'Open-Meteo（風・気圧）', 'marine-api.open-meteo.com': 'Open-Meteo Marine（海面水温）',\n    'mreversegeocoder.gsi.go.jp': '国土地理院（逆ジオコーダ）', 'msearch.gsi.go.jp': '国土地理院（住所検索）', 'cyberjapandata.gsi.go.jp': '国土地理院（地図タイル）',\n    'script.google.com': 'このアプリのサーバー（Apps Script）', 'tide-api.kotaro9.workers.dev': 'このアプリのサーバー（Cloudflare Workers）', 'tide-proxy': '中継（Cloudflare Workers）', 'www.tbeic.go.jp': '東京湾環境情報センター'\n  };\n  var REFS = {\n    direct: '直接（ブックマーク・URL入力・アプリ内ブラウザなど）', home_screen: 'ホーム画面のアイコン', gas: '旧URL（Apps Script の画面）',\n    't.co': 'X（t.co）', 'x.com': 'X', 'twitter.com': 'X', 'www.google.com': 'Google 検索', 'www.google.co.jp': 'Google 検索',\n    'line.me': 'LINE', 'l.facebook.com': 'Facebook', 'm.facebook.com': 'Facebook', 'www.instagram.com': 'Instagram', 'l.instagram.com': 'Instagram',\n    'search.yahoo.co.jp': 'Yahoo! 検索', 'www.bing.com': 'Bing', 'github.com': 'GitHub'\n  };\n  function refName(k) { return REFS[k] || (/^from:/.test(k) ? 'リンクの指定（from=' + k.slice(5) + '）' : k); }\n  function $(id) { return document.getElementById(id); }\n  function esc(s) { return String(s).replace(/[&<>\"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]; }); }\n  function n(v) { return Math.round(v).toLocaleString('ja-JP'); }\n  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }\n  // 呼び出し：Apps Script の画面なら google.script.run、Cloudflare の画面なら /admin/api\n  var CF = !(window.google && google.script && google.script.run);\n  function call(fn) {\n    var args = Array.prototype.slice.call(arguments, 1);\n    if (CF) {\n      return fetch('/admin/api', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: args }) })\n        .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error); return j.result; });\n    }\n    return new Promise(function (res, rej) { var r = google.script.run.withSuccessHandler(res).withFailureHandler(rej); r[fn].apply(r, args); });\n  }\n  function msg(t) { $('msg').hidden = !t; $('msg').textContent = t || ''; }\n\n  function ymd(ms) { var d = new Date(ms + 9 * 3600e3); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }\n  function dayList() { var out = [], now = D.now; for (var i = DAYS - 1; i >= 0; i--) out.push(ymd(now - i * 86400e3)); return out; }\n  // 時間単位の期間：'YYYY-MM-DD HH'（JST）の並び\n  function hk(ms) { var d = new Date(ms + 9 * 3600e3); return ymd(ms) + ' ' + ('0' + d.getUTCHours()).slice(-2); }\n  function hourList() { var out = [], now = D.now; for (var i = D.hours - 1; i >= 0; i--) out.push(hk(now - i * 3600e3)); return out; }\n  function byHour() { return !!(D && D.hours); }\n\n  // 集計済み（スプレッドシート）と未集計（今の1時間など）を合わせる\n  function aggregate() {\n    var hm = byHour(), days = hm ? hourList() : dayList(), byDay = {}, hours = new Array(24).fill(0), users = {}, all = {};\n    var key = function (h) { return hm ? h.slice(0, 13) : h.slice(0, 10); };\n    days.forEach(function (d) { byDay[d] = { pv: 0, uf: 0, lim: 0, serr: 0, cerr: 0 }; users[d] = {}; });\n    D.hourly.forEach(function (r) {\n      var d = key(r[0]), h = +r[0].slice(11, 13);\n      if (!byDay[d]) return;\n      byDay[d].pv += r[1]; byDay[d].uf += r[3]; byDay[d].lim += r[4]; byDay[d].serr += r[5]; byDay[d].cerr += r[6];\n      hours[h] += r[1];\n    });\n    D.users.forEach(function (r) { if (users[r[0]]) { users[r[0]][r[1]] = 1; all[r[1]] = 1; } });\n    var st = Object.assign({}, D.stations), ar = Object.assign({}, D.areas), fe = Object.assign({}, D.features), er = Object.assign({}, D.errors);\n    var si = {}, rf = Object.assign({}, D.referrers || {});\n    var fa = Object.assign({}, D.failures || {}), qa = Object.assign({}, D.quality || {}), en = Object.assign({}, D.env || {}), ge = Object.assign({}, D.geo || {});\n    var pf = {}, alive = 0, pvAll = 0;\n    var addPerf = function (src) { Object.keys(src || {}).forEach(function (k) { var x = pf[k] || (pf[k] = [0, 0, 0, 0, 0, 0, 0]), p = src[k]; x[0] += p[0]; x[1] += p[1]; x[2] = Math.max(x[2], p[2]); for (var i = 3; i < 7; i++) x[i] += p[i]; }); };\n    addPerf(D.perf);\n    D.hourly.forEach(function (r) { if (byDay[key(r[0])]) { alive += r[7] || 0; pvAll += r[1]; } });\n    Object.keys(D.sites || {}).forEach(function (k) { si[k] = { sv: D.sites[k].sv, cl: D.sites[k].cl }; });\n    var add = function (o, src, pre) { Object.keys(src || {}).forEach(function (k) { var kk = (pre || '') + k; o[kk] = (o[kk] || 0) + src[k]; }); };\n    D.pending.forEach(function (p) {\n      var d = key(p.hour), h = +p.hour.slice(11, 13);\n      if (!byDay[d]) return;\n      byDay[d].pv += p.pv; byDay[d].lim += p.lim; byDay[d].serr += p.serr; byDay[d].cerr += p.cerr;\n      hours[h] += p.pv;\n      p.ids.forEach(function (a) { users[d][a] = 1; all[a] = 1; });\n      add(st, p.st); add(ar, p.area); add(fe, p.f); add(rf, p.ref);\n      Object.keys(p.sv || {}).forEach(function (k) { (si[k] = si[k] || { sv: 0, cl: 0 }).sv += p.sv[k]; });\n      Object.keys(p.cl || {}).forEach(function (k) { (si[k] = si[k] || { sv: 0, cl: 0 }).cl += p.cl[k]; });\n      Object.keys(p.err || {}).forEach(function (k) { er[k] = (er[k] || 0) + p.err[k]; });\n      Object.keys(p.svf || {}).forEach(function (k) { var kk = 'server|' + k; fa[kk] = (fa[kk] || 0) + p.svf[k]; });\n      Object.keys(p.clf || {}).forEach(function (k) { var kk = 'client|' + k; fa[kk] = (fa[kk] || 0) + p.clf[k]; });\n      add(qa, p.q); add(en, p.env); add(ge, p.geo); addPerf(p.perf);\n      alive += p.alive || 0; pvAll += p.pv;\n    });\n    // 今日の URL Fetch は日ごとの実数（未集計の時間を含む）\n    var today = ymd(D.now);\n    if (byDay[today]) byDay[today].uf = Math.max(byDay[today].uf, D.ufToday);\n    // 新規・再訪（匿名IDが初めて現れた日がその日なら新規）\n    var newRet = days.map(function (d) {\n      var dd = d.slice(0, 10), ids = Object.keys(users[d]), nw = ids.filter(function (a) { return (D.firstSeen[a] || dd) >= dd; }).length;\n      return [nw, ids.length - nw];\n    });\n    return { days: days, byDay: byDay, hours: hours, users: users, allUsers: Object.keys(all).length, st: st, ar: ar, fe: fe, er: er, si: si, rf: rf,\n      fa: fa, qa: qa, en: en, ge: ge, pf: pf, alive: alive, pvAll: pvAll, newRet: newRet };\n  }\n\n  // 時間単位の期間で、今日初めて現れた人（重複なし）\n  function newToday(A) {\n    var today = ymd(D.now), seen = {};\n    A.days.forEach(function (d) { Object.keys(A.users[d] || {}).forEach(function (a) { if ((D.firstSeen[a] || today) >= today) seen[a] = 1; }); });\n    return Object.keys(seen).length;\n  }\n  function tiles(A) {\n    var today = ymd(D.now), hm = byHour(), sum = function (k) { return A.days.reduce(function (s, d) { return s + A.byDay[d][k]; }, 0); };\n    var t = hm ? { pv: sum('pv') } : A.byDay[today], tUsers = hm ? A.allUsers : Object.keys(A.users[today]).length, per = hm ? '直近' + D.hours + '時間の' : '今日の';\n    var dayPct = D.limits ? D.ufToday / D.limits.day : 0, hourPct = D.limits ? D.ufHour / D.limits.hour : 0;\n    var level = function (p) { return p >= .9 ? ['--crit', '⛔ 上限間近'] : p >= .6 ? ['--warn', '⚠ 注意'] : ['--good', '✓ 余裕あり']; };\n    var meter = function (p) { var l = level(p); return '<div class=\"meter\"><i style=\"width:' + Math.min(100, p * 100).toFixed(1) + '%;background:var(' + l[0] + ')\"></i></div><div class=\"status\" style=\"color:var(' + l[0] + ')\">' + l[1] + '</div>'; };\n    $('tiles').innerHTML = [\n      '<div class=\"tile\"><div class=\"k\">' + per + '表示回数</div><div class=\"v\">' + n(t.pv) + '<small>回</small></div><div class=\"s\">' + (hm ? '1時間あたり ' + (sum('pv') / D.hours).toFixed(1) + ' 回' : '期間合計 ' + n(sum('pv')) + ' 回') + '</div></div>',\n      '<div class=\"tile\"><div class=\"k\">' + per + '利用者数</div><div class=\"v\">' + n(tUsers) + '<small>人</small></div><div class=\"s\">' + (hm ? 'うち今日初めて ' + n(newToday(A)) + ' 人' : '期間の延べ ' + n(A.allUsers) + ' 人') + '</div></div>',\n      D.limits ? '<div class=\"tile\"><div class=\"k\">今日の URL Fetch</div><div class=\"v\">' + n(D.ufToday) + '<small>/ ' + n(D.limits.day) + '</small></div>' + meter(dayPct) + '</div>' :\n        '<div class=\"tile\"><div class=\"k\">今日の外部サイトからの取得</div><div class=\"v\">' + n(D.ufToday) + '<small>回</small></div><div class=\"s\">Cloudflare Workers から（上限なし）</div></div>',\n      D.limits ? '<div class=\"tile\"><div class=\"k\">この1時間の URL Fetch</div><div class=\"v\">' + n(D.ufHour) + '<small>/ ' + n(D.limits.hour) + '</small></div>' + meter(hourPct) + '</div>' :\n        '<div class=\"tile\"><div class=\"k\">この1時間の外部サイトからの取得</div><div class=\"v\">' + n(D.ufHour) + '<small>回</small></div></div>',\n      '<div class=\"tile\"><div class=\"k\">上限超え（期間）</div><div class=\"v\">' + n(sum('lim')) + '<small>回</small></div><div class=\"s\">アクセス集中で断った回数</div></div>',\n      '<div class=\"tile\"><div class=\"k\">開いている時間（平均）</div><div class=\"v\">' + (A.pvAll ? (5 + A.alive * 5 / A.pvAll).toFixed(0) : '--') + '<small>分くらい</small></div><div class=\"s\">自動更新の回数からの目安</div></div>',\n      '<div class=\"tile\"><div class=\"k\">エラー（期間）</div><div class=\"v\">' + n(sum('serr') + sum('cerr')) + '<small>件</small></div><div class=\"s\">サーバー ' + n(sum('serr')) + ' / 画面 ' + n(sum('cerr')) + '</div></div>'\n    ].join('');\n  }\n\n  // 縦棒グラフ（1系列・1軸）。ホバー／タップで値\n  function bars(svg, labels, values, opt) {\n    opt = opt || {};\n    var W = svg.clientWidth || 300, H = svg.clientHeight || 180, L = 36, R = 6, T = 8, B = 20;\n    var tot = values.map(function (v) { return Array.isArray(v) ? v[0] + v[1] : v; });\n    var max = Math.max(opt.limit || 0, Math.max.apply(null, tot.concat([1])));\n    var step = Math.pow(10, Math.floor(Math.log10(max))), nice = Math.ceil(max / step) * step;\n    if (nice / step > 5) step *= 2; else if (nice / step <= 2) step /= 2;\n    step = Math.max(1, step);   // 回数・人数は整数\n    nice = Math.ceil(max / step) * step;\n    var bw = (W - L - R) / values.length, y = function (v) { return T + (1 - v / nice) * (H - T - B); };\n    var h = '';\n    for (var v = 0; v <= nice + 1e-9; v += step) {\n      h += '<line x1=\"' + L + '\" x2=\"' + (W - R) + '\" y1=\"' + y(v) + '\" y2=\"' + y(v) + '\" stroke=\"' + css(v ? '--grid' : '--text-3') + '\"/>';\n      h += '<text x=\"' + (L - 4) + '\" y=\"' + (y(v) + 3) + '\" text-anchor=\"end\">' + n(v) + '</text>';\n    }\n    var every = Math.ceil(values.length / (opt.ticks || 7));\n    values.forEach(function (v, i) {\n      var x = L + i * bw, w = Math.max(1, bw - 2), sv = Array.isArray(v) ? v : [0, v], total = sv[0] + sv[1], top = y(total);\n      // 下に再訪（濃い色）、上に新規（薄い色）。間に2pxのすき間\n      if (sv[1] > 0) h += '<path d=\"M' + (x + 1) + ',' + y(0) + 'V' + (y(sv[1]) + (sv[0] ? 0 : 2)) + (sv[0] ? 'h' + w : 'q0,-2 2,-2h' + Math.max(0, w - 4) + 'q2,0 2,2') + 'V' + y(0) + 'Z\" fill=\"' + css('--bar') + '\"/>';\n      if (sv[0] > 0) { var b0 = sv[1] > 0 ? y(sv[1]) - 2 : y(0); h += '<path d=\"M' + (x + 1) + ',' + b0 + 'V' + (top + 2) + 'q0,-2 2,-2h' + Math.max(0, w - 4) + 'q2,0 2,2V' + b0 + 'Z\" fill=\"' + css(Array.isArray(v) ? '--bar-2' : '--bar') + '\"/>'; }\n      h += '<rect class=\"hit\" x=\"' + x + '\" y=\"' + T + '\" width=\"' + bw + '\" height=\"' + (H - T - B) + '\" fill=\"transparent\" data-l=\"' + esc(labels[i]) + '\" data-v=\"' + total + '\"' +\n        (Array.isArray(v) ? ' data-x=\"（新規 ' + sv[0] + '・再訪 ' + sv[1] + '）\"' : '') + '/>';\n      if (i % every === 0) h += '<text x=\"' + (x + bw / 2) + '\" y=\"' + (H - 6) + '\" text-anchor=\"middle\">' + esc(opt.short ? opt.short(labels[i], i) : labels[i]) + '</text>';\n    });\n    if (opt.limit) h += '<line x1=\"' + L + '\" x2=\"' + (W - R) + '\" y1=\"' + y(opt.limit) + '\" y2=\"' + y(opt.limit) + '\" stroke=\"' + css('--crit') + '\" stroke-dasharray=\"4 3\"/>';\n    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);\n    svg.innerHTML = h;\n    svg.dataset.unit = opt.unit || '';\n  }\n  document.addEventListener('pointermove', tipAt);\n  document.addEventListener('pointerdown', tipAt);\n  function tipAt(ev) {\n    var el = ev.target, tip = $('tip');\n    if (!el.classList || !el.classList.contains('hit')) { tip.style.display = 'none'; return; }\n    tip.innerHTML = '<b>' + esc(el.dataset.l) + '</b> ' + n(+el.dataset.v) + ' ' + esc(el.ownerSVGElement.dataset.unit) + esc(el.dataset.x || '');\n    tip.style.display = 'block';\n    var x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);\n    tip.style.left = x + 'px'; tip.style.top = (ev.clientY - 34) + 'px';\n  }\n\n  // 横棒の上位一覧\n  function hlist(el, obj, name, max) {\n    var rows = Object.keys(obj).map(function (k) { return [k, obj[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, max || 10);\n    if (!rows.length) { el.innerHTML = '<div class=\"empty\">まだデータがありません</div>'; return; }\n    var top = rows[0][1];\n    el.innerHTML = rows.map(function (r) {\n      return '<div class=\"hbar\"><span class=\"n\" title=\"' + esc(name(r[0])) + '\" data-k=\"' + esc(r[0]) + '\">' + esc(name(r[0])) + '</span><span class=\"t\"><i style=\"width:' + (r[1] / top * 100).toFixed(1) + '%\"></i></span><span class=\"c\">' + n(r[1]) + '</span></div>';\n    }).join('');\n  }\n  // エラー：種類（画面／サーバー）・内容・件数。内容は折り返して全文を出す\n  var ERRS = {\n    getPressure: '気圧', getPredPoints: '推算の地点の一覧',\n    getTideData: '潮位データの取得', getStations: '潮位観測所の一覧', getWeather: '天気・気温', getWind: '風の推移・予報',\n    getRiver: '河川水位', getRiverStations: '河川の水位観測所の一覧', getWaterQuality: '水質', getWQStations: '水質観測所の一覧'\n  };\n  function errorsTable(el, er) {\n    var rows = Object.keys(er).map(function (k) { var i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1), er[k]]; })\n      .sort(function (a, b) { return b[2] - a[2]; });\n    if (!rows.length) { el.innerHTML = '<div class=\"empty\">エラーはありません</div>'; return; }\n    el.innerHTML = '<div class=\"sites-wrap\"><table class=\"sites errs\"><thead><tr><th>内容</th><th>種類</th><th>件数</th></tr></thead><tbody>' +\n      rows.map(function (r) {\n        return '<tr><td>' + esc(ERRS[r[1]] ? ERRS[r[1]] + 'に失敗' : r[1]) + '<small>' + esc(r[1]) + '</small></td><td>' +\n          (r[0] === 'server' ? 'サーバー' : r[0] === 'client' ? '画面' : esc(r[0])) + '</td><td>' + n(r[2]) + '</td></tr>';\n      }).join('') + '</tbody></table></div>';\n  }\n  // 監視そのものの状態\n  function healthTiles() {\n    var h = D.health || {}, now = D.now, lf = h.lastFlush;\n    var ago = lf ? Math.round((now - lf.t) / 60000) : null;\n    var st = function (cls, t) { return '<div class=\"status ' + cls + '\">' + t + '</div>'; };\n    if (D.source === 'cloudflare') {\n      var mb = h.dbBytes != null ? h.dbBytes / 1048576 : null;\n      $('health').innerHTML = [\n        '<div class=\"tile\"><div class=\"k\">記録の保存先</div><div class=\"v\">D1</div>' + st('ok', '✓ Cloudflare') + '</div>',\n        '<div class=\"tile\"><div class=\"k\">最後のまとめ</div><div class=\"v\">' + (ago == null ? '--' : ago + '<small>分前</small>') + '</div>' +\n          (ago == null ? st('warn', '⚠ まだまとめていません') : st('ok', '✓ 開いたときにも実行')) + '</div>',\n        '<div class=\"tile\"><div class=\"k\">未まとめの記録</div><div class=\"v\">' + n(h.rawRows || 0) + '<small>行</small></div>' +\n          ((h.rawRows || 0) > 200000 ? st('warn', '⚠ 多め（「今すぐ集計」）') : st('ok', '✓ 問題なし')) + '</div>',\n        '<div class=\"tile\"><div class=\"k\">D1 の使用量</div><div class=\"v\">' + (mb == null ? '--' : mb.toFixed(1) + '<small>MB</small>') + '</div>' +\n          (mb != null && mb > 5000 ? st('warn', '⚠ 上限10GBの半分') : st('ok', '✓ 上限10GB')) + '</div>'\n      ].join('');\n      $('healthSub').textContent = '記録は呼び出しごと、終わった時間帯を1時間1行にまとめる';\n      return;\n    }\n    var pend = D.pending.reduce(function (s, p) { return s + (p.bytes || 0); }, 0);\n    var cells = h.cells || 0;\n    $('health').innerHTML = [\n      '<div class=\"tile\"><div class=\"k\">最後の集計</div><div class=\"v\">' + (ago == null ? '--' : ago + '<small>分前</small>') + '</div>' +\n        (ago == null ? st('warn', '⚠ まだ集計されていません') : ago <= 30 ? st('ok', '✓ 正常（15分ごと）') : st('crit', '⛔ 遅れています')) + '</div>',\n      '<div class=\"tile\"><div class=\"k\">集計のトリガー</div><div class=\"v\">' + (h.trigger ? 'あり' : h.trigger === false ? 'なし' : '--') + '</div>' +\n        (h.trigger ? st('ok', '✓ 動作中') : st('crit', '⛔ setupMonitor を実行')) + '</div>',\n      '<div class=\"tile\"><div class=\"k\">取りこぼし（今日）</div><div class=\"v\">' + n(h.dropToday || 0) + '<small>件</small></div>' +\n        (h.dropToday ? st('warn', '⚠ 混雑で記録できなかった') : st('ok', '✓ なし')) + '</div>',\n      '<div class=\"tile\"><div class=\"k\">未集計の一時保存</div><div class=\"v\">' + (pend / 1024).toFixed(0) + '<small>KB</small></div>' +\n        (D.pending.some(function (p) { return p.bytes > 80000; }) ? st('warn', '⚠ 1時間分が上限100KBに近い') : st('ok', '✓ 余裕あり')) + '</div>',\n      '<div class=\"tile\"><div class=\"k\">スプレッドシート</div><div class=\"v\">' + (cells / 10000).toFixed(1) + '<small>万セル</small></div>' +\n        (cells > 5e6 ? st('warn', '⚠ 上限1000万セルの半分') : st('ok', '✓ 上限1000万セル')) + '</div>',\n      '<div class=\"tile\"><div class=\"k\">メール通知</div><div class=\"v\">' + (h.alerts ? 'オン' : 'オフ') + '</div>' +\n        (h.alerts && h.alertTo ? st('ok', '✓ ' + esc(h.alertTo)) : st('warn', '⚠ 通知されません')) + '</div>'\n    ].join('');\n    $('healthSub').textContent = '15分ごとに集計・異常を確認';\n  }\n  // データ元の失敗：サイト × 場所・状態\n  function failsTable(el, fa, si) {\n    var by = {};\n    Object.keys(fa).forEach(function (k) {\n      var p = k.split('|'), x = by[p[1]] || (by[p[1]] = { server: {}, client: {}, total: 0, real: 0 });\n      x[p[0]][p[2]] = (x[p[0]][p[2]] || 0) + fa[k]; x.total += fa[k];\n      if (p[2] !== '404' && !(p[0] === 'client' && p[2] === 'net')) x.real += fa[k];\n    });\n    var rows = Object.keys(by).sort(function (a, b) { return by[b].real - by[a].real || by[b].total - by[a].total; });\n    if (!rows.length) { el.innerHTML = '<div class=\"empty\">取得の失敗はありません</div>'; return; }\n    var fmt = function (o) { return Object.keys(o).sort().map(function (k) { return k + '×' + n(o[k]); }).join('、') || '—'; };\n    el.innerHTML = '<div class=\"sites-wrap\"><table class=\"sites errs\"><thead><tr><th>サイト</th><th>サーバーから</th><th>ブラウザから</th><th>失敗の割合</th></tr></thead><tbody>' +\n      rows.map(function (h) {\n        var x = by[h], acc = si[h] ? si[h].sv + si[h].cl : 0, rate = acc ? x.real / acc : 0;\n        var cls = x.real === 0 ? ' class=\"muted\"' : '';\n        return '<tr' + cls + '><td>' + esc(SITES[h] || h) + '<small>' + esc(h) + '</small></td><td>' + esc(fmt(x.server)) + '</td><td>' + esc(fmt(x.client)) + '</td><td>' +\n          (acc ? '<span class=\"' + (rate >= .05 ? 'crit' : rate >= .01 ? 'warn' : 'ok') + '\">' + (rate * 100).toFixed(1) + '%</span>' : '—') + '</td></tr>';\n      }).join('') + '</tbody></table></div>';\n  }\n  function qualityName(k) {\n    var m = /^tide_stale:(\\d{6})$/.exec(k);\n    if (m) return '潮位の更新停止：' + (D.stationNames[m[1]] || m[1]);\n    if (k === 'urlfetch_quota') return 'Google の URL Fetch の上限に到達（非常時モード）';\n    if (k === 'river_paused') return '上限の手前で河川・水質を一時停止';\n    if (k === 'old_client_blocked') return '古い画面からの河川・海保の取得を止めた';\n    if (k === 'worker_fallback') return 'Cloudflare につながらず Apps Script に切り替えた';\n    m = /^near_outlier:(\\d{6})$/.exec(k);\n    if (m) return '近くの地点の偏差が異常なので使わなかった：' + (D.stationNames[m[1]] || m[1]);\n    m = /^tide_stuck:(\\d{6})$/.exec(k);\n    if (m) return '観測値が30分以上同じ値（機器の不調？）：' + (D.stationNames[m[1]] || m[1]);\n    m = /^river_nodata:(\\d+)$/.exec(k);\n    if (m) return '河川水位の欠測：観測所 ' + m[1];\n    return k;\n  }\n  // 表示の速さ：処理ごと\n  var PERFS = { load: '起動〜表示（グラフが出るまで）', getPressure: '気圧', getPredPoints: '推算の地点の一覧', getTideData: '潮位データ', getStations: '潮位観測所の一覧', getWeather: '天気',\n    getWind: '風の推移', getRiver: '河川水位', getRiverStations: '河川の水位観測所の一覧', getWaterQuality: '水質', getWQStations: '水質観測所の一覧' };\n  function perfTable(el, pf) {\n    var keys = Object.keys(pf).sort(function (a, b) {\n      var an = a.slice(2), bn = b.slice(2);\n      return (an === 'load' ? -1 : bn === 'load' ? 1 : 0) || an.localeCompare(bn) || a.localeCompare(b);\n    });\n    if (!keys.length) { el.innerHTML = '<div class=\"empty\">まだデータがありません</div>'; return; }\n    el.innerHTML = '<div class=\"sites-wrap\"><table class=\"sites\"><thead><tr><th>処理</th><th>場所</th><th>回数</th><th>平均</th><th>最大</th><th>3秒以上</th></tr></thead><tbody>' +\n      keys.map(function (k) {\n        var p = pf[k], name = k.slice(2), slow = p[0] ? (p[5] + p[6]) / p[0] : 0, avg = p[0] ? p[1] / p[0] / 1000 : 0;\n        return '<tr><td>' + esc(PERFS[name] || name) + '<small>' + esc(name) + '</small></td><td>' + (k[0] === 's' ? 'サーバー' : '画面') + '</td><td>' + n(p[0]) + '</td><td><span class=\"' +\n          (avg >= 5 ? 'crit' : avg >= 2 ? 'warn' : 'ok') + '\">' + avg.toFixed(1) + '秒</span></td><td>' + (p[2] / 1000).toFixed(1) + '秒</td><td>' + (slow * 100).toFixed(0) + '%</td></tr>';\n      }).join('') + '</tbody></table></div>';\n  }\n  // 位置情報：新旧の画面ごとに成功率\n  function geoList(el, ge) {\n    var apps = { pages: '新しい URL（GitHub Pages）', gas: '旧URL（Apps Script）' }, res = { ok: '取得できた', denied: '許可されなかった', timeout: '時間切れ', unavailable: '取得できなかった', unsupported: '非対応' };\n    var html = '', fill = [];\n    Object.keys(apps).forEach(function (a) {\n      var o = {};\n      Object.keys(ge).forEach(function (k) { var p = k.split(':'); if (p[0] === a) o[p[1]] = ge[k]; });\n      var tot = Object.keys(o).reduce(function (s, k) { return s + o[k]; }, 0);\n      if (!tot) return;\n      html += '<h3 class=\"h3\">' + apps[a] + '：成功 ' + Math.round((o.ok || 0) / tot * 100) + '%（' + n(tot) + ' 回）</h3>' +\n        '<div id=\"geo_' + a + '\"></div>';\n      fill.push(function () { hlist($('geo_' + a), o, function (k) { return res[k] || k; }); });\n    });\n    el.innerHTML = html || '<div class=\"empty\">まだデータがありません</div>';\n    fill.forEach(function (f) { f(); });\n  }\n  // 利用環境：OS・端末・起動方法・アプリ・バージョン\n  function envLists(el, en) {\n    var groups = { os: 'OS', dev: '端末', mode: '起動方法', app: '画面', ver: 'アプリのバージョン' };\n    var names = { 'os:ios': 'iPhone・iPad', 'os:android': 'Android', 'os:windows': 'Windows', 'os:mac': 'Mac', 'os:linux': 'Linux・Chromebook', 'os:other': 'その他',\n      'dev:mobile': 'スマホ', 'dev:tablet': 'タブレット', 'dev:pc': 'パソコン', 'mode:home_screen': 'ホーム画面のアイコン', 'mode:browser': 'ブラウザ',\n      'app:pages': '新しい URL（GitHub Pages）', 'app:gas': '旧URL（Apps Script）' };\n    var html = '', fill = [];\n    Object.keys(groups).forEach(function (g) {\n      var o = {};\n      Object.keys(en).forEach(function (k) { if (k.indexOf(g + ':') === 0) o[k] = en[k]; });\n      html += '<div class=\"card\"><h4>' + groups[g] + '</h4><div id=\"env_' + g + '\"></div></div>';\n      fill.push(function () { hlist($('env_' + g), o, function (k) { return names[k] || k.replace(/^ver:/, 'v'); }, 8); });\n    });\n    el.innerHTML = html;\n    fill.forEach(function (f) { f(); });\n  }\n  function alertsLog(el) {\n    var a = D.alerts || [];\n    el.innerHTML = a.length ? a.map(function (r) { return '<div class=\"alog\"><span class=\"t\">' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b>' + esc(r[2]) + '</div>'; }).join('') :\n      '<div class=\"empty\">通知はまだありません</div>';\n  }\n  function alertForm() {\n    var h = D.health || {};\n    $('alOn').checked = !!h.alerts; $('alDaily').checked = !!h.daily;\n    if (!$('alTo').dataset.touched) $('alTo').value = '';\n    $('alTo').placeholder = '空欄なら ' + (h.alertTo || 'Apps Script の持ち主のアドレス');\n  }\n  // 外部サイトごと：サーバーから（URL Fetch の上限に数える）とブラウザから（上限には数えない）\n  function sitesTable(el, si) {\n    var rows = Object.keys(si).map(function (k) { return [k, si[k].sv, si[k].cl]; })\n      .sort(function (a, b) { return (b[1] + b[2]) - (a[1] + a[2]); });\n    if (!rows.length) { el.innerHTML = '<div class=\"empty\">まだデータがありません</div>'; return; }\n    var top = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));\n    var tsv = rows.reduce(function (s, r) { return s + r[1]; }, 0), tcl = rows.reduce(function (s, r) { return s + r[2]; }, 0);\n    el.innerHTML = '<div class=\"sites-wrap\"><table class=\"sites\"><thead><tr><th>サイト</th><th>サーバーから<br>（上限に数える）</th><th class=\"bar\"></th><th>ブラウザから</th></tr></thead><tbody>' +\n      rows.map(function (r) {\n        return '<tr><td>' + esc(SITES[r[0]] || (/^tide-proxy\\./.test(r[0]) ? SITES['tide-proxy'] : r[0])) + '<small>' + esc(r[0]) + '</small></td><td>' + n(r[1]) + '</td><td class=\"bar\">' +\n          (r[1] ? '<i style=\"width:' + (r[1] / top * 100).toFixed(1) + '%\"></i>' : '') + '</td><td>' + n(r[2]) + '</td></tr>';\n      }).join('') +\n      '<tr><td><b>合計</b></td><td><b>' + n(tsv) + '</b></td><td></td><td><b>' + n(tcl) + '</b></td></tr></tbody></table></div>';\n  }\n  // 地域の名前（国土地理院 逆ジオコーダ。表示のときだけブラウザから）\n  var areaNames = {};\n  function nameAreas(el) {\n    Array.prototype.forEach.call(el.querySelectorAll('[data-k]'), function (s) {\n      var k = s.dataset.k, p = k.split(',');\n      if (areaNames[k]) { s.textContent = areaNames[k] + '（' + k + '）'; return; }\n      fetch('https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=' + p[0] + '&lon=' + p[1]).then(function (r) { return r.json(); }).then(function (j) {\n        areaNames[k] = (j && j.results && j.results.lv01Nm && j.results.lv01Nm !== '－' ? j.results.lv01Nm + ' 付近' : '海上など');\n        s.textContent = areaNames[k] + '（' + k + '）';\n      }).catch(function () { /* 座標のまま */ });\n    });\n  }\n\n  function render() {\n    var A = aggregate();\n    tiles(A);\n    var hm = byHour();\n    var short = hm ? function (d) { return +d.slice(11, 13) + '時'; } : function (d) { return +d.slice(5, 7) + '/' + +d.slice(8, 10); };\n    var unitName = hm ? '時間ごと' : '日ごと';\n    $('pvTitle').innerHTML = unitName + 'の表示回数 <span>回</span>';\n    $('usersTitle').textContent = unitName + 'の利用者数';\n    $('hourCard').hidden = hm;\n    var lab = hm ? A.days.map(function (d) { return d.slice(5, 10).replace('-', '/') + ' ' + +d.slice(11, 13) + '時'; }) : A.days;\n    bars($('cPv'), lab, A.days.map(function (d) { return A.byDay[d].pv; }), { short: function (l, i) { return short(A.days[i]); }, unit: '回' });\n    bars($('cUsers'), lab, A.newRet, { short: function (l, i) { return short(A.days[i]); }, unit: '人' });\n    bars($('cHour'), A.hours.map(function (_, i) { return i + '時'; }), A.hours, { ticks: 8, unit: '回' });\n    bars($('cUf'), lab, A.days.map(function (d) { return A.byDay[d].uf; }), { short: function (l, i) { return short(A.days[i]); }, unit: '回', limit: D.limits && !hm ? D.limits.day : 0 });\n    var cf = D.source === 'cloudflare';\n    $('ufTitle').innerHTML = cf ? unitName + 'の外部サイトからの取得 <span>回（Cloudflare Workers から）</span>' : unitName + 'の URL Fetch 回数 <span>回（点線は1日の上限）</span>';\n    $('perfSub').textContent = '利用者の端末で計測（サーバーは ' + (cf ? 'Cloudflare Workers' : 'Apps Script') + ' の処理時間）';\n    $('alertsArea').hidden = cf; $('cfNote').hidden = !cf; $('gasNote').hidden = cf;\n    hlist($('tStations'), A.st, function (c) { return (D.stationNames[c] || '') + '（' + c + '）'; });\n    hlist($('tAreas'), A.ar, function (k) { return k; });\n    nameAreas($('tAreas'));\n    hlist($('tFeatures'), A.fe, function (k) { return FEATURES[k] || k; }, 30);\n    sitesTable($('tSites'), A.si);\n    healthTiles();\n    failsTable($('tFails'), A.fa, A.si);\n    hlist($('tQuality'), A.qa, qualityName, 15);\n    perfTable($('tPerf'), A.pf);\n    geoList($('tGeo'), A.ge);\n    envLists($('tEnv'), A.en);\n    alertsLog($('tAlerts'));\n    alertForm();\n    hlist($('tRefs'), A.rf, refName, 15);\n    errorsTable($('tErrors'), A.er);\n    var d = new Date(D.now + 9 * 3600e3);\n    $('upd').textContent = (byHour() ? '直近' + D.hours + '時間（' + D.sinceKey.slice(5).replace('-', '/') + '時〜）' : '直近' + DAYS + '日（' + D.since + '〜）') + '・' + d.getUTCHours() + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ' 時点';\n    if (D.live) showLive(D.live);\n    if (CF && !SC.loaded) { SC.loaded = true; loadScope(); }\n    $('sheetLink').hidden = !D.sheetUrl; if (D.sheetUrl) $('sheetLink').href = D.sheetUrl;\n    if (D.version) $('ver').textContent = 'monitor v' + D.version + '（' + String(D.versionDate || '').replace(/-/g, '/') + '）' + (D.source === 'cloudflare' ? '・Cloudflare' : '・Apps Script');\n  }\n\n  function load() {\n    msg('');\n    $('upd').textContent = '読み込み中…';\n    return call('getMonitorData', KEY, DAYS, HOURS).then(function (d) { D = d; render(); }).catch(function (e) { msg('読み込めませんでした：' + (e && e.message || e)); });\n  }\n  $('daysSeg').onclick = function (ev) {\n    var b = ev.target.closest('button'); if (!b) return;\n    if (b.dataset.h) { HOURS = +b.dataset.h; DAYS = 1; } else { HOURS = 0; DAYS = +b.dataset.d; }\n    Array.prototype.forEach.call(this.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });\n    load();\n  };\n  $('reloadBtn').onclick = load;\n  // 要約を文章でコピー（ほかの人やアシスタントに状況を伝えるとき用）\n  $('copyBtn').onclick = function () {\n    var b = this; b.disabled = true; msg('');\n    call('getMonitorSummaryText', KEY, DAYS, HOURS).then(function (t) {\n      return navigator.clipboard.writeText(t).then(function () { b.textContent = 'コピーしました'; setTimeout(function () { b.textContent = '要約をコピー'; }, 2000); },\n        function () { msg('コピーできませんでした。要約は ' + (CF ? location.href.split('#')[0].replace('/admin?', '/monitor?') + '&days=' + DAYS + '&format=text' : location.href.split('#')[0] + '&format=text') + ' でも見られます'); });\n    }).catch(function (e) { msg('要約を作れませんでした：' + (e && e.message || e)); }).then(function () { b.disabled = false; });\n  };\n  $('flushBtn').onclick = function () {\n    var b = this; b.disabled = true;\n    call('adminFlush', KEY).then(function (k) { msg(''); return load(); }).catch(function (e) { msg('集計できませんでした：' + (e && e.message || e)); })\n      .then(function () { b.disabled = false; });\n  };\n  window.addEventListener('resize', function () { if (D) render(); });\n  /* いま使っている人の推移（1分ごとの記録＋開いている間の30秒ごとの値）。オシロスコープ風の折れ線 */\n  var SC = { pts: [], win: 180 };\n  try { SC.win = +localStorage.getItem('mon_scope_win') || 180; } catch (e) { /* 使えない環境 */ }\n  function scopeAdd(t, v) {\n    // 同じ分の記録と30秒ごとの値が近すぎるときは新しい方だけ\n    SC.pts = SC.pts.filter(function (p) { return Math.abs(p[0] - t) > 20000; });\n    SC.pts.push([t, v]);\n    SC.pts.sort(function (a, b) { return a[0] - b[0]; });\n    var old = Date.now() - 2 * 864e5;\n    while (SC.pts.length && SC.pts[0][0] < old) SC.pts.shift();\n  }\n  function loadScope() {\n    return call('getLiveHist', KEY, 1440).then(function (r) {\n      (r.pts || []).forEach(function (p) { scopeAdd(p[0], p[1]); });\n      if (r.live) { scopeAdd(r.live.at, r.live.n); showLive(r.live); }\n      drawScope();\n    }).catch(function () { drawScope(); });\n  }\n  function hm(t) { var d = new Date(t + 9 * 3600e3); return d.getUTCHours() + ':' + ('0' + d.getUTCMinutes()).slice(-2); }\n  function drawScope(hoverX) {\n    var box = $('scope'), svg = $('scopeSvg');\n    if (!box || box.offsetParent === null) return;\n    var W = box.clientWidth, H = box.clientHeight, now = Date.now(), span = SC.win * 60000, t0 = now - span;\n    var pts = SC.pts.filter(function (p) { return p[0] >= t0 - 60000; });\n    var mx = pts.reduce(function (m, p) { return Math.max(m, p[1]); }, 0);\n    // 縦は6目盛り。1目盛りの人数を切りのよい数に\n    var step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].filter(function (s) { return s * 6 >= mx * 1.15; })[0] || 2000, top = step * 6;\n    // 右端の最新の点が切れないよう、右に少し余白を取る\n    var PW = W - 10, X = function (t) { return (t - t0) / span * PW; }, Y = function (v) { return H - 8 - v / top * (H - 20); };\n    var s = '<defs><filter id=\"scGlow\" x=\"-5%\" y=\"-20%\" width=\"110%\" height=\"140%\"><feGaussianBlur stdDeviation=\"2.2\" result=\"b\"/><feMerge><feMergeNode in=\"b\"/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter></defs>';\n    for (var i = 1; i <= 10; i++) s += '<line class=\"' + (i === 5 ? 'a' : 'g') + '\" x1=\"' + (PW * i / 10).toFixed(1) + '\" y1=\"0\" x2=\"' + (PW * i / 10).toFixed(1) + '\" y2=\"' + H + '\"/>';\n    for (var j = 0; j <= 6; j++) {\n      var y = Y(step * j).toFixed(1);\n      s += '<line class=\"' + (j === 0 ? 'a' : 'g') + '\" x1=\"0\" y1=\"' + y + '\" x2=\"' + W + '\" y2=\"' + y + '\"/>';\n      if (j > 0 && j % 2 === 0) s += '<text class=\"lb\" x=\"6\" y=\"' + (+y - 3) + '\">' + step * j + '人</text>';\n    }\n    for (var k = 2; k < 10; k += 2) s += '<text class=\"lb\" x=\"' + (PW * k / 10 + 3).toFixed(1) + '\" y=\"' + (H - 12) + '\">' + hm(t0 + span * k / 10) + '</text>';\n    s += '<text class=\"lb\" x=\"' + (W - 6) + '\" y=\"14\" text-anchor=\"end\">' + (SC.win >= 1440 ? '24時間' : SC.win >= 60 ? SC.win / 60 + '時間' : SC.win + '分') + ' / 1目盛 ' + step + '人</text>';\n    // 折れ線（記録が途切れた所は線を切る）\n    var gap = Math.max(4 * 60000, span / 120), d = '', prev = null;\n    pts.forEach(function (p) {\n      var c = X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1);\n      d += (prev && p[0] - prev[0] <= gap ? 'L' : 'M') + c;\n      prev = p;\n    });\n    if (d) s += '<path class=\"tr\" filter=\"url(#scGlow)\" d=\"' + d + '\"/>';\n    var last = pts[pts.length - 1];\n    if (last) {\n      var lx = X(last[0]).toFixed(1), ly = Y(last[1]).toFixed(1);\n      s += '<circle class=\"pulse\" cx=\"' + lx + '\" cy=\"' + ly + '\" r=\"3\"/><circle class=\"hd\" cx=\"' + lx + '\" cy=\"' + ly + '\" r=\"3\" filter=\"url(#scGlow)\"/>';\n    }\n    // 指でなぞった・マウスを乗せた所の値\n    var read = last ? '最新 ' + hm(last[0]) + ' ' + last[1] + '人' : '';\n    if (hoverX != null && pts.length) {\n      var ht = t0 + hoverX / PW * span, best = pts[0];\n      pts.forEach(function (p) { if (Math.abs(p[0] - ht) < Math.abs(best[0] - ht)) best = p; });\n      var bx = X(best[0]).toFixed(1);\n      s += '<line class=\"cur\" x1=\"' + bx + '\" y1=\"0\" x2=\"' + bx + '\" y2=\"' + H + '\"/><circle class=\"hd\" cx=\"' + bx + '\" cy=\"' + Y(best[1]).toFixed(1) + '\" r=\"3.5\"/>';\n      read = hm(best[0]) + ' ' + best[1] + '人';\n    }\n    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);\n    svg.innerHTML = s;\n    var em = box.querySelector('.empty');\n    if (!pts.length && !em) box.insertAdjacentHTML('beforeend', '<div class=\"empty\">記録を集めています（1分ごとに記録します）</div>');\n    if (pts.length && em) em.remove();\n    $('scopeRead').textContent = read;\n  }\n  (function () {\n    var seg = $('scopeSeg'), box = $('scope');\n    if (!seg) return;\n    Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', String(+b.dataset.m === SC.win)); });\n    seg.onclick = function (ev) {\n      var b = ev.target.closest('button'); if (!b) return;\n      SC.win = +b.dataset.m;\n      try { localStorage.setItem('mon_scope_win', String(SC.win)); } catch (e) { /* 使えない環境 */ }\n      Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });\n      drawScope();\n    };\n    var at = function (ev) { var r = box.getBoundingClientRect(); return Math.min(Math.max(ev.clientX - r.left, 0), r.width); };\n    box.addEventListener('pointermove', function (ev) { drawScope(at(ev)); });\n    box.addEventListener('pointerdown', function (ev) { drawScope(at(ev)); });\n    box.addEventListener('pointerleave', function () { drawScope(); });\n    window.addEventListener('resize', function () { drawScope(); });\n    // 裏に回っていた間の記録を取り直す\n    document.addEventListener('visibilitychange', function () { if (!document.hidden && CF) loadScope(); });\n  })();\n  function showLive(l) {\n    $('liveCard').hidden = false;\n    $('liveN').innerHTML = n(l.n) + '<small>人</small>';\n    var d = new Date(l.at + 9 * 3600e3);\n    $('liveNote').textContent = '直近' + l.windowMin + '分に画面を表示していた端末の数（' + d.getUTCHours() + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ':' + ('0' + d.getUTCSeconds()).slice(-2) + ' 時点）';\n    $('liveSub').textContent = '30秒ごとに更新';\n    scopeAdd(l.at, l.n);\n    drawScope();\n  }\n  if (CF) setInterval(function () {\n    if (document.hidden) return;\n    call('getLive', KEY).then(showLive).catch(function () { /* 次の回に */ });\n  }, 30000);\n  $('alTo').addEventListener('input', function () { this.dataset.touched = '1'; });\n  $('alSave').onclick = function () {\n    var cfg = { alerts: $('alOn').checked, daily: $('alDaily').checked };\n    if ($('alTo').dataset.touched) cfg.to = $('alTo').value;\n    $('alMsg').textContent = '保存中…';\n    call('adminSetAlerts', KEY, cfg).then(function () { $('alMsg').textContent = '保存しました'; delete $('alTo').dataset.touched; return load(); })\n      .catch(function (e) { $('alMsg').textContent = '保存できませんでした：' + (e && e.message || e); });\n  };\n  $('alTest').onclick = function () {\n    $('alMsg').textContent = '送信中…';\n    call('adminTestMail', KEY).then(function (to) { $('alMsg').textContent = to + ' に送りました'; })\n      .catch(function (e) { $('alMsg').textContent = '送れませんでした：' + (e && e.message || e); });\n  };\n  load();\n})();\n</script>\n</body>\n</html>\n";

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
  // 全体でも時間を区切る（間に合わなかった処理はエラーで返し、画面はほかの結果を表示できる）
  for (let round = 0; round < 15 && left.length && Date.now() - t0 < BATCH_DEADLINE_MS; round++) {
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
 *   live     … 匿名IDごとの最後の通信時刻（いま使っている人の数）
 *   live_hist … いま使っている人の数の1分ごとの記録（Cron で記録、2日分。管理画面の折れ線グラフ）
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
    'CREATE TABLE IF NOT EXISTS live_hist (t INTEGER PRIMARY KEY, n INTEGER NOT NULL)'
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
    if (Math.floor(at / 60000) % 5 === 0) ctx.waitUntil(__compact(env, 48).catch(e => console.log('compact failed: ' + e)));
  }
};
