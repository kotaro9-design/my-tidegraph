// 東京湾の実測水温・塩分のカードを、偽の API 応答で画面に出して写真を撮る（外部へは通信しない）
//   node tools/test/baypage.mjs <プロジェクト> <出力フォルダ>
import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';
const ROOT = process.argv[2], OUT = process.argv[3], PORT = 8793;
const HOUR = 3600e3, top = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
// 浦安沖（塩分あり）の直近3日。途中に6時間の欠けを入れる
const pts = [];
for (let h = 72; h >= 0; h--) {
  const t = top - h * HOUR;
  if (h > 30 && h < 37) continue;
  const base = 21 + 1.2 * Math.sin((t / HOUR) / 24 * 2 * Math.PI);
  pts.push([t, Math.round((base + 0.3) * 100) / 100, null, Math.round((base - 0.8) * 100) / 100, 30.4]);
}
const last = pts[pts.length - 1];
const bay = { id: '03', name: '浦安沖', lat: 35.64, lon: 139.9417, dist: 17.4, salt: true, url: 'https://www.tbeic.go.jp/MonitoringPost/ViewGraph/ViewGraph?buoyId=03',
  t: last[0], depth: [1.1, 3.0, 4.7], temp: [last[1], 21.8, last[3]], sal: [30.4, 30.6, 30.9], pts };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/api') {
    let body = ''; for await (const c of req) body += c;
    const j = JSON.parse(body), done = {};
    if (j.fn === 'callBatch') console.log('呼び出し', j.args[0].map(c => c[1]).join(','));
    (j.fn === 'callBatch' ? j.args[0] : []).forEach(c => { done[c[0]] = c[1] === 'getBay' ? { result: bay } : c[1] === 'getStations' ? { result: [{ c: 'TK', n: '東京', o: '気象庁', a: '', lat: 35.65, lon: 139.77, sc: 'TK', miss: false, p20: '130010', jcg: '', jn: '' }] } : c[1] === 'getPredPoints' ? { result: [] } : { error: 'テスト用の応答のため取得しません' }; });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ result: j.fn === 'callBatch' ? { done, need: null } : true }));
    return;
  }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try {
    let t = fs.readFileSync(ROOT + '/docs' + f);
    if (f === '/index.html') t = Buffer.from(String(t).replace("'https://tide-api.kotaro9.workers.dev/api'", "'http://localhost:" + PORT + "/api'"));
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' }); res.end(t);
  } catch (e) { res.writeHead(404); res.end(); }
}).listen(PORT);
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=' + OUT + '/profile_bay', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false; for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9339/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9339/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description); };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Browser.grantPermissions', { permissions: ['geolocation'], origin: 'http://localhost:' + PORT });
await cdp('Emulation.setGeolocationOverride', { latitude: 35.6812, longitude: 139.7671, accuracy: 30 });
await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: true });
for (const theme of ['light', 'dark']) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp('Page.navigate', { url: 'http://localhost:' + PORT + '/' });
  await sleep(6000);
  const clip = await ev("(function(){var c=document.getElementById('bayCard');if(c.hidden)return null;c.scrollIntoView({block:'center'});var r=c.getBoundingClientRect();return {x:r.left,y:r.top+scrollY,width:r.width,height:r.height,scale:1};})()");
  if (!clip) { console.log(theme, 'カードが出ていません'); continue; }
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  fs.writeFileSync(OUT + '/bay_' + theme + '.png', Buffer.from(r.result.data, 'base64'));
  console.log(theme, await ev("document.getElementById('bayLbl').textContent + ' / ' + document.getElementById('bayBody').innerText.replace(/\\n/g,' | ')"));
}
console.log('画面のエラー:', errs.join(' / ') || 'なし');
ws.close(); edge.kill(); srv.close(); process.exit(0);
