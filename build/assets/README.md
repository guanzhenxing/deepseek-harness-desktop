# 打包素材

本目录只存放原创素材源与生成命令记录。`icon.svg`（深色圆角方块 + 终端提示符）与
`tray-template.svg`（纯黑模板图形）均为本仓库原创，不拷贝任何第三方品牌素材，无许可证风险。

生成命令（macOS 自带工具，无第三方依赖），由 `scripts/build-icons.mjs` 自动执行：

```bash
qlmanage -t -s 1024 -o <work> build/assets/icon.svg      # SVG → PNG 主图
sips -z <size> <size> master.png --out icon.iconset/icon_<size>x<size>.png
iconutil -c icns icon.iconset -o release/icons/icon.icns  # 应用图标
qlmanage -t -s 32 -o <work> build/assets/tray-template.svg
sips -z 16 16 tray.png --out release/icons/trayTemplate.png
cp tray.png release/icons/trayTemplate@2x.png             # 32px @2x 模板托盘图
```

产物写入 `release/icons/`（已忽略），可随时用上述脚本复现；源码只提交 SVG 与脚本。
