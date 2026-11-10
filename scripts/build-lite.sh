#!/bin/sh
# 构建轻量版模板包：dist/adp-chat-lite-template.tar.gz
# 轻量版 = 同一套云函数后端（template/functions、migrations）+ 纯 JS/CSS 界面（lite/frontend），不需要构建前端。
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT=$ROOT/dist/adp-chat-lite-template
# 卡片（Widget）渲染器：直接用官方开源仓库 adp-chat-client 里预构建的 <adp-widget>（与成品版同一份），
# 固定在 UPSTREAM_REF；只取这一个目录，不需要 npm。
REF=${UPSTREAM_REF:-$(cat UPSTREAM_REF)}
UP=$ROOT/.upstream
if [ ! -d "$UP/.git" ]; then
  git clone --filter=blob:none --no-checkout https://github.com/TencentCloudADP/adp-chat-client.git "$UP"
fi
git -C "$UP" fetch -q origin "$REF" 2>/dev/null || git -C "$UP" fetch -q origin
git -C "$UP" checkout -q --detach "$REF" -- client/packages/adp-widget/src 2>/dev/null \
  || git -C "$UP" checkout -q "$REF" -- client/packages/adp-widget/src
WIDGET_SRC=$UP/client/packages/adp-widget/src
rm -rf "$OUT" "$ROOT/dist/adp-chat-lite-template.tar.gz"*
mkdir -p "$OUT"
cp "$ROOT/template/adp-sites.json" "$OUT/"
cp -R "$ROOT/template/functions" "$ROOT/template/migrations" "$OUT/"
cp -R "$ROOT/lite/frontend" "$OUT/frontend"
rm -rf "$OUT/frontend/adp-chat/vendor"
mkdir -p "$OUT/frontend/adp-chat/vendor/adp-widget"
cp "$WIDGET_SRC"/*.js "$OUT/frontend/adp-chat/vendor/adp-widget/"
rm -rf "$OUT/functions/chat/sdk"
find "$OUT" -name __pycache__ -prune -exec rm -rf {} +
VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)
printf '{"version": "%s", "variant": "lite"}\n' "$VERSION" > "$OUT/.adp-chat-version.json"
tar -czf "$ROOT/dist/adp-chat-lite-template.tar.gz" -C "$ROOT/dist" adp-chat-lite-template
( cd "$ROOT/dist" && shasum -a 256 adp-chat-lite-template.tar.gz > adp-chat-lite-template.tar.gz.sha256 )
echo "done: dist/adp-chat-lite-template.tar.gz"
cat "$ROOT/dist/adp-chat-lite-template.tar.gz.sha256"
