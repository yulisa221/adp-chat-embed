#!/bin/sh
# 构建嵌入 SDK：dist/sdk/{adp-chat.js, core.js, core.css, fonts.css, chunks/, assets/}
# 用法：sh scripts/build.sh [输出到的模板目录，如 ~/.workbuddy/skills/adp-sites/assets/adp-chat/services/chat/sdk]
set -e
cd "$(dirname "$0")/.."
VITE=../../node_modules/.bin/vite
$VITE build --mode core
node scripts/postcss-shadow.mjs dist/sdk
$VITE build --mode loader
echo "--- 体积（gzip）"
for f in dist/sdk/adp-chat.js dist/sdk/core.js dist/sdk/core.css; do
  printf '%-28s %8s bytes\n' "$(basename $f)" "$(gzip -c "$f" | wc -c | tr -d ' ')"
done
if [ -n "$1" ]; then
  rm -rf "$1" && mkdir -p "$1" && cp -R dist/sdk/. "$1/"
  echo "已复制到 $1"
fi
