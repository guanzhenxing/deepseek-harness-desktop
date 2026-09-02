# M1 Shared Home and Single Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 若 zcode 没有该技能，直接遵循本文复现失败、实现、验证、提交的步骤。用 `- [ ]` 跟踪进度；本轮只实施 M1。

**Goal:** Desktop 与 `dsh-native` 顺序共享同一 DSH home，并在任何 Host boot、profile 写入前证明整 home 排他所有权。

**Architecture:** 新增 Electron-free `home-lease`，由 launcher/CLI 包装进程持有长生命周期 lease。`profile-manager` 接收绑定 home 的活动 lease；Host 子进程先等待私有 bootstrap，owner 写入其操作系统身份后才允许 boot。应用单实例锁继续独立存在。

**Tech Stack:** 沿用 compatibility manifest 和 lockfile 中固定的 Node.js、pnpm、TypeScript、Vitest、Electron 与 DSH；macOS 进程身份/短临界区使用小型原生 helper，不引入 DSH Host 到 Main。

**Spec:** [主方案 §3.1–3.2、§5、§8.2、M1](../../native-dsh-desktop-plan.md)、[数据布局](../../data-layout.md)、[执行总览](2026-09-02-m1-m4-execution-roadmap.md)。

## Global Constraints

- 默认 profile：`desktop`；home 按 `$DSH_HOME`，否则 `~/.dsh` 解析；测试始终传入独立临时 home。
- 同一 home 只允许一个受支持 Host writer；不同 profile 不构成并发例外。
- owner 未知或任一相关进程仍活跃时不得清锁；不按时间、目录年龄或单独 PID 判断失效。
- 先确认所有 Host 子进程退出，再释放 lease；重试期间保留同一 generation。
- Main/renderer 不加载 DSH boot graph；包之间保持现有依赖方向；Host-control 保持 1.0。
- 不复制、迁移或自动恢复 credentials、settings、home patch、sessions、storages。
- 版本事实来自 `docs/compatibility.json` 和锁；新外部依赖精确固定。

---

## 入口门槛与文件责任

先跑总览中的五条 M0 命令。M1 新增包各包含 `package.json`、`tsconfig.json`、`src/index.ts`，随首个使用任务接入根 TS/Vitest 配置和 lockfile。

| 位置 | 责任 |
| --- | --- |
| `packages/product-config/` | 只读产品名、profile、namespace、app id、默认端口，不能 import Electron/DSH |
| `packages/home-lease/` | home 路径、owner schema、获取/释放、进程探测、受控 doctor |
| `packages/home-lease/native/lease-helper.c` | macOS 精确进程启动身份、短时间 advisory lock；不 boot DSH、不写 profile |
| `packages/profile-manager/src/reconcile.ts` | 保持现有保序 reconcile，改为同时支持活动 lease authority |
| `apps/bundled-cli/`、`scripts/dsh-native.mjs` | 持 lease 的 CLI 包装进程、等待 bootstrap 的官方 CLI 子进程 |
| `apps/desktop-launcher/`、`packages/shell-core/` | 获取 lease、监督 Host attempt、退出和诊断编排 |
| `tests/helpers/`、`tests/smoke/shared-home.mjs` | 临时数据与真实 Desktop/CLI 双向测试 |

## Task 1：产品配置、home 解析与测试数据边界

**Files:**

- Create: `packages/product-config/src/index.ts`
- Create: `packages/home-lease/src/home-paths.ts`
- Create: `packages/home-lease/test/home-paths.test.ts`
- Create: `tests/helpers/isolated-home.ts`
- Modify: `packages/host-supervisor/test/host-runner.integration.test.ts`、`tests/smoke/assert-cleanup.mjs`
- Modify: root `tsconfig.json`、两份 Vitest config、`package.json`、`pnpm-lock.yaml`

**Interfaces:** 消费显式 env/osHome/cwd，产出以下纯值；创建目录是后续 acquire 的职责。

```ts
export const PRODUCT = Object.freeze({
  name: 'DeepSeek Harness Desktop',
  appId: 'local.dsh.harness.desktop',
  binName: 'dsh-desktop',
  cliName: 'dsh-native',
  defaultProfileName: 'desktop',
  settingsNamespace: 'dsh-native-shell',
  defaultPort: 0,
  rendererPartition: 'persist:dsh-desktop-renderer',
})
export function resolveDesktopHome(input: {
  env: Readonly<Record<string, string | undefined>>
  osHome: string
  cwd: string
}): string
export interface IsolatedHomeFixture {
  home: string
  userData: string
  dispose(): Promise<void>
}
export function createIsolatedHomeFixture(): Promise<IsolatedHomeFixture>
```

