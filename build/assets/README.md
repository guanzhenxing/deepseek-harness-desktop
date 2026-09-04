# 打包素材

本目录只存放图标素材源与生成命令记录。`icon.svg` 使用
`@deepseek-ai/dsh-web-frontend` 的官方黑色鲸鱼图形（MIT，Copyright 2026 DeepSeek）；
`tray-template.svg` 使用同一份官方黑色鲸鱼图形，并按 macOS 模板图标规范输出为透明单色资源。

生成命令（macOS 自带工具，无第三方依赖），由 `scripts/build-icons.mjs` 自动执行：

```bash
sips -s format png -z 1024 1024 build/assets/icon.svg --out <work>/icon.svg.png # SVG → PNG 主图（保留透明通道）
sips -z <size> <size> <work>/icon.svg.png --out icon.iconset/icon_<size>x<size>.png
iconutil -c icns icon.iconset -o release/icons/icon.icns  # 应用图标
sips -z 512 512 <work>/icon.svg.png --out release/icons/dock-icon.png # Dock 图标
sips -s format png -z 32 32 build/assets/tray-template.svg --out <work>/tray-template.svg.png
sips -z 16 16 <work>/tray-template.svg.png --out release/icons/trayTemplate.png
cp <work>/tray-template.svg.png release/icons/trayTemplate@2x.png # 32px @2x 模板托盘图
```

产物写入 `release/icons/`（已忽略），可随时用上述脚本复现；源码只提交 SVG 与脚本。
