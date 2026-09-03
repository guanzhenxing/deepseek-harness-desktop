# M3 验收记录：打包可安装的 macOS Desktop 候选包

- **状态：完成，全部门禁与 14/14 制品级场景通过**（证据：`release/package-smoke.json`、`release/artifacts.json`、`release/SHA256SUMS`；本分支合并后即视为 M3 验收）
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

| 项         | 值                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选 DMG   | `release/dist/DeepSeek Harness Desktop-0.0.0-arm64.dmg`（darwin-arm64）                                                                                                   |
| releaseId  | `m3-0.0.0-darwin-arm64-a903288`（内嵌 `compatibility.json` 与外置 `release/artifacts.json` 经 SHA 关联；制品构建时的源码快照为 `a903288`，即含 codex 复审全部修复的提交） |
| DMG SHA256 | `a6c4b101808799702278dab84ceacaa670b9064f1e65dafddcb104b3f0888812`（约 356 MB；外置记录不自嵌，避免自引用哈希）                                                           |
| 未验证架构 | darwin-x64：未构建、未运行，不进入支持矩阵                                                                                                                                |

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

最终一轮（对最终 DMG 制品）14/14 通过，全部场景均在临时安装目录与显式临时 home 上执行：

`dsh-ui`、`host-crash`、`navigation`（记录型 openExternal adapter）、`lifecycle`、`recovery`（安装应用上毒 profile patch → 真实 Host boot 失败 → 恢复页 → Safe Mode 真实 Host boot 至 healthy）关窗隐藏/托盘与 Dock 唤出/重复启动聚焦/renderer 崩溃恰一次重载后进恢复页/退出释放 lease）、`auth`（无凭据拒绝、握手 cookie 授权、重启轮换后旧凭据拒绝）、`conversation`（一轮对话→完全退出→重启续接同一 session，两轮落盘）、`shared-home`（安装版 desktop 与安装版 CLI 续接同一会话）、`cli-version`、`cli-busy`（desktop 持锁时 CLI exit 3 + doctor 拒清活锁）、`cli-doctor`（空闲 home 清理报告）、`cli-plugin`（本地 fixture bundle 经内置 Node/pnpm 安装并登记进 profile bundles）、`controller-recovery`（M2 失败链不变量在安装闭包上复验）、`controller-admission`（epoch 2 marker fail-closed、零 Host 尝试、marker 字节不变）、`controller-safemode`（Safe Mode 准备三 bundle first-party 集并 healthy，不改正常 profile）。

## 5. 执行偏差与处置

1. **不符合项（Standards）**：一次诊断命令未设 `DSH_HOME`，在真实 `~/.dsh` 上触发了上游 `plugin` 命令的 profile 初始化。现场核查：`~/.dsh/profiles/desktop/` 存在 `package.json`（上游默认 init 形态：仅 `dsh-base` bundle、空依赖）、`pnpm-workspace.yaml`、`cordis.patch.yml` 三个文件；credentials/settings/sessions/storages 未被触碰。由于该目录早于本失误可能被旧桌面版使用过，三个文件无法完全归因；未做删除（可能是用户旧数据）。防再发：此后所有诊断/驱动命令一律显式 `DSH_HOME`，制品级与开发态 smoke 均由 fixture 强制隔离 home。该失误不改变制品行为，但本轮 Standards 结论据此不列为无条件通过。
2. 调试期间多次在你的桌面产生崩溃弹窗，根因为（a）`fs.cp` 复制破坏 .app 内相对符号链接（dyld SIGABRT）与（b）DMG 内封的是 fuse 后未重签的副本（内核 SIGKILL）；两处已修复（`ditto` 安装、`hdiutil` 封装已签名 .app），harness 增加无条件收尾（信号处理 + 进程组/临时目录/挂载清理）。
3. `--prepackaged` 路径与 afterPack 资源复制不兼容（DMG 内 .app 缺资源），已弃用该路径。

## 5.5 自查轮（交付前对抗审查）

