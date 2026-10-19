/**
 * my tide-graph 中継（Cloudflare Workers）
 *
 * ブラウザから直接取れない（CORS を許可していない）データ元を中継して、ブラウザから取れるようにする。
 * Apps Script の URL Fetch の1日の上限を使わずに済む。
 *
 *   GET https://<この Worker>/?u=<取得したい URL を encodeURIComponent したもの>
 *
 * - 中継できるのは ALLOW の URL だけ（何でも中継する「開いた中継」にしない）
 * - 呼び出せるのはこのアプリの画面だけ（Origin で確認）
 * - 中継したデータには署名（x-sig）を付ける。Apps Script は同じ合言葉（SECRET）で確かめてから共有キャッシュに入れる
 * - Cloudflare のキャッシュに置き、相手サイトへのアクセスを減らす
 *   （川の防災情報は「ツール等による定期的なデータ収集は控える」よう求めているため、データの更新間隔に合わせて長めに置く）
 *
 * 設定：Workers の「設定 → 変数とシークレット」に、シークレット SECRET（Apps Script のスクリプト プロパティ PROXY_SECRET と同じ値）
 */

// 中継してよい URL と、Cloudflare に置いておく秒数
const ALLOW = [
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/system\/tmCrntTime\.json$/, ttl: 300 },       // 河川：最新の観測時刻
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/files\/tmlist\//, ttl: 600 },                  // 河川・水質：推移（10分ごと・1時間ごと）
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/files\/obslist\//, ttl: 1800 },                // 観測所の一覧・最新値
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/files\/master\//, ttl: 21600 },                // 観測所の情報
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/files\/map\//, ttl: 86400 },                   // 市区町村の一覧
  { re: /^https:\/\/www\.river\.go\.jp\/kawabou\/file\/gjson\/obs\//, ttl: 21600 },                   // 市区町村ごとの観測所
  { re: /^https:\/\/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/gauge\.php\?s=\d{4}$/, ttl: 120 },        // 海上保安庁：験潮の速報
  { re: /^https:\/\/www1\.kaiho\.mlit\.go\.jp\/TIDE\/gauge\/index\.php$/, ttl: 86400 }                // 海上保安庁：験潮所の一覧
];
// 呼び出してよい画面
const ORIGINS = [
  /^https:\/\/kotaro9-design\.github\.io$/,
  /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/,   // Apps Script の画面（旧URL）
  /^http:\/\/localhost(:\d+)?$/                               // 開発用
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin && ORIGINS.some(r => r.test(origin)) ? origin : 'null',
      'Access-Control-Expose-Headers': 'x-sig, x-status',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: cors });
    if (!origin || !ORIGINS.some(r => r.test(origin))) return new Response('forbidden', { status: 403, headers: cors });

    const u = new URL(request.url).searchParams.get('u') || '';
    const rule = ALLOW.find(a => a.re.test(u));
    if (!rule) return new Response('not allowed', { status: 400, headers: cors });

    // Cloudflare のキャッシュ（取得先の URL ごと）
    const cache = caches.default;
    const key = new Request('https://tide-proxy.cache/' + encodeURIComponent(u));
    let hit = await cache.match(key);
    let status, body;
    if (hit) {
      status = +hit.headers.get('x-status');
      body = await hit.text();
    } else {
      const res = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; my-tide-graph-proxy; +https://kotaro9-design.github.io/my-tidegraph/)' },
        cf: { cacheTtl: rule.ttl, cacheEverything: true }
      });
      status = res.status;
      body = status === 200 ? await res.text() : '';
      // 200 と 404 だけ置いておく（一時的なエラーは置かない）
      if (status === 200 || status === 404) {
        ctx.waitUntil(cache.put(key, new Response(body, {
          headers: { 'x-status': String(status), 'Cache-Control': 'public, max-age=' + (status === 404 ? Math.min(rule.ttl, 300) : rule.ttl) }
        })));
      }
    }
    if (status !== 200 && status !== 404) return new Response('upstream ' + status, { status: 502, headers: { ...cors, 'x-status': String(status) } });
    // 署名：URL と本文（404 は '__404__'）を合言葉で HMAC-SHA256
    const sig = await hmac(env.SECRET || '', u + '\n' + (status === 404 ? '__404__' : body));
    return new Response(body, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'x-sig': sig, 'x-status': String(status), 'Cache-Control': 'no-store' }
    });
  }
};

async function hmac(secret, text) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(text));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}
