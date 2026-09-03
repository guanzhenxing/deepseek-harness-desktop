# M3 验收记录：打包可安装的 macOS Desktop 候选包

- **状态：见 §6 门禁结果表**（本记录随最终门禁轮次生成；`release/package-smoke.json` 为制品级证据文件）
- 日期：2026-09-03
- 基线：`main` @ `32e9c3e`（M2 验收合并后）
- 结果分支：`codex/m3-packaged-desktop`
- 执行计划：[M3 Implementation Plan](../superpowers/plans/2026-09-02-m3-packaged-desktop.md)
- 决策记录：[ADR-0009](../adr/0009-home-compatibility-admission.md)、[home-compatibility 协议](../protocols/home-compatibility.md)

## 1. 执行环境

- macOS 26（darwin 25.6.0，arm64）、Apple clang（Xcode CLT）
- Node 24.11.1 / pnpm 11.7.0（Corepack）、DSH 0.1.2-alpha.3、Electron 44.1.0
- electron-builder 固定 **26.15.3**（schema 逐字段对照安装包内 app-builder-lib 校验；fuse 字段名为 26.x 的 `enableNodeOptionsEnvironmentVariable` / `enableNodeCliInspectArguments`，而非网传的 `nodeOptions`/`nodeCliInspect`）
- 全部测试使用临时 home/userData/安装目录；真实 `~/.dsh` 未被任何测试触碰（一处执行失误见 §5）

## 2. 制品与架构

| 项 | 值 |
| --- | --- |
| 候选 DMG | `release/dist/DeepSeek Harness Desktop-0.0.0-arm64.dmg`（darwin-arm64） |
| releaseId | `m3-0.0.0-darwin-arm64-d4068ad`（内嵌 `compatibility.json` 与外置 `release/artifacts.json` 关联） |
| DMG SHA256 | 见 `release/SHA256SUMS` / `release/artifacts.json`（外置记录，不自嵌避免自引用哈希） |
| 未验证架构 | darwin-x64：未构建、未运行，不进入支持矩阵 |

`.app` 布局（全部来自 staging 闭包，经 `hdiutil attach -readonly -nobrowse` → `ditto` 安装到临时目录验证）：

- `Contents/Resources/app.asar`：仅 CJS 入口桩（Electron 的 ESM 入口不支持从 ASAR 加载；桩动态 import 真实实现）
- `Contents/Resources/runtime-host`：desktop-launcher 的 `--prod` pnpm deploy 闭包（Electron utilityProcess Host；含官方 Web frontend 资源）
- `Contents/Resources/runtime-cli`：bundled-cli deploy 闭包 + 官方 Node 24.11.1（nodejs.org SHASUMS256 校验）+ pnpm 11.7.0（registry integrity 校验）+ `bin/{dsh-native,node,pnpm}` shim（执行内置 Node，argv 原样转发）
- `Contents/Resources/native/lease-helper`、`recovery/`（恢复页 HTML/JS/preload）、`icons/`、`compatibility.json`
- Electron fuses：`runAsNode=false`、`NODE_OPTIONS=false`、`--inspect=false`、`onlyLoadAppFromAsar=true`（utilityProcess Host 不依赖被禁用的能力）

`scripts/verify-runtime-tree.mjs` 在打包前验证：必需文件齐全；2746+ 相对符号链接全部自含（无指向仓库/store 的链接）；React/Cordis/DSH singleton 每闭包唯一且可解析；原生插件分别按 Electron（dev 二进制 `ELECTRON_RUN_AS_NODE=1`）与内置 Node ABI 加载（4 host + 5 cli 个，全部 NAPI）；staged Node/pnpm 真实运行；CLI shim 在 `PATH=/usr/bin:/bin`、空 cwd 下可用；DSH peer 依赖（`dsh-session-telemetry` 等三个）在闭包内满足（host-supervisor 显式声明，dev workspace 曾掩盖其缺失）。

## 3. 签名与公证状态（如实）

- **ad-hoc 签名，无 Developer ID，未公证**。fuse 翻转使 Electron 上游 ad-hoc 签名失效（内核会 SIGKILL），构建链在 `--dir` 构建后 `codesign --force --deep --sign -` 重签并 `--verify --deep --strict` 校验；DMG 用 `hdiutil create` 直接封装已签名 `.app`（electron-builder 的 dmg target 会在封装后重跑 fuses，使 DMG 内变成未签名副本，已弃用）。
- 未修改 Gatekeeper / 系统 CrashReporter 等任何系统设置。公开发行需另立 ADR 补 Developer ID、hardened runtime、notarization（M4+，未做）。

## 4. 制品级冒烟（`smoke:package`，14 场景）

安装方式：`hdiutil attach -readonly -nobrowse` → `ditto` 复制 `.app` 到临时目录 → detach → 启动副本；应用以 `env` 清理环境（`PATH=/usr/bin:/bin`、无 `NODE_PATH/NODE_OPTIONS`、继承 TMPDIR、空临时 cwd）运行；profile-recovery/safe-mode/admission 经安装闭包内的 controller driver（staged Node）执行。结果文件：`release/package-smoke.json`。

（§6 门禁表记录最终一轮的逐场景结果。）

## 5. 执行偏差与处置

1. 一次诊断命令未设 `DSH_HOME`，在真实 `~/.dsh` 上初始化了 `profiles/desktop`（上游 `dsh plugin --help` 的 init 行为）；credentials/settings/会话未触碰，已在后续命令全部改用显式隔离 home。
2. 调试期间多次在你的桌面产生崩溃弹窗，根因为（a）`fs.cp` 复制破坏 .app 内相对符号链接（dyld SIGABRT）与（b）DMG 内封的是 fuse 后未重签的副本（内核 SIGKILL）；两处已修复（`ditto` 安装、`hdiutil` 封装已签名 .app），harness 增加无条件收尾（信号处理 + 进程组/临时目录/挂载清理）。
3. `--prepackaged` 路径与 afterPack 资源复制不兼容（DMG 内 .app 缺资源），已弃用该路径。

## 6. 门禁结果

（由最终门禁轮次填写。）

## 7. 未验证项与剩余风险

- darwin-x64 未构建未运行；CI 的 macOS job（含 macos-package）未在 GitHub Actions 实际执行。
- Safe Mode 的制品级链为安装闭包 controller 级 + 桩 boot；Electron 会话级 Safe Mode 由 dev `smoke:safe-mode` 覆盖（源码级）。
- 升级/降级演练、marker writer、完整格式预检、updater、公证与公开发布属 M4，本记录不宣称。
- 本机自用候选：DMG 未做 Developer ID 签名/公证，首启右键打开或 `xattr -d com.apple.quarantine`（如经传输产生隔离属性）由用户自行处理——测试链路未修改任何 Gatekeeper 设置。
