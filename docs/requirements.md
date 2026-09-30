# feed-tycoon 要望書(第一弾)

## 目的

複数のサイトの新着情報を、RSS リーダーのように定期取得して 1 か所で眺める。
取得元は RSS 配信サイト、はてブなどの集約サイト、Qiita / Zenn などの技術記事サイト、RSS のないサイトを想定する。
表示側に、[hateb-tycoon](https://github.com/gosyujin/hateb-tycoon) と同様のフィルタ機能を持たせる。

背景: 2024 年時点では Slack の RSS フィードと Piping Server で実現していた
(<https://scrapbox.io/gosyujin/Piping_Server%E3%82%92%E4%BD%BF%E3%81%A3%E3%81%A6https%E3%81%A0%E3%81%91%E3%81%A7%E3%81%A9%E3%82%93%E3%81%AA%E7%92%B0%E5%A2%83%E3%81%8B%E3%82%89%E3%82%82%E6%83%85%E5%A0%B1%E5%8F%8E%E9%9B%86>)。
RSS のないサイトに使っていた feed43 はサービス終了したため、自前で取得する。

## 前提(割り切り)

1. 秘密情報は流さない。取得結果は公開してよい(GitHub Pages は公開)。
2. リアルタイム性は求めない。数時間の遅れは許容する。
3. 取りこぼしてよい。ギャップ補填やリトライ設計はしない。
4. 過去に遡れなくてよい。直近 N 件・14 日程度だけ持つ。
5. スマホへの push 通知は不要。ページを開いたとき(前面に戻ったとき)に最新を読めばよい。

**唯一公開しないもの**はフィルタ条件で、Private Gist に置いて端末間同期する。

## 構成

```
sources.json ─▶ GitHub Actions (feed-sync.yml。ローカルMacから workflow_dispatch で定期起動)
                 ├ 各ソースを取得(RSS / Atom。HTML 抽出は今後)
                 ├ 共通形式に正規化し、重複排除
                 ├ data/feed.json にマージ(firstSeenAt / lastSeenAt を蓄積)
                 ├ data/feed.xml(無フィルタの Atom)と data/meta.json(取得状況)を生成
                 └ data/ を main にコミット → deploy-pages.yml を起動して Pages に公開
Pages: index.html(data/feed.json を読んで表示。フィルタは localStorage)
```

- ブラウザから他サイトの RSS は CORS で直接取得できないため、取得は Actions 側で行う。
- RSS は直近の数十件しか返さないため、`firstSeenAt` / `lastSeenAt` を付けて蓄積する(hateb-tycoon と同じ方式)。並び順は `firstSeenAt` を基準にする。
- 蓄積の保存は、hateb-tycoon と同じく `data/` を main にコミットする方式にする(取得は Python、ビューアは素の JS の静的サイトで、Node のビルド工程は無い)。当初検討した「前回の `feed.json` を Pages から取得して引き継ぐ」方式は採らない。
- `feed.xml` は無フィルタで出力し、外部リーダーで購読する場合は各自でフィルタする。
- 実装は、取得が Python 標準ライブラリのみ(3.9 以上)、ビューアが素の JS(IIFE + `window`、ビルドなし)。hateb-tycoon と揃える。

## ソース定義(`sources.json`)

各ソースに次のメタデータを持たせる。

| キー | 内容 |
|---|---|
| `id` | ソースの識別子 |
| `name` | 表示名。フィルタの `source` 対象になる |
| `type` | `rss` / `html`(セレクタ抽出) |
| `url` | 取得先 |
| `tags` | ラベルの配列。フィルタの `tag` 対象になる |
| `selectors` | `html` 型のみ。記事リンク・タイトルのセレクタ |

取得元は設定画面から自由に追加・削除できる。一覧はフィルタと同じ Gist の `feed-tycoon-sources.json` に置き、Actions の変数 `FEED_GIST_ID` で取得側に渡す。`sources.json` は初期値兼フォールバック(詳細は README)。以下は `sources.json` の形式(Gist のファイルも同じ `sources` 配列)。

ファイル形式は、標準ライブラリだけで読めるよう YAML/TOML ではなく JSON にした(手元の Python 3.9 に `tomllib` が無く、YAML パーサも標準に無いため)。コメントは `note` フィールドで代用する。

RSS のないサイトは、CSS セレクタ方式で自前抽出する(feed43 の代替)。標準ライブラリの `html.parser` には CSS セレクタが無いため、実装時に方式を決める。
JS 描画が必要なサイトと X は、第一弾の対象外とする。

## 記事データ形式

```json
{
  "title": "",
  "url": "",
  "domain": "",
  "source": "",
  "tags": [],
  "description": "",
  "publishedAt": "",
  "firstSeenAt": "",
  "lastSeenAt": ""
}
```

`domain` は URL の `new URL(url).hostname` から算出する。

## フィルタ(第一弾)

hateb-tycoon の `js/filters.js` を流用元とする。

### 流用する仕様

- リストは `mute` / `unmute` / `forceMute` の 3 種類。
  - `forceMute` に一致 → 非表示(確定)
  - `mute` に一致 → `unmute` にも一致すれば表示、しなければ非表示
  - どちらにも一致しない → 表示
- ルールは `{ id, type, value }`。ルール同士は OR。
- 一致方式は、URL 以外は部分一致(大文字小文字を区別しない)、URL のみ完全一致(記事カードの「×」で 1 記事だけ消すため)。
- 重複判定は type + value(大文字小文字を無視)。常に `type`、`value` の昇順でソートして保存する。
- 保存先は `localStorage`(キー: `feed-tycoon:mute` / `:unmute` / `:forceMute`)。`loadRules` / `saveRules` の 2 か所に閉じ込める。
- CSV import / export(`type,value`、ヘッダー任意。1 行でも不正なら全体を取り込まない)。
- Gist 同期: シークレット Gist の Gist ID だけを設定し、`tycoon-filter-<kind>.csv` で mute / unmute / forceMute を端末間・hateb-tycoon と共有する(仕様は hateb-tycoon の `docs/gist-sync-spec.md`)。「保存して同期」で取り込み+和集合で上書き、起動時は取り込みのみ(ETag・最大 3 秒待ち・失敗しても通常起動)。未対応 type の行は取り込まず、上書き時に書き戻す。
- 件数の可視化(例: `120 件を表示中(フィルタ30件を非表示)`)。

### 変更する仕様

| 項目 | 内容 |
|---|---|
| ルール種別 | `title` / `domain` / `url` / `source` / `tag` / `description`。hateb-tycoon の `user` / `comment` は使わない |
| ルールの読み込み | 描画のたびに `localStorage` を読み直さず、一度だけ読み込んで使い回す |
| エラーメッセージ | ルール種別の一覧は定義から自動生成し、案内漏れを防ぐ |

### 第一弾に追加する機能

- ルールの編集(削除して再登録しなくてよいようにする)
- ~~フィルタで隠した記事の一覧表示~~(hateb-tycoon に合わせて画面から外した。件数だけステータス行に出る)
- 既読の非表示(記事ごとに既読を記録し、既読を隠せるようにする)

### 見送る機能

- ハイライト、正規表現(第二弾。`matchRule` の拡張で足せる構造にしておく)
- AND 条件、ブクマ数条件

## 対象外

- X(Twitter)。無料で安定した取得手段がないため。
- JS 描画が必要なサイト(Playwright が要るため)。
- Piping Server / ntfy 等による push 通知。

## 運用上の注意

- cron の間隔は 30 分〜1 時間。先方への負荷を考え、User-Agent を明示し、ETag / If-Modified-Since に対応する。
- ソースごとに「0 件取得」を Actions のログへ警告として出し、サイト構造の変更に気づけるようにする。
- `data/` を commit するため、リポジトリに定期的に活動があり、schedule の 60 日停止は問題にならない。
- GitHub Actions の cron は発火が不定期なため(hateb-tycoon でも同様)、hateb-tycoon に倣い、ローカルの Mac から launchd で `workflow_dispatch` を定期的に叩く(`scripts/feed-tycoon-dispatch.sh`、詳細は README)。`schedule` も補助として残す。

## 実装状況

1. ✅ `sources.json` と取得スクリプト(`scripts/fetch_feeds.py`)。RSS 2.0 / RSS 1.0 / Atom、ETag・If-Modified-Since、蓄積・プルーニング、`feed.xml` 生成
2. ✅ Actions(`feed-sync.yml` / `deploy-pages.yml`)とローカル dispatch 用スクリプト
3. ✅ ビューア(一覧、取得元タブ、検索、NEW バッジ、前面に戻ったときの再読込)
4. ✅ フィルタ(mute / unmute / forceMute、CSV、Gist 同期)と、編集・既読の非表示(隠した記事の一覧表示は後に廃止)
5. ✅ RSS ソース(Publickey / はてブ IT / Zenn トレンド / Qiita トレンド)
6. ⬜ `html` 型(セレクタ抽出)ソース
7. ✅ ブックマークページ(はてなブックマークのコメント一覧)、一覧の自動継ぎ足し、Service Worker によるオフライン対応、hateb-tycoon 形式のフッター
8. ✅ 取得元の追加・削除(設定画面、Gist 同期)
9. ⬜ 記事の要約(下記「検討中」)

## 検討中

- RSS の `description` とは別に、記事本文の要約を作り、ブックマークページ(「n 件のコメントを表示中」の上)に表示したい。要約を作れるか、どのタイミング(ワークフロー等)で作るかから検討する。
