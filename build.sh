#!/bin/bash
# 録音ヘルパー（Intel / Apple Silicon 両対応）をビルドして vsix を作る
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O -target arm64-apple-macos11 helper/main.swift -o /tmp/voicehelper_arm64
swiftc -O -target x86_64-apple-macos11 helper/main.swift -o /tmp/voicehelper_x86_64
lipo -create /tmp/voicehelper_arm64 /tmp/voicehelper_x86_64 -output helper/voicehelper
rm -f ./*.vsix
npx --yes @vscode/vsce package
