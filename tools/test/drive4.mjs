// Edge（ヘッドレス）で地図の操作を確かめる。CDP を直接使う
import { spawn } from 'child_process';
import fs from 'fs';
const OUT = process.argv[2];
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const dir = OUT + '/profile';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + dir, '--window-size=420,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50 && !ver; i++) { await sleep(200); try { ver = await (await fetch('http://127.0.0.1:9333/json/version')).json(); } catch (e) { } }
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const logs = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
};
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result.exceptionDetails ? 'ERR ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) : r.result.result.value; };
const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.result.data, 'base64')); };
const click = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Browser.grantPermissions', { permissions: ['geolocation'], origin: 'http://localhost:8787' });
await cdp('Emulation.setGeolocationOverride', { latitude: 35.6812, longitude: 139.7671, accuracy: 30 });
await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: true });
await cdp('Page.navigate', { url: 'http://localhost:8787/' });
await sleep(9000);
console.log('起動後', await ev(`document.getElementById('stName').textContent + ' | ' + document.getElementById('stSub').textContent`));
// 河川水位・水質を表示にする
await ev(`document.querySelector('#riverSeg button[data-r="1"]').click()`);
await sleep(4000);
// Leaflet を先に読み込み、作られた地図を拾えるようにする
await ev(`new Promise(function (res) { var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js'; s.onload = function () { L.Map.addInitHook(function () { window.__map = this; }); res(1); }; document.head.appendChild(s); })`);
await ev(`(function(){var of=window.fetch;window.fetch=function(u,o){var b=o&&o.body;var t=Date.now();var names='';try{var j=JSON.parse(b);names=(j.args[0]||[]).map(function(c){return c[1]}).join(',')}catch(e){}var p=of.apply(this,arguments);if(String(u).indexOf('/api')>=0){p.then(function(r){return r.clone().json()}).then(function(j){var dn=j.result&&j.result.done||{};console.log('API',Date.now()-t+'ms',names,'=>',Object.keys(dn).map(function(k){return dn[k].error?'ERR:'+dn[k].error:'ok'}).join(','),j.error||'')},function(e){console.log('API fail',names,String(e))})}return p};})()`);
await ev(`document.getElementById('stBtn').click()`);
await sleep(500);
await ev(`document.getElementById('pkMap').click()`);
await sleep(6000);
console.log('地図を開いた', await ev(`document.getElementById('mpInfo').innerText`));
await shot('1_open');
// 地図の何もない所（東京駅から南東に数km）をタップ
const pt = async (lat, lon) => JSON.parse(await ev(`(function () { var r = document.getElementById('mpMap').getBoundingClientRect(), p = __map.latLngToContainerPoint([${lat}, ${lon}]); return JSON.stringify([r.left + p.x, r.top + p.y]); })()`));
let [x, y] = await pt(35.655, 139.83);
await click(x, y);
await sleep(8000);
console.log('タップ後', await ev(`document.getElementById('mpInfo').innerText`));
console.log('ヘッダー', await ev(`document.getElementById('stName').textContent + ' | ' + document.getElementById('stSub').textContent`));
await shot('2_place');
console.log('STYLE', await ev(`(function(){var m=document.getElementById('mpMap'),s=getComputedStyle(m);return [document.activeElement&&document.activeElement.id+'.'+document.activeElement.className, s.outlineStyle+' '+s.outlineColor+' '+s.outlineWidth, s.borderTopStyle+' '+s.borderTopColor+' '+s.borderTopWidth, s.boxShadow, m.matches(':focus-visible')].join(' | ')})()`));
// 遠くへ（大阪）
await ev(`__map.setView([34.68, 135.43], 11); 0`); await sleep(1500);
[x, y] = await pt(34.672, 135.44);
await click(x, y);
await sleep(9000);
await sleep(10000);
console.log('大阪タップ後', await ev(`document.getElementById('mpInfo').innerText`));
console.log('ヘッダー', await ev(`document.getElementById('stName').textContent + ' | ' + document.getElementById('stSub').textContent`));
await shot('3_osaka');
// 水質観測所の印をタップ（地図の一覧から一番近いものの位置を探す：印の色で判定はせず、サーバーの一覧を直接使う）
const wq = await ev(`fetch('/api', { method: 'POST', body: JSON.stringify({ fn: 'callBatch', args: [[['a', 'getWQStations', [34.672, 135.44]]], null, null] }) }).then(r => r.json()).then(j => JSON.stringify(j.result.done.a.result[0]))`);
console.log('水質の一覧の先頭', wq);
const w = JSON.parse(wq);
await ev(`__map.setView([${w.lat}, ${w.lon}], 12); 0`); await sleep(1500);
[x, y] = await pt(w.lat, w.lon);
await click(x, y);
await sleep(8000);
console.log('水質の印をタップ後', await ev(`document.getElementById('mpInfo').innerText`));
console.log('水質カード', await ev(`document.getElementById('wqCard').hidden ? '(非表示)' : document.getElementById('wqLbl').textContent`));
await shot('4_wq');
// 潮位観測所の印をタップ（神戸）
const kobe = JSON.parse(await ev(`fetch('/api', { method: 'POST', body: JSON.stringify({ fn: 'callBatch', args: [[['a', 'getStations', []]], null, null] }) }).then(r => r.json()).then(j => JSON.stringify(j.result.done.a.result.filter(s => s.n === '神戸')[0]))`));
await ev(`__map.setView([${kobe.lat}, ${kobe.lon}], 12); 0`); await sleep(1500);
[x, y] = await pt(kobe.lat, kobe.lon);
await ev(`__map.on("click", function(e){console.log("MAPCLICK", Date.now()%100000)}); var n=0; __map.eachLayer(function(l){ if (l instanceof L.CircleMarker) { n++; l.on("click", function(){ console.log("MARKERCLICK", l.getTooltip() && l.getTooltip().getContent(), Date.now()%100000); }); } }); console.log("markers", n, "canvas", !!document.querySelector("#mpMap canvas")); 0`);
console.log("hit", await ev(`(function(){var e=document.elementFromPoint(${x},${y});return e.tagName+"."+e.className})()`));
await click(x, y);
await sleep(7000);
console.log('神戸をタップ後', await ev(`document.getElementById('mpInfo').innerText`));
console.log('ヘッダー', await ev(`document.getElementById('stName').textContent + ' | ' + document.getElementById('stSub').textContent`));
// 現在地に戻す
await ev(`document.getElementById('mpGps').click()`);
await sleep(9000);
console.log('現在地に戻した後', await ev(`document.getElementById('mpInfo').innerText`));
console.log('ヘッダー', await ev(`document.getElementById('stName').textContent + ' | ' + document.getElementById('stSub').textContent`));
await shot('5_gps');
await ev(`document.getElementById('mpClose').click()`);
await sleep(500);
await shot('6_main');
console.log('--- console');
logs.forEach(l => console.log(l));
ws.close(); edge.kill();
process.exit(0);