- [ ] 写 home 单测，覆盖 unset/空白 env、相对路径、`~/` 展开、根目录拒绝。语义与本地固定版 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 做隔离进程对照；Main 不直接 import 此 DSH 包。

```ts
expect(resolveDesktopHome({ env: {}, osHome: '/Users/test', cwd: '/tmp/work' }))
  .toBe('/Users/test/.dsh')
expect(resolveDesktopHome({ env: { DSH_HOME: '  ' }, osHome: '/Users/test', cwd: '/tmp/work' }))
  .toBe('/Users/test/.dsh')
expect(resolveDesktopHome({ env: { DSH_HOME: 'data' }, osHome: '/Users/test', cwd: '/tmp/work' }))
  .toBe('/tmp/work/data')
```

- [ ] 用 `pnpm exec vitest run packages/home-lease/test/home-paths.test.ts` 观察缺失函数导致失败，再实现解析。将产品值从 `main.ts`/window policy 收敛到配置包；不移动 DSH 业务到配置包。
- [ ] fixture 使用 `mkdtemp`；记录 realpath/dev/ino；写入前拒绝真实 home、环境 DSH_HOME、仓库或根目录；清理前复核目录身份。迁移原 M0 测试复用其保护逻辑。
- [ ] 更新数据布局中的产品名、路径解析语义；增加依赖边界用例禁止配置包引入 Electron/DSH。
- [ ] 运行相关单测、`pnpm check`，提交 `feat: define shared home and desktop product configuration`。

## Task 2：可证明所有权的 lease 协议

**Files:**

- Create: `packages/home-lease/src/owner.ts`、`lease.ts`、`process-probe.ts`、`native-helper.ts`
- Create: `packages/home-lease/native/lease-helper.c`
- Create: `scripts/build-lease-helper.mjs`
- Create: `packages/home-lease/test/lease.test.ts`、`lease.integration.test.ts`
- Create: `docs/protocols/home-lease.md`、`docs/adr/0005-home-lease-process-identity.md`
- Modify: `scripts/verify-boundaries.mjs`、其测试、`docs/adr/README.md`

**Interfaces:** `ProcessIdentity.startIdentity` 是操作系统启动时间/身份，和 M0 私有握手 nonce 不同。

```ts
export type ProcessIdentity = Readonly<{ pid: number; startIdentity: string }>
export type ProcessStatus = 'same' | 'absent' | 'different' | 'unknown'
export type LeaseOwner = Readonly<{
  schemaVersion: 1
  generation: string
  supervisor: ProcessIdentity
  host: ProcessIdentity | null
  pendingSpawn: boolean
  entrypoint: 'desktop' | 'bundled-cli'
  profile: string
  createdAt: string
  appVersion: string
}>
export interface ProcessProbe {
  current(): Promise<ProcessIdentity>
  identify(pid: number): Promise<ProcessIdentity>
  inspect(identity: ProcessIdentity): Promise<ProcessStatus>
  scanSupported(): Promise<'none' | 'active' | 'unknown'>
}
export interface HomeLease {
  readonly home: string
  readonly generation: string
  assertHeld(): Promise<void>
  beforeSpawn(profile: string): Promise<void>
  attachHost(identity: ProcessIdentity): Promise<void>
  confirmHostExited(): Promise<void>
  release(): Promise<void>
}
export function acquireHomeLease(input: {
  home: string
  entrypoint: LeaseOwner['entrypoint']
  profile: string
  appVersion: string
  probe: ProcessProbe
}): Promise<HomeLease>
```