按对抗清单（I/O 失败、corrupt-not-unknown、TS-vs-runtime、进程重启、UI copy vs state、证据真实性、攻击最新修复）自查后修复并随源码重建重验（自查修复已并入 codex 复审提交链；最终候选源码快照为 `a903288`）：

1. `resolvePackagedCliRuntime` 对内嵌清单损坏给出"reinstall the application"诊断而非裸堆栈（新增 3 条单测覆盖损坏/缺失/缺字段），并把 staging 根 realpath 规范化（消除 /var 与 /private/var 混用导致的 argv needle 不一致）；
2. `writeWindowState` rename 后补目录 fsync（对齐 M2 durable-fs 纪律）；
3. 安装版 lifecycle 场景补 `host.lock` 释放断言（对齐 dev 版与 conversation 场景）；
4. `cli-version` 场景从"输出非空"加强为"输出含 compatibility.json 钉住的 DSH 版本号"；
5. `verify-artifacts` 的 hdiutil detach 失败改为显式告警（不再静默留挂载）。

修复后按门禁顺序重跑：`package:dir`、`package:dmg`、`verify:artifacts`、`smoke:package`（14/14）、`git diff --check` 全部退出码 0；`check` 于自查修复后全绿（276+5 单测）。

## 5.7 codex 复审轮（9 项发现，全部处置）

| #   | 级别 | 发现                                                                    | 处置                                                                                                                                                                                                                                                |
| --- | ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1   | 诊断命令触碰真实 home（Standards 违规）                                 | §5 第 1 条升级为不符合项并核查现场                                                                                                                                                                                                                  |
| 2   | P1   | `<home>/run/compatibility.json` 未进 data-layout                        | 已补所有者/写入/备份迁移行                                                                                                                                                                                                                          |
| 3   | P1   | 验收缺三轴结论；README"已验收合并"与"待执行"矛盾；主方案清单状态过时    | 本节下方三轴结论；README/主方案已改                                                                                                                                                                                                                 |
| 4   | P1   | CLI 无 profile 透传绕过 admission（`plugin --help` 实测 spawn）         | 透传路径一律先 admission（只读、不取 lease），拒绝 exit 5；doctor 保持豁免；新增单测 + 协议更新                                                                                                                                                     |
| 5   | P1   | 制品级 recovery/Safe Mode 为 controller 桩 boot，非安装应用场景         | 新增 `installed-recovery` 场景：安装应用上毒 profile patch → 真实 Host boot 失败 → 真实恢复页 → Safe Mode 真实 utilityProcess Host boot 至 healthy；毒 patch 字节不变、恰一次 relaunch、lease 释放全部断言（controller 级场景保留为深层不变量测试） |
| 6   | P1   | 非用户触发的主 frame/重定向可打开系统浏览器（`location.assign` 可触发） | 主 frame 导航（含重定向）一律只拦不开；external 仅经 window-open（用户手势 target=_blank）；smoke 断言改为"脚本导航不得进入 external 路径"                                                                                                          |
| 7   | P2   | 固定 minWidth 900 与"屏幕不足限制到 workArea"矛盾                       | `minWindowSizeFor` 纯函数 + 单测：恢复态小于标准最小值时 BrowserWindow 最小值随之放松                                                                                                                                                               |
| 8   | P2   | 内嵌清单缺闭包摘要                                                      | staging 写入 `closureDigest`（watched singleton 精确版本 + 虚拟 store 条目 SHA-256），供 M4 预检比对                                                                                                                                                |
| 9   | P2   | 人工系统外链未做                                                        | 事实项，保留为人工使用周期待办（见 §7）                                                                                                                                                                                                             |

修复后按门禁顺序对最终制品重建重验（见 §6）。外链语义变化已在协议外链行为处同步：普通无 target 外链点击会被静默拦截（不做浏览器转发），受控转发仅 target=_blank 链接——记录该取舍。

## 5.8 三轴结论

