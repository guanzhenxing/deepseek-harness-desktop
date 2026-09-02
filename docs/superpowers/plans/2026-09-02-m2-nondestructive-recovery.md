# M2 Nondestructive Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 若 zcode 无该技能，按本文顺序执行测试、实现、验证、提交。勾选仅表示已经获得对应证据。

**Goal:** 启动失败后保留可操作的 Electron 恢复面，在不覆盖用户 home 数据的前提下修复本次 profile 自动变更，并可进入独立 Safe Mode。

**Architecture:** `profile-manager` 唯一拥有逐文件修订 journal 和恢复；shell 编排失败分类、Host attempt 与重试限额。Safe Mode 由独立第一方 recovery bridge 发布 surface，正常 Desktop 插件和第三方 profile 不进入其加载路径；launcher 的本地恢复窗口始终独立于两种 Host。

**Tech Stack:** 沿用 M1 锁定依赖；现有 Host-control 1.0、SHA-256、原子文件替换、持久 journal、Electron sandboxed recovery preload。

**Spec:** [主方案 §3.4–3.5、§5、§8、M2](../../native-dsh-desktop-plan.md)、[ADR-0002](../../adr/0002-use-a-minimal-recovery-bridge.md)、[ADR-0003](../../adr/0003-separate-profile-manager.md)、[执行总览](2026-09-02-m1-m4-execution-roadmap.md)。

## Global Constraints

- M1 验收通过后开始；所有恢复写入都要求活动 home lease；停止旧 Host 后才修改/恢复/启动新 Host。
- 只管理 `profiles/desktop` 下明确白名单，逐文件保存存在性和 SHA-256；SHA 不匹配不覆盖。
- 不回滚 `.credentials.yaml`、`settings.yaml`、home `cordis.patch.yml`、sessions、storages 权威数据。
- Safe Mode 使用 `desktop-safe-mode`，固定 base/web/recovery bridge，不加载正常 profile 依赖树、bundle 或 patch。
- Safe Mode 是共享 home 的独占 Host，不与正常 Host 并行；它不是恶意插件的权限 sandbox。
- 一次自动恢复最多 relaunch 一次；普通 Host/bridge 都失效时，本地诊断、重试、退出仍可用。
- M2 不做插件市场、定点禁用、generation ledger、数据迁移或 updater。

---

## 文件责任与运行链

| 文件组 | 责任 |
| --- | --- |
| `profile-manager/src/reconcile-plan.ts`、`revision-transaction.ts`、`revision-recovery.ts` | 先计算写入计划，持久化前后修订，幂等恢复 |
| `profile-manager/src/safe-profile.ts` | 只创建/验证 Safe Mode 自身 profile |
| `shell-core/src/failure-policy.ts`、`recovery-controller.ts` | 失败类别、恢复资格、串行 attempt 与重试预算 |
| `apps/desktop-launcher/src/recovery-*` | 独立可信本地窗口、窄 IPC、诊断视图 |
| `shell-core/src/projection-cache.ts` | 已知派生缓存隔离；不拥有 DSH 数据格式 |
| `packages/desktop-recovery-bridge/` | 只发布官方 recovery surface |

正常链：`lease → 恢复未完成 journal → cache 检查 → 生成 reconcile plan → 持久 journal → 应用变更 → Host ready → renderer 挂载与稳定 → committed`。

失败链：`stop Host 并确认退出 → 分类 → 可归因且 SHA 匹配时回滚 → 最多一次正常重启 → 本地恢复窗口`。Safe Mode 只由用户明确选择，复用当前 lease。

## Task 1：明确失败分类与恢复资格

**Files:**

- Create: `packages/shell-core/src/failure-policy.ts`、`test/failure-policy.test.ts`
- Modify: `packages/host-supervisor/src/host-runner.ts`、`supervisor.ts`、其测试
- Create: `docs/protocols/startup-recovery.md`、`docs/adr/0006-profile-revision-recovery.md`
- Modify: `docs/adr/README.md`

**Interfaces:** 保留 Host 已有 `fatal.stage/code/retryable` 信息，不把全部 fatal 压成通用 BOOT_FAILED；新增的是本地分类模型，不扩展任意原生调用。

