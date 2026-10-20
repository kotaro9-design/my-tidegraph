// GitHub Pages 用のファイル（docs/）を index.html から作る。
//   node tools/build-pages.js
// 画面は Apps Script のテンプレートと共通。データは Apps Script の doPost から取る。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const API = 'https://script.google.com/macros/s/AKfycbxqSwgZb3ulIir7BVRTHzDGkPbNWjk0jAVC-WPlZcBkvSfHnCl1IpdAVT7d0gxxPZcW6A/exec';
const SITE = 'https://kotaro9-design.github.io/my-tidegraph/';
const NAME = 'my tide-graph';

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rep = (a, b) => { if (!html.includes(a)) throw new Error('見つかりません: ' + a); html = html.replace(a, b); };

// テンプレートの差し込み（地点は ?st= から画面側で読む）
rep('data-st="<?= initialSt ?>"', 'data-st=""');
rep('data-app="<?= appUrl ?>"', 'data-app="' + SITE + '"');
if (/<\?/.test(html)) throw new Error('テンプレートの記法が残っています');

// データの取得先、ホーム画面用のアイコン・名前
rep('<meta name="author" content="kotaro9">', [
  '<meta name="author" content="kotaro9">',
  '<meta name="tide-api" content="' + API + '">',
  '<meta name="description" content="潮汐予測と実測潮位を重ねて表示する釣り人向けアプリ">',
  '<meta name="theme-color" content="#f4f4f2" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#111110" media="(prefers-color-scheme: dark)">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="' + NAME + '">',
  '<link rel="icon" href="icon.svg" type="image/svg+xml">',
  '<link rel="icon" href="icon-192.png" sizes="192x192" type="image/png">',
  '<link rel="apple-touch-icon" href="icon-180.png">',
  '<link rel="manifest" href="manifest.webmanifest">'
].join('\n'));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
// 画面が自分の版と比べる最新の版（index.html と同時に公開されるので、ずれない）
const ver = /APP_VERSION = '([\d.]+)', APP_DATE = '([\d-]+)'/.exec(html);
if (!ver) throw new Error('APP_VERSION が見つかりません');
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ version: ver[1], date: ver[2] }) + '\n');
['icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'].forEach(f => fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f)));
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: NAME,
  short_name: NAME,
  lang: 'ja',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#111110',
  theme_color: '#111110',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }
  ]
}, null, 2) + '\n');
// GitHub Pages の Jekyll 処理を使わない
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log('docs/ を作成しました');