- **Standards**：修复后有条件通过——架构/ADR/协议/文档链一致，data-layout 已同步；条件项为 §5 第 1 条的真实 home 触碰失误（现场已核查、防再发措施就位，无法追溯消除）。
- **Spec**：通过——M3 计划逐 Task 核对无缺漏；CLI 无绕过面；制品级 15 场景含真实 Electron 恢复/Safe Mode 链；未完成项（CI 实测、人工观察、x64）均如实记录且不宣称。
- **安全**：通过（本机自用范围内）——admission fail-closed、外链仅 window-open 受控转发、popup 一律拒绝、fuses 硬化（runAsNode/NODE_OPTIONS/inspect 关闭、onlyLoadAppFromAsar）、IPC 窄通道维持 M2 语义；无 Developer ID/notarization，公开发行需另立 ADR（未做，不宣称）。

## 6. 门禁结果（最终轮次，2026-09-03，全部退出码 0）

| 命令                                    | 退出码 | 摘要                                                                                              |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `corepack pnpm@11.7.0 check`            | 0      | 格式/lint/边界/类型/单测 276（29 文件）+ verify-runtime-tree 单测 5 + docs 校验（33 文件）        |
| `corepack pnpm@11.7.0 test:integration` | 0      | 33 集成（8 文件）                                                                                 |
| `corepack pnpm@11.7.0 test:shared-home` | 0      | 4 场景                                                                                            |
| `corepack pnpm@11.7.0 package:dir`      | 0      | icons→staging→runtime-tree 校验（4 host + 5 cli 原生插件 ABI）→未打包 .app（ad-hoc 签名校验通过） |
| `corepack pnpm@11.7.0 package:dmg`      | 0      | 候选 DMG（`hdiutil` 封装已签名 .app）+ artifacts.json/SHA256SUMS                                  |
| `corepack pnpm@11.7.0 smoke:package`    | 0      | 安装级 15/15 场景（§4，含 codex 复审轮新增的 `installed-recovery`）                               |
| `corepack pnpm@11.7.0 verify:artifacts` | 0      | DMG SHA + 内嵌清单 SHA/releaseId 关联校验（挂载只读）                                             |
| `git diff --check`                      | 0      | 无空白错误                                                                                        |

人工观察项（本机桌面）：Dock/托盘图标与模板渲染、标准菜单、输入与复制粘贴、多显示器窗口恢复、恢复页文案——由本机人工启动候选包观察（开发态同一 UI 链已由 smoke 驱动）；系统外链的真实 `shell.openExternal` 未在自动测试中执行（自动测试使用记录型 adapter），留待人工使用周期确认。

## 7. 未验证项与剩余风险

- darwin-x64 未构建未运行；CI 的 macOS job（含 macos-package）未在 GitHub Actions 实际执行。
- 已知限制（二轮审查记录，不阻塞验收）：`verify-runtime-tree` 的原生插件平台过滤是 fail-open（路径含异平台 token 字样时跳过而非报错，现实误杀概率低）；`smoke:package` 在 `release/artifacts.json` 缺失时只报 ENOENT 未提示先跑 `package:dmg`；`package-smoke.json` 未记录各场景耗时（只有 startedAt）；pnpm 11 对带构建脚本的第三方插件默认警告并跳过构建（不阻塞安装）。
- safe-mode 与 profile-recovery 的制品级覆盖分两层：`installed-recovery` 是安装应用上的真实 Electron 会话链（毒 profile patch → 真实 Host boot 失败 → 真实恢复页 → Safe Mode 真实 utilityProcess Host boot 至 healthy；毒 patch 字节不变、恰一次 relaunch、lease 释放），随 codex 复审轮交付；controller 级场景（stub boot）保留为深层不变量测试。该轮同时修复了 safe profile 第三 bundle（`desktop-recovery-bridge`）不在 Host 生产闭包的缺陷——此前 dev 环境靠 workspace 全集泄漏解析，独立部署闭包下真实 Safe Mode boot 从未运行过。
- 升级/降级演练、marker writer、完整格式预检、updater、公证与公开发布属 M4，本记录不宣称。
- 本机自用候选：DMG 未做 Developer ID 签名/公证，首启右键打开或 `xattr -d com.apple.quarantine`（如经传输产生隔离属性）由用户自行处理——测试链路未修改任何 Gatekeeper 设置。
