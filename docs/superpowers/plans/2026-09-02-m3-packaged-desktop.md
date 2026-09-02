# M3 Packaged Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 若 zcode 无该技能，按本文执行并逐项保留验证证据；不要把开发入口 smoke 当成安装包验收。

**Goal:** 产出包含完整运行时与配套 CLI 的 macOS 本机候选 DMG，完成托盘/菜单/窗口生命周期及真实安装后的完整冒烟。

**Architecture:** Electron adapter 实现原生 UI，shell-core 保留可测试的策略；构建阶段生成独立 staging 闭包。`.app` 自带 Host 依赖、CLI Node/pnpm 和 lease helper，运行时资源以应用路径解析。打包前先植入兼容性拒绝门，为 M4 留下真正能拒绝不安全降级的上一候选版本。

**Tech Stack:** 沿用固定 Electron/DSH/Node/pnpm；新增精确固定 electron-builder 和必要的 smoke 驱动开发依赖。生成 `.app` 与 DMG，执行真实 macOS 安装和退出测试。

**Spec:** [主方案 §2.1、§5–9、M3](../../native-dsh-desktop-plan.md)、[开发指南](../../development.md)、[执行总览](2026-09-02-m1-m4-execution-roadmap.md)。

## Global Constraints

- 前提是 M1/M2 完成，全部既有门禁继续通过。
- 本机自用，v1 不公开分发；不自动更新，不为测试修改全局 Gatekeeper 设置。
- 先构建并验证本机 macOS 架构；其他架构只有实际构建/运行后才进入验证矩阵。
- 所有测试都从临时安装目录、临时 userData/DSH home 启动；不覆盖用户应用。
- 应用运行不依赖仓库 node_modules、pnpm store、系统 Node/pnpm；不在 `.app` 内写运行状态。
- 外链只允许 `https:`、`http:`、`mailto:`；renderer 不获得任意 Electron IPC。
- Host 与 CLI 每个进程的 Cordis/React/DSH singleton 都只有各自正确的解析实例；不能靠捆成单 JS 隐藏依赖问题。

---

## 文件与制品责任

| 位置                                                                               | 责任                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `shell-core/src/window-state.ts`、`native-lifecycle.ts`                            | 窗口状态修复、关窗/退出策略                               |
| `apps/desktop-launcher/src/native-ui.ts`、`external-links.ts`、`resource-paths.ts` | Tray/Menu/Dock、系统外链、安装资源路径                    |
| `packages/release-compatibility/`                                                  | M3 最小只读 home admission guard，M4 扩展为完整清单与预检 |
| `build/electron-builder.config.cjs`、`build/assets/`                               | app id/图标/打包配置                                      |
| `scripts/stage-runtime.mjs`、`package-app.mjs`、`write-artifact-manifest.mjs`      | 依赖闭包与可追溯本机制品                                  |
| `tests/smoke/package.mjs` 和各场景脚本                                             | 针对安装应用的验收                                        |

构建输出统一放 `release/`（已忽略）；源码只提交配置、素材源、脚本及脱敏验收摘要。

## Task 1：补齐窗口、Dock、托盘与退出行为

**Files:**

- Create: `packages/shell-core/src/window-state.ts`、`native-lifecycle.ts`、对应 `test/*.test.ts`
- Create: `apps/desktop-launcher/src/native-ui.ts`、`test/native-ui.test.ts`
- Create: `build/assets/icon.svg`、`tray-template.svg`、`scripts/build-icons.mjs`
- Modify: `apps/desktop-launcher/src/main.ts`、`packages/shell-core/src/lifecycle.ts`

**Interfaces:**

```ts
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>
export type SavedWindowState = Readonly<{ bounds: Rect; maximized: boolean }>
export function restoreWindowState(
  saved: SavedWindowState | undefined,
  workAreas: readonly Rect[],
): SavedWindowState
export function closeWindowAction(quitting: boolean): 'hide' | 'close'
```

- [ ] 先写窗口单测：离屏/断开显示器/坏 JSON/非法尺寸回退主屏；最小 900×600（屏幕不足则限制到 workArea）、默认 1280×820；最大化状态恢复且保存 normal bounds。

```ts
expect(closeWindowAction(false)).toBe('hide')
expect(closeWindowAction(true)).toBe('close')
const restored = restoreWindowState(
  { bounds: { x: 9000, y: 9000, width: 1280, height: 820 }, maximized: false },
  [{ x: 0, y: 0, width: 1440, height: 900 }],
)
expect(restored.bounds.x).toBeGreaterThanOrEqual(0)
expect(restored.bounds.x + restored.bounds.width).toBeLessThanOrEqual(1440)
```

