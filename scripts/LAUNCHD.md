# launchdへの登録手順(feed-tycoon-dispatch)

`feed-sync.yml`を毎時0分・30分に`workflow_dispatch`で起動する仕組みをlaunchdに登録する手順。背景はルートの`README.md`「cron の定期取得が不安定な問題への対処」を参照。

`com.gosyujin.feed-tycoon-dispatch.plist`内のパスは`/Users/kk`固定。ユーザー名が違う環境では書き換えること。

## 前提

- Keychainにサービス名`feed-tycoon-dispatch-for-local-token`でFine-grained PAT(Actions: Read and write)を登録済み。未登録なら:

  ```bash
  security add-generic-password -a "$USER" -s feed-tycoon-dispatch-for-local-token -w
  ```

  (`-w`だけ指定するとトークンをプロンプトで入力でき、シェル履歴に残らない)

## 手順

1. スクリプトをTCC非保護のパスへコピーする(Dropbox配下だとlaunchdから`Operation not permitted`になるため)。

   ```bash
   mkdir -p ~/scripts
   cp scripts/feed-tycoon-dispatch.sh ~/scripts/
   chmod +x ~/scripts/feed-tycoon-dispatch.sh
   ```

2. plistを`~/Library/LaunchAgents/`へコピーする。

   ```bash
   cp scripts/com.gosyujin.feed-tycoon-dispatch.plist ~/Library/LaunchAgents/
   ```

3. launchdへ登録する。

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gosyujin.feed-tycoon-dispatch.plist
   ```

4. 登録を確認し、すぐ1回実行して動作確認する。

   ```bash
   launchctl list | grep feed-tycoon-dispatch
   launchctl kickstart gui/$(id -u)/com.gosyujin.feed-tycoon-dispatch
   tail ~/Library/Logs/feed-tycoon-dispatch.log   # "OK (HTTP 204)" ならOK
   ```

## 変更・再登録

plistを変更したときは登録し直す。

```bash
launchctl bootout gui/$(id -u)/com.gosyujin.feed-tycoon-dispatch
cp scripts/com.gosyujin.feed-tycoon-dispatch.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gosyujin.feed-tycoon-dispatch.plist
```

`scripts/feed-tycoon-dispatch.sh`を変更したときは`~/scripts/`へコピーし直す(再登録は不要)。

## 解除

```bash
launchctl bootout gui/$(id -u)/com.gosyujin.feed-tycoon-dispatch
rm ~/Library/LaunchAgents/com.gosyujin.feed-tycoon-dispatch.plist
```

## ログ

- `~/Library/Logs/feed-tycoon-dispatch.log`(スクリプトの成否)
- `~/Library/Logs/feed-tycoon-dispatch-launchd.log`(launchdの標準出力/エラー)
