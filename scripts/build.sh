#!/bin/sh
# 从源码构建模板包：dist/adp-chat-template.tar.gz（模板 + 预构建 SDK）
#
# SDK 直接复用官方开源仓库 TencentCloudADP/adp-chat-client 里的对话组件，
# 构建时把它克隆到 .upstream/（固定在 UPSTREAM_REF 记录的提交），再把 sdk/ 放进它的 workspace 里构建。
#
# 依赖：git、Node.js 20.19+ / 22.12+
# 用法：sh scripts/build.sh            # 使用 UPSTREAM_REF
#       UPSTREAM_REF=main sh scripts/build.sh   # 试用上游最新代码
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
REF=${UPSTREAM_REF:-$(cat UPSTREAM_REF)}
UP=$ROOT/.upstream

if [ ! -d "$UP/.git" ]; then
  git clone --filter=blob:none https://github.com/TencentCloudADP/adp-chat-client.git "$UP"
fi
git -C "$UP" fetch -q origin "$REF" 2>/dev/null || git -C "$UP" fetch -q origin
git -C "$UP" checkout -q --detach "$REF" 2>/dev/null || git -C "$UP" checkout -q --detach "origin/$REF"
echo "upstream: $(git -C "$UP" rev-parse --short HEAD)"

# 先按上游锁文件安装（sdk 不在上游锁文件里，安装后再放进去）
rm -rf "$UP/client/packages/adp-chat-sdk"
( cd "$UP/client" && npm ci --no-audit --no-fund --loglevel=error )
cp -R "$ROOT/sdk" "$UP/client/packages/adp-chat-sdk"

OUT=$ROOT/dist/adp-chat-template
rm -rf "$ROOT/dist" && mkdir -p "$OUT"
cp -R "$ROOT/template/." "$OUT/"
( cd "$UP/client/packages/adp-chat-sdk" && sh scripts/build.sh "$OUT/functions/chat/sdk" )

VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo dev)
printf '{"version": "%s", "upstream": "%s"}\n' "$VERSION" "$(git -C "$UP" rev-parse HEAD)" > "$OUT/.adp-chat-version.json"
tar -czf "$ROOT/dist/adp-chat-template.tar.gz" -C "$ROOT/dist" adp-chat-template
( cd "$ROOT/dist" && shasum -a 256 adp-chat-template.tar.gz > adp-chat-template.tar.gz.sha256 )
echo "done: dist/adp-chat-template.tar.gz"
cat "$ROOT/dist/adp-chat-template.tar.gz.sha256"
