// 新しい版の確認を手元で試す（docs/ を配り、version.json の中身だけ差し替える）
import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';
const ROOT = process.argv[2], OUT = process.argv[3];
let latest = '2.3.7';
const hits = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  hits.push(u.pathname + u.search.replace(/t=\d+/, 't=…'));
  if (u.pathname === '/version.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: latest })); return; }
  const f = u.pathname === '/' ? '/index.html' : u.pathname;
  try { res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(fs.readFileSync(ROOT + '/docs' + f)); }
  catch (e) { res.writeHead(404); res.end(); }
}).listen(8790);
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9337', '--user-data-dir=' + OUT + '/profile_upd', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false; for (let i = 0; i < 50 && !ok; i++) { await sleep(200); try { await fetch('http://127.0.0.1:9337/json/version'); ok = true; } catch (e) { } }
const page = (await (await fetch('http://127.0.0.1:9337/json/list')).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description); };
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
await cdp('Runtime.enable'); await cdp('Page.enable');
const state = async () => 'アドレス ' + await ev('location.pathname + location.search') + ' | 案内 ' + await ev(`document.getElementById('updBar').hidden ? '(なし)' : document.getElementById('updTxt').textContent`) + ' | 地点 ' + await ev(`document.getElementById('stName').textContent`);

console.log('① 公開中 2.3.7 > 画面 2.3.6');
await cdp('Page.navigate', { url: 'http://localhost:8790/?st=124431' });
await sleep(6000);
console.log('  ', await state());
console.log('   読み込まれたページ:', hits.filter(h => /^\/(\?|index)/.test(h) || h === '/').join(' , '));

console.log('② 公開中 2.3.6 = 画面 2.3.6（新しいタブ相当で開き直す）');
latest = '2.3.6'; hits.length = 0;
await ev(`sessionStorage.clear(); 0`);
await cdp('Page.navigate', { url: 'http://localhost:8790/' });
await sleep(5000);
console.log('  ', await state(), '| 読み込み', hits.filter(h => h === '/' || h.startsWith('/?')).length, '回');

console.log('③ 釣果記録を開いている間に新しい版が出た（画面に戻ってきたとき）');
latest = '2.3.8';
await ev(`document.getElementById('catchBtn').click(); 0`);
await sleep(300);
// 6分後に戻ってきたことにする（確認の間隔を過ぎる）
await ev(`(function(){ var n = Date.now; Date.now = function(){ return n() + 6*60000; }; document.dispatchEvent(new Event('visibilitychange')); })(); 0`);
await sleep(2000);
console.log('  ', await state());
await ev(`document.getElementById('updX').click(); 0`);
console.log('   閉じるを押した後:', await ev(`document.getElementById('updBar').hidden`));
console.log('画面のエラー:', errs.join(' / ') || 'なし');
ws.close(); edge.kill(); srv.close(); process.exit(0);