```ts
export type FailureCategory =
  | 'lease' | 'profile-write' | 'profile-composition' | 'home-config'
  | 'credentials' | 'network' | 'runtime' | 'renderer' | 'native-ui' | 'unknown'
export type StartupFailure = Readonly<{
  stage: string
  code: string
  category: FailureCategory
  summary: string
  retryable: boolean
}>
export function shouldRollbackProfile(input: {
  failure: StartupFailure
  changed: boolean
  healthy: boolean
}): boolean
```

- [ ] 写表驱动失败测试：只有未 healthy、确实改过 profile、失败定位为 profile-write/profile-composition 才有自动回滚资格。lease、端口/权限、home YAML、凭据、打包运行时、原生菜单和未知错误都不回滚。

```ts
expect(shouldRollbackProfile({ changed: true, healthy: false,
  failure: { stage: 'load-home-patch', code: 'HOME_PATCH_INVALID',
    category: 'home-config', summary: 'Home patch cannot be parsed', retryable: false },
})).toBe(false)
```

- [ ] 把 Host boot 拆成有命名阶段的 profile 解析、home patch 解析、runtime 解析、boot、surface 发布；错误在捕获位置设置类别/code。不通过错误消息包含某个单词推断责任插件；归因不足用 unknown。
- [ ] 结构化失败摘要有长度上限、脱敏和安全 fallback；用包含 token/home/控制字符的输入证明日志不泄露。凭据缺失只引导用户到官方设置，不新建凭据副本。
- [ ] ADR 明确 v1 修订事务与 E3 generation 的区别，以及 renderer 失败默认不能证明 profile 有错。执行 `pnpm exec vitest run packages/shell-core/test/failure-policy.test.ts packages/host-supervisor/test/supervisor.test.ts`，先失败再通过，提交 `feat: classify startup failures for safe recovery`。

## Task 2：逐文件 journal 与条件恢复

**Files:**

- Create: `packages/profile-manager/src/reconcile-plan.ts`、`revision-transaction.ts`、`revision-recovery.ts`
- Create: `packages/profile-manager/test/revision-transaction.test.ts`、`revision-recovery.integration.test.ts`
- Modify: `packages/profile-manager/src/reconcile.ts`、`index.ts`、`docs/data-layout.md`

**Interfaces:** 消费 `ProfileRef` 和 M1 `HomeLease`。白名单只含三项，已存在 patch/workspace 不因恢复而被常规模板覆盖。

```ts
export type ManagedProfilePath = 'package.json' | 'cordis.patch.yml' | 'pnpm-workspace.yaml'
export type FileRevision = Readonly<{ exists: boolean; sha256: string | null }>
export type PlannedProfileWrite = Readonly<{
  path: ManagedProfilePath
  before: FileRevision
  beforeBytes: Uint8Array | null
  candidateBytes: Uint8Array
  candidateSha256: string
}>
export type ProfileReconcilePlan = Readonly<{
  ref: ProfileRef
  writes: readonly PlannedProfileWrite[]
}>
export type RevisionTransaction = Readonly<{
  id: string
  ref: ProfileRef
  state: 'prepared' | 'applying' | 'applied' | 'committed' | 'retained' | 'rolling-back' | 'rolled-back' | 'conflict'
}>
export function planDesktopReconcile(ref: ProfileRef, lease: HomeLease): Promise<ProfileReconcilePlan>
export function applyProfileTransaction(plan: ProfileReconcilePlan, lease: HomeLease): Promise<RevisionTransaction>
export function commitProfileTransaction(id: string, lease: HomeLease): Promise<void>
export function rollbackProfileTransaction(id: string, lease: HomeLease): Promise<'restored' | 'conflict'>
export function recoverInterruptedTransactions(ref: ProfileRef, lease: HomeLease): Promise<'clean' | 'restored' | 'conflict' | 'needs-review'>
```

- [ ] 先写恢复失败测试：三个文件均能记录“原来不存在”；恢复创建操作只删除本次新建且仍匹配的文件；已有用户 patch/workspace 字节不变；修改候选任一文件后拒绝自动恢复；其他 profile/home 文件永不进入 snapshot。

```ts
const plan = await planDesktopReconcile(ref, lease)
const tx = await applyProfileTransaction(plan, lease)
await writeFile(path.join(ref.dir, 'package.json'), '{"userChanged":true}\n')
await expect(rollbackProfileTransaction(tx.id, lease)).resolves.toBe('conflict')
expect(await readFile(path.join(ref.dir, 'package.json'), 'utf8'))
  .toBe('{"userChanged":true}\n')
```

