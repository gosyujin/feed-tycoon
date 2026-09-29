# CLAUDE.md

作業を始める前に `README.md`(特に「技術的な注意点」)と `docs/requirements.md` を読むこと。

## 開発フロー

- 取得は Python 標準ライブラリのみ(3.9 以上で動くこと。`tomllib` や `X | None` 型ヒントは使わない)。ビューアは素の JS(IIFE + `window`)でビルド工程は無い。
- ローカル確認は `python3 -m http.server`。静的ファイルが強くキャッシュされることがあるので、古い表示が出たら別ポートで起動し直す。
- UI 変更は必ずブラウザで実際に操作して確認してから完了報告する。

## Git 運用

- `feed-sync.yml` が高頻度で「Update feed data」を自動コミットする。push の前に必ず `git fetch origin main` し、`git merge-base --is-ancestor origin/main HEAD` で確認、必要なら `git rebase origin/main` してから push する。
- 実装・検証したら、ユーザーの明示的な承認を得るまでコミット・push しない。
- push 後は `gh run list --workflow=deploy-pages.yml` と `gh run watch <id> --exit-status` でデプロイ成功を確認してから完了報告する。
- 保留・不要と言われた事項(X の取得、push 通知など)は、本人から話題が出るまで再提案しない。