- [ ] 实现 `window-state.json` 原子保存，仅存位置/尺寸/最大化；关闭默认隐藏到托盘，Dock activate/托盘“显示”/second-instance 都能恢复并聚焦。菜单“退出”和 Cmd+Q 进入唯一关停状态机。
- [ ] 提供标准 macOS App/Edit/View/Window 菜单、关于、显示、退出；保留标准复制粘贴。托盘包括显示/当前运行或恢复状态/退出。默认不注册额外全局快捷键，避免抢占系统组合键。
- [ ] renderer crash 自动重载最多一次且只在同一活 Host surface；再次失败进入本地恢复窗口，不重载无限循环。退出期间禁用显示/重载动作，Tray/快捷键/窗口各只销毁一次。
- [ ] 从原创简洁 SVG 生成 ICNS/模板托盘资源并记录生成命令；不拷贝不明许可证品牌素材。关于页版本读取后续内嵌清单；当前阶段读取同一个兼容性来源。
- [ ] 运行生命周期/窗口测试，提交 `feat: complete macos desktop lifecycle and window behavior`。

## Task 2：认证、导航与退出后的运行安全

**Files:**

- Create: `apps/desktop-launcher/src/external-links.ts`、`test/external-links.test.ts`
- Modify: `window-policy.ts`、`main.ts`、`packages/shell-core/src/navigation.ts`
- Create: `tests/smoke/auth.mjs`、`navigation.mjs`、`lifecycle.mjs`、`conversation.mjs`
- Modify: smoke harness、root scripts

**Interfaces:**

```ts
export function externalUrlPolicy(input: {
  target: string
  currentOrigin: string
}): 'external' | 'deny'
```

- [ ] 写失败测试：允许协议但 URL 格式坏/userinfo/控制字符时拒绝；带本地认证凭据的 surface URL 不能送系统浏览器；新窗口始终 deny。主 frame 跨源导航/重定向始终拦截。

```ts
expect(
  externalUrlPolicy({ target: 'file:///etc/passwd', currentOrigin: 'http://127.0.0.1:4000' }),
).toBe('deny')
expect(
  externalUrlPolicy({ target: 'https://example.com/help', currentOrigin: 'http://127.0.0.1:4000' }),
).toBe('external')
```

- [ ] 在 launcher 内调用 `shell.openExternal`，只处理经政策检查的用户链接；不允许 renderer 给任意 native 参数。恢复窗口禁用外部导航，官方 Web 仍使用固定认证 origin。
- [ ] `smoke:auth` 用全新 cookie jar 检查实际受保护的 Host API：无 token 被拒绝、authenticated handoff 建立 cookie 后可访问；不要假设公共静态 HTML 也必须返回 401。重启 Host 产生新认证后旧凭据不获权限。
- [ ] `smoke:navigation` 验证主 frame/重定向拒绝、popup deny、允许协议确实进入受控 openExternal adapter；自动测试注入记录型 adapter，避免不断打开用户浏览器，另做一次人工系统外链检查。
- [ ] `smoke:lifecycle` 验证关窗隐藏、托盘和 Dock 唤出、重复启动聚焦、退出 Host/lease/helper 全部释放；`smoke:conversation` 复用 M1 mock LLM，通过官方 UI 发送一轮，完全退出再启动，继续同一 session。
- [ ] 运行四条新增 smoke 与已有 Host crash smoke，提交 `test: cover authentication navigation and desktop lifecycle`。

## Task 3：为旧候选包植入最小兼容性拒绝门

**Files:**

- Create: `packages/release-compatibility/src/home-admission.ts`、`index.ts`、对应测试与 package/TS 配置
- Create: `docs/protocols/home-compatibility.md`、`docs/adr/0008-home-compatibility-admission.md`
- Modify: launcher 和 CLI 的 lease 后/pre-reconcile 启动链、workspace 配置、`docs/adr/README.md`

**Interfaces:** M3 只实现 stable marker reader；M4 增加格式证据与 marker writer，保持 schema 1 可读。

```ts
export type HomeCompatibilityMarker = Readonly<{
  schemaVersion: 1
  dataEpoch: number
  lastWriterReleaseId: string
  formats: Readonly<Record<string, string>>
}>
export function checkHomeAdmission(input: {
  marker: unknown | null
  supportedDataEpochs: readonly number[]
}): 'allow' | 'unknown-schema' | 'unsupported-data'
```