- [ ] 将现有 reconcile 拆成纯计算与受控 apply：对所有将变更文件先读存在性/bytes/SHA，再写 `<home>/run/profile-transactions/<id>/before` 和 closed-schema `transaction.json`。journal 存白名单相对路径，不接受任意目标路径；snapshot 0600，目录 0700。
- [ ] 每次副作用前 fsync 意图和相关目录；逐文件落盘进度记录候选摘要。断电可能发生在文件替换后、progress 更新前，重启必须对照实际 SHA 与 before/candidate，不能仅依赖 progress 标志。
- [ ] rollback 先验证全部受影响文件：每个只能处于对应 before 或 candidate；出现第三种内容先标记 conflict，不开始新的批量恢复。写回前再次校验路径/inode/摘要；并发 drift 出现则停止，记录已恢复项；重启可幂等继续，不能谎称跨多个文件 rename 原子。
- [ ] `committed` 仅在 Host ready、真实 BrowserWindow 挂载与稳定窗口都通过后写入。启动中断且未 committed 的旧事务在新 Host boot 前处理；未开始 boot 的半完成文件事务可按 before/candidate 幂等恢复，已开始 boot 却缺少失败归因的事务返回 needs-review，不能猜测 profile 有错。文件已回到 before 时重复恢复不报错。
- [ ] 发生明确不允许回滚的失败时，将失败类别和 `retained` 处置原子写入 journal；它表示保留候选且未标健康。下一次启动不能把 retained 当成普通中断事务而偷偷回滚，避免 home patch/凭据错误在第二次启动触发不该发生的 profile 恢复。
- [ ] committed/rolled-back/retained 终态保留最近 20 条记录，未终态/conflict 不自动清理；snapshot 中可能包含 profile 的敏感配置，禁止出现在普通日志/诊断导出中。
- [ ] 故障注入每个意图/替换边界，至少覆盖 before snapshot、首文件替换、最后文件替换、commit 与 rollback 中断；运行 `pnpm exec vitest run packages/profile-manager/test/revision-transaction.test.ts` 与真实文件系统 integration，提交 `feat: add revision-checked profile recovery transactions`。

## Task 3：可操作的本地恢复窗口与有界重试

**Files:**

- Create: `packages/shell-core/src/recovery-controller.ts`、`test/recovery-controller.test.ts`
- Create: `apps/desktop-launcher/src/recovery-window.ts`、`recovery-preload.cts`、`recovery-ipc.ts`、`recovery-view.js`
- Create: `apps/desktop-launcher/test/recovery-ipc.test.ts`
- Modify: `apps/desktop-launcher/src/recovery.html`、`main.ts`、`packages/shell-core/src/lifecycle.ts`
- Create: `docs/adr/0007-launcher-recovery-ipc.md`
- Modify: `docs/adr/README.md`、`docs/protocols/startup-recovery.md`

**Interfaces:** 本地 recovery bridge 只对指定恢复窗口开放，不注入官方 DSH renderer。

```ts
export type RecoveryAction = 'retry' | 'safe-mode' | 'quit'
export type RecoveryView = Readonly<{
  failure: StartupFailure
  retryAllowed: boolean
  safeModeAllowed: boolean
  doctorCommand: 'dsh-native doctor --unlock' | null
}>
export interface RecoveryController {
  getView(): RecoveryView
  act(action: RecoveryAction): Promise<void>
}
```

- [ ] 先写测试：连续点击重试只产生一个 attempt；stop/quit 与 retry 并发以 quit 为准；旧 surface 和旧 IPC sender 失效；一次自动恢复后再次启动失败不会继续循环。

```ts
await Promise.all([controller.act('retry'), controller.act('retry')])
expect(createdAttempts).toHaveLength(1)
expect(observedLeaseGenerations).toEqual([lease.generation])
```

