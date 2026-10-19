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
