#!/bin/bash
# Pigeon 发行包组装（唯一可信流程）：重构建 asar → 更新发行目录 → 清除个人数据
set -e
cd "$(dirname "$0")/.."
REL="release/Pigeon-v0.8.0-demo-win64"
mkdir -p "$REL/data/models"
cp _newapp.asar "$REL/resources/app.asar"
rm -rf "$REL/resources/app.asar.unpacked"
cp -r _newapp.asar.unpacked "$REL/resources/app.asar.unpacked"
# AI 模型确保在位（视觉/文本 ONNX + 词表）
for f in visual.onnx text.onnx; do
  [ -f "/c/Users/MECH/Desktop/Pigeon/data/models/$f" ] && cp "/c/Users/MECH/Desktop/Pigeon/data/models/$f" "$REL/data/models/"
done
cp /d/Python/Lib/site-packages/cn_clip/clip/vocab.txt "$REL/data/models/vocab.txt"
# 清除一切个人数据 / 测试残留
rm -rf "$REL/data/userdata" "$REL/data/libraries" "$REL/debug.log" "$REL/data/ai-vectors.json"
echo "发行包已更新: $REL"
echo "data 内容:"; find "$REL/data" -type f | sed "s|$REL/||"