- [ ] 测试 marker schema 未知、格式坏、epoch 不支持时拒绝；M3 内嵌 `[1]`，只允许有效 schema 1/epoch 1；缺 marker 在此阶段允许现有 home，M4 将补 read-only 格式预检。

```ts
expect(
  checkHomeAdmission({
    marker: {
      schemaVersion: 1,
      dataEpoch: 2,
      lastWriterReleaseId: 'future-test-fixture',
      formats: {},
    },
    supportedDataEpochs: [1],
  }),
).toBe('unsupported-data')
```

- [ ] 路径固定 `<home>/run/compatibility.json`，拒绝 symlink，读取失败也 fail closed。取得 lease 后、profile/cache/Host 任何写入前调用；失败显示本地诊断并安全释放 lease。Safe Mode 与 CLI 不得绕过 admission。
- [ ] ADR 说明数据 epoch 是本项目兼容性分组，不冒充 DSH 官方 schema；上游具体格式证据仍由 M4 清单记录。该 marker 只保证受支持入口协作，不阻止其他裸 CLI 或旧无 guard 二进制。
- [ ] 单测和无写入集成通过后提交 `feat: reject unsupported home compatibility markers`。M3 的最终 DMG 必须包含此门禁，否则不能作为 M4 的安全降级演练对象。

## Task 4：打包完整运行时与 CLI

**Files:**

- Create: `build/electron-builder.config.cjs`、`scripts/stage-runtime.mjs`、`package-app.mjs`
- Create: `scripts/verify-runtime-tree.mjs`、`scripts/verify-runtime-tree.test.mjs`
- Create: `apps/desktop-launcher/src/resource-paths.ts`、`test/resource-paths.test.ts`
- Modify: `apps/bundled-cli/src/runtime-paths.ts`、`scripts/dsh-native.mjs`、launcher `host-entry.ts`
- Modify: root/workspace manifests、lockfile、CI、`docs/development.md`

**Interfaces:** 运行时路径只从显式 app/resources 根得到，不扫描外部 pnpm store。

```ts
export type InstalledRuntimePaths = Readonly<{
  hostEntry: string
  hostInstallAnchor: string
  cliEntry: string
  nodeExecutable: string
  pnpmEntry: string
  leaseHelper: string
  recoveryHtml: string
  compatibilityManifest: string
}>
export function resolveInstalledRuntime(resourcesPath: string): InstalledRuntimePaths
```

