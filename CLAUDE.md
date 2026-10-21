# CLAUDE.md（Claude Code 向けの作業メモ）

このリポジトリは公開です。秘密の値や公開していない情報（キー・トークン、Apps Script のスクリプト ID、問い合わせの相手や内容など）はここに書かず、`handoff/HANDOFF.md`（git・clasp とも除外）に置きます。

## 進め方の約束

- 報告・返答・コード中のコメントは日本語。
- GitHub CLI（gh）は使わない。GitHub 上の操作はユーザーがブラウザで行い、反映は `git push`（Git Credential Manager）。
- Apps Script（clasp）への公開は、その都度ユーザーに確認してから。
- 川の防災情報（www.river.go.jp）へは手元から取得しない（この PC は 2026-10-20 に 403 のアクセス制限を受けた）。河川・水質の確認は偽のデータで行う（`tools/test/mocktest.mjs`）。User-Agent を変えるなど制限をすり抜ける確認はしない。
- 潮位偏差などを独自に予測して表示する機能は入れない（気象業務法17条の予報業務許可に当たるおそれ。気象庁へ問い合わせ中）。Open-Meteo の値は「予報」でなく「モデル計算値」と表示する。
- 東京湾環境情報センターの水温・塩分は、了承の返事が来るまで組み込まない。
- キー・トークンの値を表示・コミットしない。

## 構成

| 部分 | 場所 | 反映 |
| --- | --- | --- |
| 画面（本体） | `index.html` → `node tools/build-pages.js` → `docs/`（GitHub Pages、`docs/version.json` も生成） | git push |
| API（本番） | Cloudflare Worker `tide-api`。`node tools/build-worker.js` が `cloudflare/api/head.js` + `Code.gs` + `Monitor.gs` + `admin.html` + `cloudflare/api/tail.js` を `cloudflare/api/worker.js` に組み立てる | Cloudflare API（下記） |
| API（予備） | Apps Script「my tide-graph」（`Code.gs`）。画面は Workers に失敗したときだけ使う | `clasp push --force` → `clasp update-deployment <固定のデプロイ ID>` |
| 中継 | Cloudflare Worker `tide-proxy`（`cloudflare/worker.js`） | 変更はまれ |
| 利用状況 | `Monitor.gs`・`admin.html`（Workers の D1 に記録、`/admin?key=…`、`/monitor?key=…&format=text`） | Workers と同時 |

Git の管理ファイルは Google ドライブの外（`C:/Users/user/git/my_tidegraph/.git`）にあり、プロジェクトの `.git` はそこを指すファイル。

## 版の付け方

- 本体：`index.html` の `APP_VERSION` / `APP_DATE` を上げ、`CHANGELOG.md` に追記、`git tag -a vX.Y.Z`（コミット成功を確かめてから）。機能を変えたら利用ガイド（`<dialog id="guideDlg">`）も更新。
- 利用状況：`Monitor.gs` の `MONITOR_VERSION` / `MONITOR_DATE`、`CHANGELOG-monitor.md`、タグ `monitor-vX.Y.Z`。`admin.html` か `Monitor.gs` を変えたときだけ上げる。
- 公開後は `https://kotaro9-design.github.io/my-tidegraph/version.json` で反映を確かめる。

## Workers への反映

1. `node tools/build-worker.js`
2. 本番のコードを `GET /accounts/{アカウント}/workers/scripts/tide-api/content/v2` で控え、前回の組み立てと同じか比べる
3. `PUT …/workers/scripts/tide-api/content`（multipart：`metadata={"main_module":"worker.js"}`、`worker.js=@cloudflare/api/worker.js;type=application/javascript+module`）。バインディング（CACHE＝KV、DB＝D1、ADMIN_KEY）と Cron（毎分）は残る
4. `/monitor?key=…&format=text` の1行目で monitor の版を確かめ、git push とタグ

トークンとキーの置き場所は `handoff/HANDOFF.md` を参照。

## 手元での確認（tools/test）

- `node tools/test/server.mjs <プロジェクト>`：`docs/` を API を localhost:8787 に向けて配り、組み立てた worker.js を Node で動かす
- `node tools/test/admin_server.mjs <プロジェクト>`：管理画面を localhost:8788 で（D1 の代わりに node:sqlite、キーは testkey）
- `drive*.mjs`・`omap.mjs`・`wind.mjs` など：Edge ヘッドレスを CDP で操作して画面写真を撮る（引数は出力フォルダ。Edge のプロファイルもそこに作られる）
- `mocktest.mjs <worker.js>`：川の防災情報を偽のデータに差し替えて河川・水質の一覧を確かめる
- `hangtest.mjs <worker.js>`：外部が応答しないときに時間切れで返るか
