#!/bin/bash
# Pigeon asar 构建脚本
set -e
cd "$(dirname "$0")/.."
rm -rf _stage _newapp.asar _newapp.asar.unpacked
mkdir -p _stage
cp main.js preload.js package.json _stage/
cp -r lib renderer scripts _stage/
cp -r node_modules _stage/node_modules
rm -rf _stage/node_modules/electron _stage/node_modules/@electron _stage/node_modules/.bin
npx --yes @electron/asar pack _stage _newapp.asar --unpack-dir "node_modules/onnxruntime-node"
echo "build done: _newapp.asar + _newapp.asar.unpacked"