- [ ] 先记录 ADR：`host.lock` 仍用原子 `mkdir` 获取；新增 `<home>/run/host-lease.guard` 为永久 owner-only advisory-lock 文件，获取、owner 更新、释放、doctor 清理都在该短临界区内执行。guard 不代表长 lease、不按年龄删除，helper 退出由 OS 释放内核锁，避免两个 doctor 删除新 generation 的竞态。
- [ ] 原生 helper 使用 macOS `proc_pidinfo` 的启动秒/微秒与 PID 生成身份；权限不足返回 `unknown`。guard 使用 `open`/`O_NOFOLLOW`、`flock(LOCK_EX | LOCK_NB)` 和父目录身份检查；持锁 helper 的 stdin 关闭后退出。`probe`/`scan` 只返回结构化身份或状态，不输出完整 argv/env。编译用 Xcode Command Line Tools，产物放忽略目录，M3 随包提供；Linux 单测使用注入 probe，不宣称支持 Linux runtime。
- [ ] 先写失败测试：同 home 不同 profile 竞争只有一个 winner；活 owner/未知 owner 拒绝；记录换 generation 后旧 handle 不能释放；Host 活跃时 release 拒绝；多次 release 幂等；`pendingSpawn` 中断进入保守诊断。

```ts
const input = { home: fixture.home, entrypoint: 'desktop' as const,
  profile: 'desktop', appVersion: '0.0.0', probe }
const first = await acquireHomeLease(input)
await expect(acquireHomeLease({ ...input, profile: 'headless' }))
  .rejects.toMatchObject({ code: 'HOME_BUSY' })
await first.release()
await first.release()
```

- [ ] 实现 closed owner schema、`0700` 目录/`0600` 文件、路径包含关系及 symlink 检查。复用精确版本 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`，并补 owner 文件和父目录 fsync；上游该函数本身不承诺 crash durability。只有 home-lease 允许导入这个无 Host boot 的小包，边界检查验证传递依赖。
- [ ] 正常 acquire 遇已有 owner 时只报 busy/stale/unknown，M1 不自动回收旧锁。release 在 guard 内重读 generation、supervisor 身份及 inode；确认 Host 已退出后才移除自己持有的 lock。禁止把 `kill(pid, 0)` 成功当作身份相同。
- [ ] 运行 lease 单测及 macOS 双进程抢锁/双 doctor 竞态集成；增加根脚本 `build:native`，运行 `pnpm build:native && pnpm test:integration`。提交 `feat: add process-aware home lease protocol`。

## Task 3：launcher 先持 lease 再启动 Host

**Files:**

- Modify: `packages/profile-manager/src/reconcile.ts`、`src/index.ts`、`test/reconcile.test.ts`
- Modify: `packages/shell-core/src/lifecycle.ts`、`test/lifecycle.test.ts`
- Modify: `packages/host-supervisor/src/supervisor.ts`、`test/supervisor.test.ts`
- Modify: `apps/desktop-launcher/src/main.ts`、`electron-host-process.ts`、`host-entry.ts`、`host-environment.ts`
- Create: `apps/desktop-launcher/src/lease-diagnostics.ts`、`test/shared-home.test.ts`
- Modify: `packages/host-supervisor/src/runtime-root.ts`、`host-runner.ts`

**Interfaces:** `reconcileDesktopProfile(ref, authority)` 的 authority 扩展为现有 `IsolatedHomeAuthority | HomeLease`，活动 lease 由包内品牌/实例校验，不能用 `{ home, generation }` 字面量伪造。Shared 模式每次写入前调用 `assertHeld()`。

```ts
export interface HostAttempt {
  start(): Promise<HostReady>
  stop(reason: 'quit' | 'restart', deadlineMs: number): Promise<void>
}
export type CreateHostAttempt = (lease: HomeLease) => HostAttempt
```

- [ ] 写生命周期失败测试，断言顺序 `lease → reconcile → beforeSpawn → spawn(waiting) → attachHost → bootstrap → ready`；busy 时 reconcile/spawn 调用次数都为 0；退出与 spawn 同时发生时新子进程也被等待并回收。

```ts
expect(events).toEqual([
  'lease', 'reconcile', 'before-spawn', 'spawn-waiting',
  'attach-host', 'bootstrap', 'ready',
])
```

- [ ] 重构 factory：先创建等待 bootstrap 的 utility process，取得 OS 身份并 `attachHost` 持久化，再发启动授权。M0 随机 `startIdentity` 可继续用于通道握手，不能写成 lease 的 OS 身份。失败与 stop 并发时不得漏掉 late-spawn 子进程。
- [ ] Host 等待 bootstrap 有超时；父控制通道断开就 dispose 并退出，boot 卡住则 supervisor 升级 terminate/kill。`pendingSpawn` 在创建进程前持久化；无法完整登记的子进程从未收到 boot 授权，doctor 仍扫描并等待其退出。
- [ ] 从入口 env 解析 home 后再清理 Host 环境；bootstrap 中传入唯一解析后的 home。保留屏蔽 `NODE_OPTIONS`、`NODE_PATH` 和 Electron 控制变量。保留 M0 smoke 隔离入口，禁止 smoke 回落到真实默认 home。
- [ ] 退出流程收敛为 `stop attempt → confirmHostExited → release lease → app.quit`；启动失败也在 stop 确认后退出/进入诊断。若无法证明 Host 已死，保留 lease 并报告，不在 `finally` 无条件清锁。
- [ ] 继续使用 home 下的中性 `.dsh-desktop-run-*` 临时根及既有 fallback 解析，所有相关写入已受 lease 覆盖；M1 不无故迁移模块查找根。配置 runtime cwd 为该中性目录，不继承项目 cwd 的配置。清理仍复核 dev/ino。
- [ ] 运行上述单测、真实 Host integration、两条 M0 smoke；提交 `feat: guard desktop startup and shutdown with home lease`。

## Task 4：配套 CLI 与安全 doctor

**Files:**

- Create: `apps/bundled-cli/src/main.ts`、`cli-child.ts`、`doctor.ts`、`runtime-paths.ts`
- Create: `apps/bundled-cli/test/cli.test.ts`、`doctor.integration.test.ts`
- Create: `scripts/dsh-native.mjs`
- Create: `packages/home-lease/src/doctor.ts`
- Modify: root `package.json`、workspace references、`docs/protocols/home-lease.md`

**Interfaces:** Wrapper 只识别自己的 `doctor --unlock`，其他 argv 保持原顺序传给固定版官方 `@deepseek-ai/dsh/lib/bin.js`，以 package `bin.dsh` 解析入口，不能依赖其内部 hash 文件名。

```ts
export type UnlockResult =
  | { status: 'unlocked' | 'already-unlocked' }
  | { status: 'refused'; code: 'ACTIVE_OWNER' | 'IDENTITY_UNKNOWN' | 'LEASE_CHANGED' }