- [ ] 重构 M1 生命周期为外层 session 持 lease、内层一次性 HostSupervisor；先 stop/确认退出，再 restore/重试。普通 post-ready crash 不自动重启；用户手动重试限制为每 60 秒最多 3 次，冷却后可再操作。profile 自动恢复 relaunch 仅一次，marker 放 userData/recovery，绑定 home 的匿名摘要、transaction id、attempt；窗口/进程重启不能重置该事务的预算。
- [ ] 独立 recovery BrowserWindow 使用独立非持久 partition，`contextIsolation/sandbox/webSecurity=true`、`nodeIntegration=false`，只加载固定本地 HTML/JS。preload 用 `.cts` 生成 `.cjs`，通过 sandbox 支持的 `require('electron')` 使用 contextBridge，不依赖 ESM preload，依据 [Electron ESM 限制](https://www.electronjs.org/docs/latest/tutorial/esm)。CSP 禁止网络与 inline script；摘要用 `textContent`。不能把 DSH 原页面换 URL 后继续赋予其 recovery IPC 权限。
- [ ] IPC 只开放 view、枚举 action；验证 exact webContents、main frame、固定恢复文档 origin/path、schema、当前 lifecycle state。拒绝错误窗口/子 frame/loopback 网页/导航后的 sender。doctor 只显示命令，不接受 UI 传入 shell 字符串执行解锁。
- [ ] 页面显示失败阶段、脱敏摘要、重试、Safe Mode、退出和适用的 lease 指引；未知 lease 禁用启动动作，退出后由 CLI doctor 检查。Safe Mode 实现在 Task 5 接入，Task 3 默认 `safeModeAllowed=false`。
- [ ] 运行 recovery controller/IPC 单测和 Host crash smoke，确认退出仍等待 Host 后释放 lease，提交 `feat: add isolated recovery controls and bounded retries`。

## Task 4：隔离已知的超大 projection cache

**Files:**

- Create: `packages/shell-core/src/projection-cache.ts`、`test/projection-cache.test.ts`
- Create: `packages/shell-core/test/projection-cache.integration.test.ts`
- Modify: `apps/desktop-launcher/src/main.ts`、`docs/data-layout.md`

**Interfaces:** 基线的 cache 为 `storages/session_projcache/sessions/` 下逐 session 文件，domain version 4；不能照旧教程只移动一个 `session_projcache.json`。

```ts
export type CacheQuarantineResult =
  | { kind: 'unchanged' | 'unknown-layout' }
  | { kind: 'quarantined'; relativeBackupPath: string; bytes: number }
export function quarantineProjectionCache(input: {
  home: string
  lease: HomeLease
  thresholdBytes: number
}): Promise<CacheQuarantineResult>
```

- [ ] 先写 sparse-file fixture 测试：低于阈值不动；超阈值原字节保留在备份；无 lease/活 Host/symlink/未知 layout 不移动；session JSONL 和其他 storage hash 不变。

```ts
const result = await quarantineProjectionCache({
  home: fixture.home, lease, thresholdBytes: 1024,
})
expect(result.kind).toBe('quarantined')
expect(await readFile(sessionLog, 'utf8')).toBe(originalSessionLog)
```

- [ ] 默认阈值定为 512 MiB，函数可注入小阈值测试，v1 不增加设置 UI。只识别固定基线的路径/布局；遇自定义 storage root/无法确定 profile patch 是否改变路由时返回 unknown-layout 并给诊断，不在 Main 执行任意 patch 计算路径。
- [ ] 在持 lease 且无运行 Host 时，将已确认的缓存目录同文件系统 rename 为 `storages/session_projcache.quarantine-<id>`；写前后相对路径/字节数 journal，保留备份，不自动删除。目录 inode/父路径变化就拒绝；EXDEV 不做复制后删除降级。
- [ ] 进程在 rename 前后退出后能从 journal 识别结果，不能再次误移备份；正常 Host 重建 cache 后会话仍完整。普通日志只写相对路径和大小。
- [ ] 跑单测/integration，提交 `feat: quarantine oversized rebuildable projection cache`。

## Task 5：独立 Safe Mode 与 recovery bridge

**Files:**

- Create: `packages/desktop-recovery-bridge/package.json`、`tsconfig.json`、`cordis.patch.yml`、`src/index.ts`、`src/runtime.ts`
- Create: `packages/desktop-recovery-bridge/test/runtime.test.ts`、`bundle.test.ts`
- Create: `packages/profile-manager/src/safe-profile.ts`、`test/safe-profile.test.ts`
- Create: `packages/host-supervisor/src/boot-profile.ts`、`test/safe-mode.integration.test.ts`
- Modify: `apps/desktop-launcher/src/host-entry.ts`、`electron-host-process.ts`、`main.ts`
- Modify: `packages/host-supervisor/src/host-runner.ts`、现有双向 Host-control fixtures
- Modify: workspace references、Vitest aliases、lockfile、boundary checker

**Interfaces:**

```ts
export const SAFE_BUNDLE_PREFIX = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@dsh-desktop/desktop-recovery-bridge',
] as const
export function prepareSafeProfile(ref: ProfileRef, lease: HomeLease): Promise<void>
export type BootMode = 'normal' | 'safe'
```

- [ ] 先写 safe-profile 单测：函数拒绝名字不是 `desktop-safe-mode` 的 ref，只允许精确三 bundle；不能保留注入到 safe profile 的第三方依赖；正常 desktop 目录内容不变。若 safe profile 出现未知用户内容，拒绝覆盖并留在本地恢复页，不能静默删依赖树。
- [ ] recovery bridge 遵循 ADR-0002，只依赖 connection/webServer/可选 desktopSurface：loopback 验证、只发布一次、缺少能力可读降级。独立 bundle patch 保留官方 Web runtime 配置并设置 `openBrowser=false/printUrl=false`；不能 import 正常 desktop-plugin 以复用其代码。
- [ ] Host runner 的 normal/safe 分支显式隔离。Safe 分支按发行版 install anchor 解析三包，构建自己的临时依赖投影；不调用会读 normal/profile-local/shared 第三方 fallback 的通用路径，不加载 normal `desktop` manifest、patch、node_modules。用注入必抛异常的第三方 bundle 证明没有执行。
- [ ] 继续读取同 home 的凭据、settings、sessions/storages。home patch 仍遵循主方案的共享语义；它损坏时 Safe Mode 也可能失败，回到 launcher 恢复页，不偷偷忽略或改写 home patch。Safe Mode 承诺隔离正常 profile，不能承诺修复所有 home 配置错误。
- [ ] bootstrap/runner 支持 `mode: 'safe'`；`profileName='desktop-safe-mode'`，surface `purpose='recovery'`，复用同一 Host-control version 与 lease generation；反方向组合拒绝。

```ts
expect(hello.mode).toBe('safe')
expect(hello.profile.name).toBe('desktop-safe-mode')
expect(surface.purpose).toBe('recovery')
expect(loadedBundles).toEqual([...SAFE_BUNDLE_PREFIX])
```

- [ ] 在 recovery controller 接上用户触发 Safe Mode：旧 Host 确认退出、更新 owner profile、准备 safe profile、创建新 attempt。退出 Safe Mode 后不自动改正常 profile，不提供猜测责任插件后的卸载按钮。
- [ ] 集成覆盖坏 normal bundle、坏 normal patch、坏 bridge、缺 bridge、坏 home patch、切换时 CLI 争用与正常 profile 不变；提交 `feat: add isolated safe mode recovery surface`。

## Task 6：恢复故障矩阵与 M2 验收

**Files:** Create `tests/smoke/profile-recovery.mjs`、`tests/smoke/safe-mode.mjs`、`docs/validation/m2-acceptance.md`；Modify smoke harness、root scripts、CI、README/主方案/架构/数据布局/开发指南/SECURITY。

- [ ] 新增 `smoke:profile-recovery`：自动 reconcile 后注入可定位 profile boot 故障，恢复 profile before，所有 home sentinel 不变；外部改候选 SHA 时显示 conflict，不覆盖；自动 relaunch 总数不超过 1。
- [ ] 新增 `smoke:safe-mode`：正常 profile 阻塞后点选 Safe Mode，官方 UI 可加载，第三方代码未执行；再令 bridge 失败，独立恢复窗口的退出和诊断仍有效。
- [ ] 故障矩阵覆盖 lease、profile-write、profile-composition、home-config、credentials、network、runtime、renderer、native-ui、unknown；每行记录是否改 profile、是否准许 rollback、实际前后 hash、Host PID/lease generation。
- [ ] 执行阶段门禁：

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 build:native
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
corepack pnpm@11.7.0 smoke:shared-home
corepack pnpm@11.7.0 smoke:profile-recovery
corepack pnpm@11.7.0 smoke:safe-mode
git diff --check
```

- [ ] 分别审查事务崩溃一致性、数据所有权、IPC sender/origin、Safe Mode 依赖隔离与 crash-loop 限额。记录实际执行的每个中断点，不以单元测试数量代替验收场景。
- [ ] 写验收记录并提交 `docs: record verified m2 recovery acceptance`。尚无安装包，当前能力只标源码级验收。

**M2 完成定义：** 所有自动修复都有可验证的文件所有权与修订条件；普通 Host/Safe Mode 都失败时仍能诊断和退出；home 权威数据未被启动恢复覆盖。
