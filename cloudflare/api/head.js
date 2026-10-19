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