export function unlockHome(input: {
  home: string
  probe: ProcessProbe
}): Promise<UnlockResult>
export function runBundledCli(argv: readonly string[]): Promise<number>
```

- [ ] 写 argv/exit/signal 测试：`--profile headless`、`plugin --profile desktop`、含空格参数、`--`、`--patch` 原样转发；`doctor --unlock` 不能 boot DSH；CLI busy 在 child import 官方入口前退出。

```ts
expect(forwardedArgv).toEqual([
  'plugin', '--profile', 'desktop', 'add', '@example/a',
])
expect(events.indexOf('attach-host')).toBeLessThan(events.indexOf('import-dsh-bin'))
```

- [ ] 用 `fork`/私有 IPC 启动 `cli-child`，child 等待授权后设置 `process.argv` 并 import 官方 bin；继承交互 stdin/stdout/stderr、转发终止信号与退出码。`plugin` 管理期间包装进程持 lease，等待它及写 home 的后代结束；不使用 shell 拼接 argv。
- [ ] CLI 运行时开发阶段使用固定 Node；M3 将同一 wrapper 和固定 Node runtime 装入 `.app`。默认不把 CLI profile 偷换成 `desktop`，遵循上游必需的 `--profile`/`web` 语义；owner 保存已解析目标 profile，解析与上游做对照测试。
- [ ] doctor 在 guard 内重读 owner，探测 supervisor 和 Host。合法旧 owner 的两个身份均不存在/已不同、且无 pending 未确认 writer 才能移除；缺失/坏 owner 先扫描受支持 launcher/CLI/Host 进程。无法排除活进程一律拒绝；`--unlock` 本身就是用户明确清理请求，不提供 `--force` 绕过。
- [ ] 扫描排除正在执行且已验证身份的 doctor 自身和它的只读 helper；不能因为本次 doctor 在进程表中就永远拒绝解锁。其他运行中的包装进程及写入后代保持保守判断。
- [ ] 获取、doctor、release 都使用同一 guard，删除前复核快照；并发新 acquisition 不可能被旧 doctor 删除。扫描只在内存中检查已知入口/运行时与亲缘，信息不足返回 unknown，不输出敏感命令行。
- [ ] Desktop lease 对话框和 stderr 给出 owner 类型/profile/PID，以及 `dsh-native doctor --unlock`。自定义 home 显示“使用相同 DSH_HOME”，普通日志不打印完整路径。定义 busy/unknown 的 CLI 非零退出码并写入协议。
- [ ] 增加 `pnpm dsh-native -- ...` 开发入口；运行 CLI/doctor 单测和集成，提交 `feat: add leased dsh-native cli and owner diagnostics`。

## Task 5：共享数据的真实双向验证

**Files:**

- Create: `tests/helpers/mock-llm.mjs`、`tests/helpers/shared-home-driver.mjs`
- Create: `tests/smoke/shared-home.mjs`
- Create: `apps/bundled-cli/test/shared-home.integration.test.ts`
- Modify: `tests/smoke/assert-cleanup.mjs`、root `package.json`、`.github/workflows/ci.yml`
- Modify: `packages/desktop-plugin/src/index.ts`、`runtime.ts`（namespace/端口配置需要时）

**Interfaces:** 定义 `runSharedHomeScenario(direction: 'cli-to-desktop' | 'desktop-to-cli'): Promise<{ sessionId: string; persistedTurns: number }>`；driver 负责创建/清理 fixture 与全部子进程。mock LLM 返回确定的一轮内容，不访问付费模型。

- [ ] 建立真实官方 DSH profile 的合成凭据/settings fixture 和本地 loopback mock LLM；依据固定版上游 client 接口生成响应。测试驱动走 CLI/官方 Web 的会话操作，不直接伪造 JSONL 来代替“创建并继续”。
- [ ] 新增 `test:shared-home`，运行两种方向：A 创建会话并完全退出；B 列出同一 session id、继续一轮、退出；重新读取验证持久化。缺少真实继续操作不能只凭文件存在判通过。

```ts
const cliFirst = await runSharedHomeScenario('cli-to-desktop')
const desktopFirst = await runSharedHomeScenario('desktop-to-cli')
expect(cliFirst.persistedTurns).toBe(2)
expect(desktopFirst.persistedTurns).toBe(2)
```

- [ ] Desktop 活跃时 CLI boot 和 plugin mutation 均被拒绝；CLI 活跃时 Desktop 在 reconcile 前拒绝；两个入口同 home 不同 profile 仍互斥。注入 Host restart 间隙，第三入口仍无法获得 lease。
- [ ] 两入口读取同一份伪 credentials/settings；用 sentinel 确认没有复制到 userData。namespace 只使用 `dsh-native-shell`，默认端口为 0，host 固定 `127.0.0.1`；不新增 wizard 或重写用户 YAML。
- [ ] 新增 `smoke:shared-home` 包装上述真实 UI/CLI 场景；macOS job 运行原生 helper、integration 与 smoke，Linux job 保留纯单测。失败保留脱敏证据，进程和 fixture 安全清理。
- [ ] 运行 `pnpm test:shared-home`、`pnpm smoke:shared-home`，提交 `test: prove sequential shared home desktop and cli use`。

## Task 6：M1 验收与交接

**Files:** Modify `README.md`、`docs/development.md`、`docs/architecture.md`、`docs/data-layout.md`、`SECURITY.md`、主方案；Create `docs/validation/m1-acceptance.md`。

- [ ] 执行完整门禁并保存实际结果：

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 build:native
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
corepack pnpm@11.7.0 smoke:shared-home
git diff --check
```

- [ ] Standards：检查依赖图/路径/日志；Spec：逐项对应主方案前四项共享 home 测试；安全：检查 owner 原子边界、PID 重用、pending spawn、双 doctor、late spawn 与父退出。
- [ ] README 明确 `dsh-native` 才是遵守 lease 的受支持 CLI，其他裸 `dsh` 不受本项目拦截，使用前必须完全退出 Desktop。M1 仍是源码阶段，不写“可日用 DMG”。
- [ ] 记录实际提交、环境、故障注入结果，提交 `docs: record verified m1 shared home acceptance`。只有全部必需门禁通过才勾选本 Task 并开始 M2。

**M1 完成定义：** 双向接续真实会话、同 home 串行化、所有权诊断和安全退出均有测试证据；M2 的修订恢复/Safe Mode 与 M3 打包仍未交付。
