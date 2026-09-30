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
├── index.html, css/, js/       # ビューア(filters.js: 判定, rules-io.js: CSV, gist.js / filter-sync.js: Gist同期, visited.js: 既読, hatena-api.js: コメント取得, app.js: 画面)
├── service-worker.js           # オフライン対応(アプリ本体と data/*.json をキャッシュ)
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
- 「n users」は、自前のブックマークページ(はてなブックマークのコメント一覧)へ移動する。一覧に戻るとスクロール位置を復元する。ブックマークページ下部の「前の記事へ / 次の記事へ」は、一覧(取得元タブ・検索・既読非表示を適用済み)の並びで前後の記事へ移動する。
- ヘッダーの ⬇️ で、オフライン用キャッシュ(一覧の上位 n 件のコメント。件数は設定画面の値)を今すぐ取得できる。進捗はポップオーバーに出る。
- フィルタは右上の ⚙ から。記事カードの「×」でその記事だけ(URL 完全一致)をミュート、取得元名・ドメインのクリックでそのルール追加を開ける。

## 技術的な注意点

- フィードは直近の数十件しか返さないため、取得結果は「蓄積」する。記事ごとに `firstSeenAt` / `lastSeenAt` を記録し、`firstSeenAt` の新しい順に並べ、14 日・1 ソース 100 件まで保持する。取得直後に大量の過去分が手に入るわけではない。
- 並びは `firstSeenAt` 基準、同時刻なら `publishedAt`。新規取り込み時に `publishedAt` が保持期間より古い記事は捨てる。
- ETag / Last-Modified を `data/meta.json` に保存し、次回は条件付きで取得する(304 なら既存を維持)。
- 取得に失敗したソースは既存データを維持し、`meta.json` に `ok: false` を記録する(画面のフッターに表示)。0 件だった場合は Actions のログに警告が出る。全ソース失敗時のみ Actions を失敗させる。
- フィルタの種別(`title` / `domain` / `url` / `source` / `tag` / `description`)は `js/filters.js` の `TYPE_LABELS` が唯一の定義。増やすときは `matchRule` の `case` も足す。UI・CSV の検証は自動で追随する。
- CSV(`type,value`)は hateb-tycoon と共通。自アプリが持たない `type` の行は、エラーにせず無視する(取り込み結果に「未対応の種別N件は無視」と出す)。value が空・列数不正の行があると、その CSV は全体を取り込まない。
- フィルタは**シークレット Gist で端末間・hateb-tycoon と共有**する(仕様は hateb-tycoon の `docs/gist-sync-spec.md`)。設定するのは Gist ID(URL でも可)だけ。1 つの Gist に `tycoon-filter-<kind>.csv`(mute / unmute / forceMute、アプリ名は含めない)を置く。実装は `js/gist.js`(API・トークン)と `js/filter-sync.js`(同期)。
  - 「保存して同期」= リモートを取り込み(マージ)→ トークンがあれば、差分のあるファイルだけ和集合で上書き。削除は同期されない(消すときは Gist 側の CSV を編集)。壊れた CSV はその種類を取り込まず、上書きもしない。
  - 共有ファイルのため、リモートにあった未対応 type の行は上書き時にそのまま書き戻す(`ignoredRules`)。
  - 起動時は取り込みのみ(保存済み ETag で `If-None-Match`、304 なら何もしない。最大 3 秒待ち、失敗しても通常起動)。読み取りにトークンは不要で、トークンが空の端末は読み取り専用。
  - トークンは classic PAT の `gist` スコープ(fine-grained は Gist 非対応)。設定画面の独立欄に入れ、`localStorage['feed-tycoon:gistToken']` に保存する。
  - 旧仕様(種類ごとの Raw URL 登録と起動時の自動取り込み)は廃止済み。旧 URL の内容は、新しい Gist へ「保存して同期」で積み上げ直す。
- **はてなブックマークへのリンクは `<a href>` にしてはいけない。** iPhone の Safari では、`href` が `b.hatena.ne.jp/entry/...` の `<a>` が `display: none`(0×0)になり、画面に出ない。コンテンツブロッカー(広告ブロック用フィルター)が、はてなブックマークのボタン類を隠すルールに当たっていると考えられる。Mac の Chrome では表示されるため気づきにくい。クラス名(`users` → `bm-count`)を変えても直らず、別の URL の `<a>` や `<button>` は同じ環境で表示された。そのため、一覧の「n users」は自前のブックマークページへの内部リンク(`#/entry?url=…`)にし、ブックマークページ内の「はてなブックマークページ →」は `<button>` にしてクリックで `window.open()` している(`js/app.js` の `renderCard` / `renderEntryView`)。副作用として、後者は長押し・右クリックによる「リンクをコピー」などが使えない。
- 上の切り分けは、`?debug=1` で診断行を出す一時的な変更(JS の版、データの件数、要素の `display`、`<a>` / `<button>` のプローブ)で行った(コミット `1682b47` 参照)。同様に「要素はあるのに見えない」表示差が出たときは、`getComputedStyle` で `display` とサイズを端末側から取ると原因を絞れる。
- **ブックマークページ**のコメントは、`https://b.hatena.ne.jp/entry/jsonlite/?url=…` を JSONP(`<script>` 挿入)で取得する(`js/hatena-api.js`)。**callback 名は呼び出しごとにランダムでなければならない**(固定名にするとはてな API が無応答になる。hateb-tycoon で実験確認済み)。取得に成功するたび解析済みデータを `localStorage` にキャッシュし、オフライン時などはそちらへフォールバックする(最大 300 件)。コメント側のフィルタは `title` / `domain` / `user` / `comment` で評価し、`url` は含めない(含めると URL ルールが全コメントに当たる)。
- **自動継ぎ足し**は `IntersectionObserver`(rootMargin 600px)で末尾の sentinel を監視する。「交差状態が変わった時」しか発火しないため、継ぎ足しのたびに `unobserve` → `observe` で再判定させている。この再監視を外すと、画面が縦に長いときに継ぎ足しが止まる。
- **オフライン対応**は `service-worker.js`(hateb-tycoon が元)。アプリ本体と `data/*.json` を先読みし、「まずネットワーク、失敗したらキャッシュ」で返す。`handleNavigate()` は実 URL ではなく固定キー `'index.html'` で読み書きする(実 URL に戻すと、完全終了後に機内モードで起動したときアプリ全体が落ちる)。`data/*.json` はビューアが CDN 回避のため `?t=<時刻>` を付けて取得するので、キャッシュキーからクエリを外している(外さないと開くたびにキャッシュが増える)。`CACHE_VERSION` はデプロイ時(`deploy-pages.yml`)に `__BUILD_SHA__` が SHA に置換される。設定画面の「オフライン用キャッシュ」で、一覧の上位 n 件のコメントを事前取得できる。
- Service Worker は、サンドボックス化された検証用ブラウザでは `register()` 自体が失敗し、動作確認できない。SW の変更は本番オリジン(<https://note.gosyujin.com/feed-tycoon/>)で、`caches.keys()` / `caches.open()` などをコンソールから叩いて確認する。
- フッターは `ビルドSHA (日時) / 次回更新: HH:MM頃` の形式で、次回更新は更新ワークフロー(`feed-sync.yml`)のページへのリンク。次回更新は `data/meta.json` の `nextEstimate`(取得時刻 + 30 分)。取得に失敗したソースがあると、末尾に「取得失敗: …」を出す。
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
