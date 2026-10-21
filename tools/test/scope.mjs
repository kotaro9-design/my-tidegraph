import { spawn } from 'child_process';
import fs from 'fs';
const OUT = process.argv[2];
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9335', '--user-data-dir=' + OUT + '/profile3', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false; for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9335/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text)); };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
await cdp('Runtime.enable'); await cdp('Page.enable');
for (const [theme, w] of [['light', 420], ['dark', 900]]) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 700, deviceScaleFactor: 2, mobile: w < 600 });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await cdp('Page.navigate', { url: 'http://localhost:8788/admin?key=testkey' });
  await sleep(3500);
  console.log(theme, 'read:', await ev(`document.getElementById('scopeRead').textContent`), '| live:', await ev(`document.getElementById('liveN').textContent`));
  const r = await cdp('Page.captureScreenshot', { format: 'png', clip: await ev(`(function(){var r=document.getElementById('liveCard').getBoundingClientRect();return {x:r.left,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`) });
  fs.writeFileSync(OUT + '/scope_' + theme + '.png', Buffer.from(r.result.data, 'base64'));
}
// なぞったときの表示と、範囲の切り替え
const box = await ev(`(function(){var r=document.getElementById('scope').getBoundingClientRect();return [r.left+r.width*0.4,r.top+r.height/2]})()`);
await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] });
await sleep(200);
console.log('hover read:', await ev(`document.getElementById('scopeRead').textContent`));
await ev(`document.querySelector('#scopeSeg button[data-m="30"]').click()`); await sleep(300);
const r2 = await cdp('Page.captureScreenshot', { format: 'png', clip: await ev(`(function(){var r=document.getElementById('liveCard').getBoundingClientRect();return {x:r.left,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`) });
fs.writeFileSync(OUT + '/scope_30m.png', Buffer.from(r2.result.data, 'base64'));
console.log('errors:', errs.join(' / ') || 'なし');
ws.close(); edge.kill(); process.exit(0);
