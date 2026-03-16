#!/bin/zsh

ZIP_NAME="web-click-wizard.zip"

# 移除舊的 zip 檔
rm -f $ZIP_NAME

# 打包，排除 .git、README.md、腳本本身及 macOS 隱藏檔
zip -r $ZIP_NAME . \
    -x "*.git*" \
    -x "README.md" \
    -x "package.sh" \
    -x "*.DS_Store" \
    -x ".*" \

echo "打包完成：$ZIP_NAME"