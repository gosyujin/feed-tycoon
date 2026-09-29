#!/bin/bash
# feed-tycoon の feed-sync.yml workflow を workflow_dispatch で手動起動する。
# トークンはKeychain(サービス名: feed-tycoon-dispatch-for-local-token)から読む。
# このリポジトリはpublicなので、トークンは絶対にこのスクリプト内やリポジトリ内に書かない。
set -euo pipefail

SERVICE_NAME="feed-tycoon-dispatch-for-local-token"
REPO="gosyujin/feed-tycoon"
WORKFLOW="feed-sync.yml"
LOG_FILE="$HOME/Library/Logs/feed-tycoon-dispatch.log"
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

timestamp() { date "+%Y-%m-%d %H:%M:%S"; }

TOKEN=$(security find-generic-password -a "$USER" -s "$SERVICE_NAME" -w 2>/dev/null) || {
  echo "$(timestamp) FAILED: could not read token from Keychain (service: $SERVICE_NAME)" >> "$LOG_FILE"
  exit 1
}

HTTP_CODE=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches" \
  -d '{"ref":"main"}')

if [ "$HTTP_CODE" = "204" ]; then
  echo "$(timestamp) OK (HTTP 204)" >> "$LOG_FILE"
else
  echo "$(timestamp) FAILED (HTTP $HTTP_CODE): $(cat "$RESPONSE_FILE")" >> "$LOG_FILE"
fi