- [ ] 精确选择并固定 electron-builder 版本，检查该版本配置 schema。当前官方文档已有 v27 配置迁移，不能把网上 v26 的 `asarUnpack` 等配置直接假设适用；只使用选定版本实际支持的字段。参考 [builder 配置](https://www.electron.build/docs/configuration/)。
- [ ] 先写独立 staging 检查失败测试：遗漏 bundle patch、Web assets、package metadata、native helper、CLI Node 或树外 symlink 都必须失败。构建产物不能保留指向仓库/全局 store 的符号链接。
- [ ] 构建 TypeScript 后，从 frozen lockfile 物化 production dependency graph 到 staging；可用固定 pnpm deploy，但必须验证 workspace 包实际文件包含 `lib`、patch、package exports 和官方 Web frontend 资源。需要 `injectWorkspacePackages` 时随测试修改 workspace 配置，不能仅为让 deploy 成功关闭缺依赖检查。
- [ ] 为 Electron utilityProcess Host 和 Node CLI 分别生成可运行闭包；若存在 native addon，分别按对应 ABI 构建/验证，不能用 Node ABI 的 `.node` 冒充 Electron 版本。每个闭包用 `createRequire` 比较 singleton realpath；保持 ESM 和 Cordis bundle 加载语义。
- [ ] 固定 Node runtime 使用兼容性清单的开发基线，下载所需 macOS 架构的官方制品并核对官方 SHASUMS；携带其许可、固定 pnpm 及 package manager shim，以便 `dsh-native plugin` 在没有系统 Node/pnpm 时仍工作。CLI shim 只执行内置 Node，argv 用 `"$@"` 原样转发，不依赖全局 PATH。
- [ ] 把 Host/CLI runtime 作为真实文件资源放在 `Contents/Resources/runtime-host`、`runtime-cli`，helper 放 `Contents/Resources/native`，恢复 HTML/JS/素材放固定资源目录。launcher 自身是否进 ASAR按选定 builder 配置；Host 需要的实际文件不依赖 ASAR 虚拟路径。资源布局参考 [Application Contents](https://www.electron.build/docs/contents/)。
- [ ] 使用既定 `PRODUCT.appId/name`；由脚本读取 Electron version 和 Desktop version，不在 config 复制字符串。新增 `package:dir`、`package:dmg`。不启用自动发布；本机 signing 状态如实记录，保留 macOS 默认保护。
- [ ] CLI 使用独立 Node，所以不依赖 `ELECTRON_RUN_AS_NODE`；对 Electron 的 RunAsNode/NodeOptions/inspect 环境 fuse 做显式设置并验证 utilityProcess 正常运行。固定配置符合 [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) 的实际语义。
- [ ] 运行 `pnpm package:dir` 和 runtime-tree 检查，提交 `build: stage self-contained macos desktop and cli runtimes`。

## Task 5：从 DMG 安装并对真实制品冒烟

**Files:**

- Create: `tests/smoke/package.mjs`、`tests/helpers/installed-app.mjs`
- Create: `scripts/write-artifact-manifest.mjs`、`scripts/verify-artifacts.mjs`
- Create: `docs/validation/m3-acceptance.md`
- Modify: 全部 smoke driver、root scripts、CI、README/主方案/开发文档/兼容性记录

**Interfaces:** `package:dmg` 生成 `release/artifacts.json`，`smoke:package` 读取该文件定位唯一对应架构的候选 DMG，避免取 glob 中任意旧制品。

```ts
export type ArtifactRecord = Readonly<{
  file: string
  sha256: string
  platform: 'darwin'
  arch: 'arm64' | 'x64'
  releaseId: string
  compatibilityManifestSha256: string
}>
```

- [ ] 生成内嵌 `compatibility.json`（版本/DSH/平台/架构/闭包摘要）后打包，最后计算 DMG SHA 并生成外置 `artifacts.json`/`SHA256SUMS`。DMG 的自身 SHA 不写回 DMG 内部，避免自引用哈希循环；外置记录通过 releaseId 与内嵌清单 hash 关联。
- [ ] 用 `hdiutil attach -readonly -nobrowse` 挂载候选 DMG，复制 `.app` 到临时安装目录，卸载 DMG后启动复制件。记录挂载信息，失败路径也卸载；不修改 `/Applications` 中现有应用。
- [ ] 安装 smoke 统一驱动 `.app/Contents/MacOS` 可执行文件，使用显式临时 home/userData。清空 `NODE_PATH/NODE_OPTIONS` 和开发工具 PATH，cwd 指向临时空目录；检查运行时解析 realpath 全在应用资源内，并在无仓库/无 pnpm store 的独立执行环境再跑一次。单独改变 cwd 不能作为“脱离仓库”的证明。
- [ ] 在该安装应用上执行 dsh-ui、conversation、auth、navigation、lifecycle、host-crash、profile-recovery、safe-mode、shared-home。UI 探针只能在验证过的临时 smoke home 中启用，不提供关闭 auth/sandbox 的测试开关。
- [ ] 从安装资源执行 `dsh-native` 的版本、共享会话、busy 拒绝、doctor，以及本地 fixture 包的 plugin 管理；完全不依赖系统 Node/pnpm。退出核对 launcher、Host、CLI、helper 进程与 lease 全部结束。
- [ ] 新增命令并运行：

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 package:dmg
corepack pnpm@11.7.0 smoke:package
corepack pnpm@11.7.0 verify:artifacts
git diff --check
```

- [ ] smoke:package 必须聚合上列全部场景并保存每项结果，任一跳过/失败不能算完整通过。CI 增加 macOS 构建/制品上传，artifact 留在私有任务输出，不建立公开 Release。
- [ ] 人工观察 Dock/托盘图标、菜单、输入/复制粘贴、多显示器恢复和一次系统外链；记录结果及 signing/notarization 的真实状态。写 M3 验收，不宣称公众分发完成。
- [ ] 保留含 admission guard 的健康 M3 DMG、SHA 和测试摘要，作为 M4 的 previous candidate；提交 `docs: record verified m3 packaged desktop acceptance`。

**M3 完成定义：** 临时安装目录里的 `.app` 与配套 CLI 脱离开发环境运行，全部桌面/数据/恢复场景有制品级证据；完整兼容性放行和升级演练仍在 M4。
