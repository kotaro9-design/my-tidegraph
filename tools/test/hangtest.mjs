import { pathToFileURL } from 'url';
const keep = setInterval(() => {}, 1000);
// どの外部サイトも応答しない（signal で打ち切られるまで待つ）
globalThis.fetch = (u, o) => new Promise((res, rej) => { if (o && o.signal) o.signal.addEventListener('abort', () => rej(o.signal.reason)); });
const mod = (await import(pathToFileURL(process.argv[2]).href)).default;
const env = { CACHE: { get: async () => null, put: async () => {} } };
const call = async () => {
  const t = Date.now();
  const res = await mod.fetch(new Request('https://x/', { method: 'POST', headers: { Origin: 'https://kotaro9-design.github.io' }, body: JSON.stringify({ fn: 'callBatch', args: [[['c1', 'getPredPoints', []], ['c2', 'getStations', []]], { __proxy: 1 }, null] }) }), env, { waitUntil: p => p });
  const j = await res.json();
  console.log(((Date.now() - t) / 1000).toFixed(1) + '秒で返事', JSON.stringify(Object.fromEntries(Object.entries(j.result.done).map(([k, v]) => [k, v.error || 'ok']))));
};
await Promise.all([call(), call()]);   // 同時に2つ（同じ取得を分け合う）
await call();                           // 続けてもう1回（止まった取得を待ち続けないこと）
clearInterval(keep);
