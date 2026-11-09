#!/bin/zsh
# 编译 Agent Loft Bridge.app（x86_64 + arm64 通用），输出到 bridge/build/。
# 这里只做 ad-hoc 签名：装到用户电脑上时由桌面端复制出去，再用本机证书（或 ad-hoc）重新签，见 src/apple.js。
set -euo pipefail
cd "${0:A:h}"

APP="build/Agent Loft Bridge.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/obj

for arch in x86_64 arm64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" Sources/*.swift -o "build/obj/agent-loft-apple-$arch"
done
lipo -create build/obj/agent-loft-apple-x86_64 build/obj/agent-loft-apple-arm64 -output "$APP/Contents/MacOS/agent-loft-apple"
rm -rf build/obj

cp Info.plist "$APP/Contents/Info.plist"
cp Resources/notes.js "$APP/Contents/Resources/notes.js"

# 图标：用桌面端的图标，系统设置的隐私列表里显示
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size ../build/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) ../build/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
rm -rf "${ICONSET:h}"

codesign --force --sign - "$APP"
echo "built $APP"
