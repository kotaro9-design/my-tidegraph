import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';
const ROOT = process.argv[2], OUT = process.argv[3];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost'); const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' }); res.end(fs.readFileSync(ROOT + '/docs' + f)); } catch (e) { res.writeHead(404); res.end(); }
}).listen(8791);
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9338', '--user-data-dir=' + OUT + '/profile_wind', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false; for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9338/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9338/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = []; let posts = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } const p = m.params || {};
  if (m.method === 'Runtime.exceptionThrown') errs.push(p.exceptionDetails.exception && p.exceptionDetails.exception.description);
  if (m.method === 'Network.requestWillBeSent' && /workers\.dev\/api/.test(p.request.url)) { try { const j = JSON.parse(p.request.postData); posts.push(j.fn === 'callBatch' ? (j.args[0] || []).map(c => c[1]).join('+') : j.fn); } catch (e) { posts.push('?'); } } };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Network.enable');
await cdp('Browser.grantPermissions', { permissions: ['geolocation'], origin: 'http://localhost:8791' });
await cdp('Emulation.setGeolocationOverride', { latitude: 35.6812, longitude: 139.7671, accuracy: 30 });
await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: true });
for (const theme of ['light','dark']) {
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
await cdp('Page.navigate', { url: 'http://localhost:8791/' });
await sleep(16000);
const clip = await ev("(function(){var c=document.getElementById('wtlLbl').closest('.card')||document.getElementById('wtlLbl').parentNode.parentNode;c.scrollIntoView();var r=c.getBoundingClientRect();return {x:r.left,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()");
const r = await cdp('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
fs.writeFileSync(OUT + '/wind_' + theme + '.png', Buffer.from(r.result.data, 'base64'));
console.log(theme, await ev("document.getElementById('wtlNote').textContent"), '|', await ev("document.getElementById('presFcTxt').textContent"));
}
console.log('画面のエラー:', errs.join(' / ') || 'なし');
ws.close(); edge.kill(); srv.close(); process.exit(0);
