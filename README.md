# feed-tycoon

複数サイトの新着情報を GitHub Actions で定期取得し、GitHub Pages で一覧表示するフィード集約ツール。
表示側でフィルタ(mute / unmute / forceMute)をかけられる。[hateb-tycoon](https://github.com/gosyujin/hateb-tycoon) と同じ構成。

- 取得: Python(標準ライブラリのみ、3.9 以上)。Actions が RSS / Atom を取得し、`data/feed.json` / `data/feed.xml` / `data/meta.json` を main にコミット
- 表示: 素の JS の静的サイト(ビルド工程なし)。フィルタ条件は `localStorage` に保存し、Secret Gist で端末間同期
- 公開前提のため、秘密情報は扱わない

設計の詳細は [docs/requirements.md](docs/requirements.md) を参照。

## 構成

```
feed-tycoon/
├── sources.json                # 取得元の定義(id / name / type / url / tags)
├── index.html, css/, js/       # ビューア(filters.js: 判定, rules-io.js: CSV・Gist, visited.js: 既読, app.js: 画面)
├── data/                       # Actions が更新する生成物(feed.json, feed.xml, meta.json)
├── scripts/
│   ├── fetch_feeds.py          # 取得・蓄積スクリプト
│   ├── feed-tycoon-dispatch.sh # ローカルMacから workflow_dispatch を叩く(正本)
│   └── com.gosyujin.feed-tycoon-dispatch.plist  # launchd 用テンプレート
├── tests/                      # 取得スクリプトの単体テスト
└── .github/workflows/
    ├── feed-sync.yml           # 取得して data/ をコミットし、deploy-pages.yml を起動
    └── deploy-pages.yml        # main への push で Pages にデプロイ
```

## 使い方

- 取得元は `sources.json` の `sources` に足す(RSS 2.0 / RSS 1.0 / Atom は自動判別)。`name` は `source`、`tags` は `tag` フィルタの対象になる。
- ローカルで取得: `python3 scripts/fetch_feeds.py`
- ローカルで確認: `python3 -m http.server` で配信して `index.html` を開く(`file://` では `fetch` が使えない)。ブラウザやサーバーが静的ファイルをキャッシュすることがあるので、古い表示が出たら別ポートで起動し直す。
- テスト: `python3 -m unittest discover -s tests`
- フィルタは右上の ⚙ から。記事カードの「×」でその記事だけ(URL 完全一致)をミュート、取得元名・ドメインのクリックでそのルール追加を開ける。

## 技術的な注意点

- フィードは直近の数十件しか返さないため、取得結果は「蓄積」する。記事ごとに `firstSeenAt` / `lastSeenAt` を記録し、`firstSeenAt` の新しい順に並べ、14 日・1 ソース 100 件まで保持する。取得直後に大量の過去分が手に入るわけではない。
- 並びは `firstSeenAt` 基準、同時刻なら `publishedAt`。新規取り込み時に `publishedAt` が保持期間より古い記事は捨てる。
- ETag / Last-Modified を `data/meta.json` に保存し、次回は条件付きで取得する(304 なら既存を維持)。
- 取得に失敗したソースは既存データを維持し、`meta.json` に `ok: false` を記録する(画面のフッターに表示)。0 件だった場合は Actions のログに警告が出る。全ソース失敗時のみ Actions を失敗させる。
- フィルタの種別(`title` / `domain` / `url` / `source` / `tag` / `description`)は `js/filters.js` の `TYPE_LABELS` が唯一の定義。増やすときは `matchRule` の `case` も足す。UI・CSV の検証は自動で追随する。
- フィルタ条件は Gist に置く前提(公開しない)。設定画面の「取得して保存」で登録した Raw URL は、起動時に各リストへ自動で取り込まれる(追加のみで、削除は反映されない。最大 3 秒待ち、失敗しても通常起動)。
- **はてなブックマークへのリンクは `<a href>` にしてはいけない。** iPhone の Safari では、`href` が `b.hatena.ne.jp/entry/...` の `<a>` が `display: none`(0×0)になり、画面に出ない。コンテンツブロッカー(広告ブロック用フィルター)が、はてなブックマークのボタン類を隠すルールに当たっていると考えられる。Mac の Chrome では表示されるため気づきにくい。クラス名(`users` → `bm-count`)を変えても直らず、別の URL の `<a>` や `<button>` は同じ環境で表示された。そのため「n users」は `<button>` にして、クリックで `window.open()` している(`js/app.js` の `renderCard`)。副作用として、長押し・右クリックによる「リンクをコピー」などは使えない。
- 上の切り分けは、`?debug=1` で診断行を出す一時的な変更(JS の版、データの件数、要素の `display`、`<a>` / `<button>` のプローブ)で行った。同様に「要素はあるのに見えない」表示差が出たときは、`getComputedStyle` で `display` とサイズを端末側から取ると原因を絞れる。
- 対象外: X(Twitter)、JS 描画が必要なサイト、push 通知。`html` 型ソースは未実装。

## cron の定期取得が不安定な問題への対処

GitHub Actions の `schedule` は発火が不定期になりやすい。hateb-tycoon と同様に、**ローカル Mac の launchd から `workflow_dispatch` を叩いて `feed-sync.yml` を起動**する。`schedule` も補助として残してある。

1. Fine-grained PAT を作る。対象は `gosyujin/feed-tycoon` のみ、権限は **Actions: Read and write** だけ(Contents 権限は不要で、付けると 403 になった実績が hateb-tycoon にある)。
2. Keychain に保存する(サービス名 `feed-tycoon-dispatch-for-local-token`)。
   ```bash
   security add-generic-password -a "$USER" -s feed-tycoon-dispatch-for-local-token -w
   ```
3. Dropbox 配下のスクリプトを launchd から直接実行すると TCC で `Operation not permitted` になるため、実体を非保護パスにコピーする。**正本(`scripts/feed-tycoon-dispatch.sh`)を変更したらコピーし直す。**
   ```bash
   mkdir -p ~/scripts && cp scripts/feed-tycoon-dispatch.sh ~/scripts/ && chmod +x ~/scripts/feed-tycoon-dispatch.sh
   ```
4. plist をコピーして登録する(実行時刻は plist の `StartCalendarInterval` で調整)。
   ```bash
   cp scripts/com.gosyujin.feed-tycoon-dispatch.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gosyujin.feed-tycoon-dispatch.plist
   ```
   再登録は `launchctl bootout gui/$(id -u)/com.gosyujin.feed-tycoon-dispatch` の後に `bootstrap`。
5. ログは `~/Library/Logs/feed-tycoon-dispatch.log`。

トークンはリポジトリに一切含めない(リポジトリは public)。
