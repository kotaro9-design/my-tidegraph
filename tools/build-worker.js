// Cloudflare Workers「tide-api」用の1つのファイルを組み立てる。
//   node tools/build-worker.js  →  cloudflare/api/worker.js
// Apps Script のコード（Code.gs・Monitor.gs）をそのまま使い、前後に Workers 用の置き換えと入口を付ける。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let code = read('Code.gs'), mon = read('Monitor.gs');
// Workers のモジュールでは関数・変数を後から差し替えられるよう、そのまま連結する
const out = read('cloudflare/api/head.js') + '\n' + code + '\n/* ==================== ここから Monitor.gs ==================== */\n' + mon + '\n' + read('cloudflare/api/tail.js');
fs.writeFileSync(path.join(ROOT, 'cloudflare/api/worker.js'), out);
console.log('cloudflare/api/worker.js を作成しました（' + Math.round(out.length / 1024) + ' KB）');
