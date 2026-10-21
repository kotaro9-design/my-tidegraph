// 利用ガイドの「ホーム画面に追加する」をライト・ダークで写す
import { spawn } from 'child_process';
import fs from 'fs';
import { pathToFileURL } from 'url';
const OUT = process.argv[2], PAGE = pathToFileURL(process.argv[3]).href;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + OUT + '/profile2', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9334/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text); };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 1500, deviceScaleFactor: 2, mobile: true });
for (const theme of ['light', 'dark']) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp('Page.navigate', { url: PAGE });
  await sleep(2500);
  await cdp('Runtime.evaluate', { expression: `document.getElementById('guideBtn').click(); var d=document.getElementById('guideDlg'), h=document.getElementById('g-home'); d.scrollTop = h.offsetTop - 70; 0` });
  await sleep(800);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '/guide_' + theme + '.png', Buffer.from(r.result.data, 'base64'));
}
console.log('done', errs.length ? errs.join(' / ') : '');
ws.close(); edge.kill(); process.exit(0);
