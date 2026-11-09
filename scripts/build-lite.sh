#!/bin/sh
# 构建轻量版模板包：dist/adp-chat-lite-template.tar.gz
# 轻量版 = 同一套云函数后端（template/functions、migrations）+ 纯 JS/CSS 界面（lite/frontend），不需要构建前端。
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT=$ROOT/dist/adp-chat-lite-template
rm -rf "$OUT" "$ROOT/dist/adp-chat-lite-template.tar.gz"*
mkdir -p "$OUT"
cp "$ROOT/template/adp-sites.json" "$OUT/"
cp -R "$ROOT/template/functions" "$ROOT/template/migrations" "$OUT/"
cp -R "$ROOT/lite/frontend" "$OUT/frontend"
rm -rf "$OUT/functions/chat/sdk"
find "$OUT" -name __pycache__ -prune -exec rm -rf {} +
VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)
printf '{"version": "%s", "variant": "lite"}\n' "$VERSION" > "$OUT/.adp-chat-version.json"
tar -czf "$ROOT/dist/adp-chat-lite-template.tar.gz" -C "$ROOT/dist" adp-chat-lite-template
( cd "$ROOT/dist" && shasum -a 256 adp-chat-lite-template.tar.gz > adp-chat-lite-template.tar.gz.sha256 )
echo "done: dist/adp-chat-lite-template.tar.gz"
cat "$ROOT/dist/adp-chat-lite-template.tar.gz.sha256"
