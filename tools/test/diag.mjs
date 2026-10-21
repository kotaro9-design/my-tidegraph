// 本番の画面を開いて、通信の失敗・画面のエラー・表示の状態を記録する
import { spawn } from 'child_process';
import fs from 'fs';
const OUT = process.argv[2];
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + OUT + '/profile_diag', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false; for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9336/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const logs = []; const reqs = {};
const t0 = Date.now(), ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  const p = m.params || {};
  if (m.method === 'Runtime.exceptionThrown') logs.push(ts() + ' EXC ' + (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) logs.push(ts() + ' console.' + p.type + ' ' + p.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Network.requestWillBeSent') reqs[p.requestId] = { url: p.request.url, method: p.request.method, t: Date.now() };
  if (m.method === 'Network.responseReceived' && reqs[p.requestId]) { reqs[p.requestId].status = p.response.status; }
  if (m.method === 'Network.loadingFinished' && reqs[p.requestId]) reqs[p.requestId].done = Date.now();
  if (m.method === 'Network.loadingFailed' && reqs[p.requestId]) { reqs[p.requestId].fail = p.errorText; reqs[p.requestId].done = Date.now(); }
};
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: 'https://kotaro9-design.github.io/my-tidegraph/' });
for (const w of [5, 15, 30]) {
  await sleep(w === 5 ? 5000 : (w === 15 ? 10000 : 15000));
  console.log('[' + w + '秒] 地点:', await ev(`document.getElementById('stName').textContent`), '| 読み込み中:', await ev(`document.getElementById('app').classList.contains('loading')`), '| 版:', await ev(`typeof APP_VERSION`), '| お知らせ:', await ev(`document.getElementById('notice').textContent`));
}
const r = await cdp('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '/diag.png', Buffer.from(r.result.data, 'base64'));
console.log('--- 通信（失敗・未完了・エラー状態・3秒以上）');
Object.values(reqs).forEach(q => {
  const dur = q.done ? ((q.done - q.t) / 1000).toFixed(1) + 's' : '未完了';
  if (q.fail || !q.done || (q.status && q.status >= 400) || (q.done && q.done - q.t > 3000)) console.log(q.method, q.url.slice(0, 110), q.status || '', q.fail || '', dur);
});
console.log('通信の数', Object.keys(reqs).length);
console.log('--- エラー'); logs.forEach(l => console.log(l));
ws.close(); edge.kill(); process.exit(0);
