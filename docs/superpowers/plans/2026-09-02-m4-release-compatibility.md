# M4 Release Compatibility and Upgrade Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 若 zcode 无该技能，按本文逐项执行；真实升级需要独立候选分支，不能夹带壳重构。

**Goal:** 每个候选制品都能追溯到固定 DSH 和完整依赖闭包；升级后可以重启，旧候选只在有证据兼容当前数据时被允许启动。

**Architecture:** Electron-free `release-compatibility` 负责清单 schema 与纯预检，launcher/CLI 在 lease 后、任何业务写入前执行 admission。构建脚本从版本锁、经验证的格式目录和补丁账本生成内嵌清单与外置制品摘要；升级测试只操作合成或已脱敏的数据副本。

**Tech Stack:** 复用 M3 制品流水线、SHA-256、closed JSON schema、隔离 fixture、macOS 已安装应用 smoke；不新增在线 updater。

**Spec:** [主方案 §7–9、M4、v1 完成定义](../../native-dsh-desktop-plan.md)、[数据布局](../../data-layout.md)、[M3 计划](2026-09-02-m3-packaged-desktop.md)、[执行总览](2026-09-02-m1-m4-execution-roadmap.md)。

## Global Constraints

- 前提是 M3 已交付带 home admission reader 的健康 DMG 和 SHA；无此制品先补 M3，不能用源码替代 previous candidate。
- 依赖逐包精确固定；所有 DSH runtime 包对应同一上游基线，不能把独立版本的 Cordis 等包错误要求成 DSH 版本号。
- 版本事实从 lockfile/构建输入生成；关于页、诊断和文档不维护另一套版本事实。
- Desktop 升级不升级用户第三方插件；本地补丁/自建制品必须有来源和摘要。
- 不可读或未知数据格式先拒绝，不调用 Host “试一下能不能启动”。
- 旧 DMG 只回退二进制，不能自动把新数据变回旧格式；不可逆迁移需要独立 ADR、停写和可验证备份。
- 没有新上游 tag 时做同基线重装/重启及拒绝降级负例，不虚构真实版本升级。

---

## 文件与权威分工

| 文件/目录 | 权威 |
| --- | --- |
| `docs/compatibility.json` | 源码基线事实，保留现有 Desktop/DSH/Electron/Node/pnpm/Host-control 字段 |
| `build/compatibility-policy.json` | 经测试支持的 profile、plugin API、provider 格式与 dataEpoch 策略 |
| `build/upstream-artifacts.json` | npm integrity 或自建 runtime 制品出处/commit/SHA |
| `patches/manifest.json` | 本地补丁、上游是否包含、回归证据；无补丁用显式空数组 |
| `release/*/compatibility.json` | 从上述输入及实际 staged runtime 生成的内嵌发行清单 |
| `release/artifacts.json`、`SHA256SUMS` | M3 建立的外置 DMG 摘要/平台/架构/releaseId 关联 |
| `<home>/run/compatibility.json` | M3 schema 1 marker，记录兼容性 epoch/格式与最后可能写入的 release |
| `docs/validation/m4-acceptance.md` | 可追溯验收摘要；不是运行时版本权威 |

## Task 1：生成并校验完整发行清单

**Files:**

- Create: `packages/release-compatibility/src/manifest.ts`、`test/manifest.test.ts`
- Create: `build/compatibility-policy.json`、`build/upstream-artifacts.json`
- Create: `scripts/generate-compatibility.mjs`、`verify-compatibility.mjs`、`verify-compatibility.test.mjs`
- Modify: `docs/compatibility.json`、`scripts/verify-docs.mjs`、`scripts/stage-runtime.mjs`
- Modify: `apps/desktop-launcher/src/native-ui.ts`、CLI diagnostics

**Interfaces:** 下列字段加在现有事实之上；内嵌清单 schema 与 home marker schema 是两套独立版本，不能混用。

```ts
export type FormatRule = Readonly<{
  provider: string
  providerVersion: string
  formatId: string
  readable: readonly string[]
  writable: string
  evidence: readonly string[]
}>
export type ReleaseManifest = Readonly<{
  schemaVersion: 2
  releaseId: string
  desktopVersion: string
  sourceCommit: string
  dsh: { tag: string; commit: string; npmVersion: string }
  platform: 'darwin'
  arch: 'arm64' | 'x64'
  hostControl: { major: number; minor: number }
  profileSchemaVersion: number
  pluginApi: { strategy: 'verified-exact-baseline'; dshVersion: string; singletonPackages: readonly string[] }
  formats: readonly FormatRule[]
  dataEpoch: number
  supportedDataEpochs: readonly number[]
  dependencyClosureSha256: string
  patchManifestSha256: string
}>
export function parseReleaseManifest(input: unknown): ReleaseManifest
```

- [ ] 先写 schema 和生成器失败测试：缺 commit、混合 DSH 基线、未知 schema、空 supportedDataEpochs、声明可写却不可读、平台不匹配、闭包 hash 不匹配都拒绝。

```ts
expect(() => parseReleaseManifest({ schemaVersion: 999 }))
  .toThrow()
expect(manifest.supportedDataEpochs).toContain(manifest.dataEpoch)
expect(manifest.formats.every((format) => format.readable.includes(format.writable)))
  .toBe(true)
```

- [ ] 不杜撰上游 plugin API semver。当前没有已核实的独立 API 版本时，策略固定为 `verified-exact-baseline`，声明 DSH 精确版本和实际 singleton 包；通过真实 bundle 加载测试提供支持证据。
- [ ] 逐一检查锁定 provider 的已安装源码和文件头：credentials、settings、session JSONL、storage domain、projection cache、profile。把解析器版本/文件头 schema/可读范围写入 policy；没有官方数值版本时使用说明来源的项目 formatId 和 fixture hash，不伪称上游定义了 schema 1。未知格式不得加入支持清单。
- [ ] 生成器读取根/package 版本、完整 lock、policy、补丁与 staged tree，输出稳定排序清单；releaseId 绑定 source commit、目标架构和清单输入摘要。重复相同输入应生成相同兼容性内容，不要求 DMG 时间戳导致的二进制逐位相同。
- [ ] source `docs/compatibility.json` 保留其已存在字段/检查，增加 release schema 映射而非复制 artifact SHA；安装制品 SHA 继续外置关联。关于页和 CLI version/diagnostic 从内嵌清单读值。
- [ ] 新增 `generate:compatibility`、`verify:compatibility`；验证 schema 单测、生成再校验，再提交 `build: generate verified release compatibility manifests`。

## Task 2：依赖闭包、singleton 与补丁对账

**Files:**

- Create: `scripts/verify-dsh-closure.mjs`、`verify-dsh-closure.test.mjs`
- Create: `patches/manifest.json`、`docs/upstream-baseline.md`
- Create: `scripts/verify-patches.mjs`
- Modify: root `package.json`、CI、runtime-tree validator、`build/upstream-artifacts.json`

**Interfaces:** 生成的闭包记录是 `Array<{ name: string; version: string; integrity: string; relativePath: string }>`；排序后 SHA 进入 release manifest。

```json
{
  "schemaVersion": 1,
  "patches": []
}
```

- [ ] 建立负例 fixture：一个 DSH 包漂到其他版本、runtime 包使用浮动范围但未被本项目 override 锁住、同 Host 出现第二份 Cordis/React、树外 symlink、缺少 Web asset，分别导致检查失败。
- [ ] 同时检查 catalog/overrides/lockfile 与最终安装闭包，不能只检查顶层 `@deepseek-ai/dsh`。单独分类 Cordis 等独立版本包；它们按已验证清单的版本/realpath 检查，不按 `@deepseek-ai/*` 正则粗暴推断版本。
- [ ] 从 Host runner、normal/safe bundle、CLI entry 三个解析锚点探测包路径；每个运行时闭包验证 singleton；Node CLI 与 Electron Host 两个进程可以有各自依赖树，但不得混用 native ABI。
- [ ] 当前使用 npm 发布包则记录 lock integrity 与上游 tag/commit 的来源核对证据；不要为满足表头制造不存在的 fork release。使用自建 fork 时记录构建脚本、上游 commit、patch digest、制品 URL/本地归档和 SHA，来源缺失阻止放行。
- [ ] 对每个真实补丁记录 `id/file/upstreamCommit/reason/testCommand/status`，并执行三问：上游是否已修、能否干净应用、移除补丁是否能复现对应失败。无补丁时保留上面的空账本和验证结果，不写假补丁。
- [ ] `verify:dsh-closure`、`verify:patches` 接入 package/release gate，生成 `docs/upstream-baseline.md` 的证据链接及补丁去留结论，提交 `build: enforce dsh dependency closure and patch provenance`。

## Task 3：所有受支持入口的只读预检与写入预约

**Files:**

- Create: `packages/release-compatibility/src/inspect-home.ts`、`preflight.ts`、`home-marker.ts`
- Create: `packages/release-compatibility/test/preflight.test.ts`、`preflight.integration.test.ts`
- Modify: M3 `home-admission.ts`、launcher/CLI/安全模式入口、`docs/protocols/home-compatibility.md`
- Modify: `docs/data-layout.md`、`docs/adr/0008-home-compatibility-admission.md`（通过补充记录说明实现细节，不改写原决策理由）

**Interfaces:** home 检查器只解析已知文件头/布局，不加载 DSH/用户插件、不启动 provider 做探测。

```ts
export type HomeFormatState = Readonly<{
  fresh: boolean
  formats: Readonly<Record<string, string>>
  unknownPaths: readonly string[]
}>
export type PreflightResult =
  | { kind: 'allow'; dataEpoch: number; formats: Readonly<Record<string, string>> }
  | { kind: 'refuse'; code: 'UNKNOWN_FORMAT' | 'UNREADABLE_FORMAT' | 'UNSUPPORTED_EPOCH' | 'MIGRATION_REQUIRED' }
export function inspectHomeFormats(home: string): Promise<HomeFormatState>
export function preflightHome(input: {
  release: ReleaseManifest
  marker: HomeCompatibilityMarker | null
  observed: HomeFormatState
}): PreflightResult
export function reserveHomeWrite(input: {
  home: string
  lease: HomeLease
  release: ReleaseManifest
  decision: Extract<PreflightResult, { kind: 'allow' }>
}): Promise<void>
```

- [ ] 先写测试：缺 marker 的全新 home 可进入；已有 home 的 provider 格式必须可识别；marker/磁盘不一致、未知格式、当前 release 不支持 epoch/readable 均拒绝。拒绝路径除获取/释放 lease 产生的协调元数据外，不触碰 profile/cache/user data。

```ts
expect(preflightHome({ release: previousRelease,
  marker: newerMarker, observed: newerFixtureFormats }))
  .toEqual({ kind: 'refuse', code: 'UNSUPPORTED_EPOCH' })
expect(events).not.toContain('reconcile')
expect(events).not.toContain('spawn-host')
```

- [ ] 读取 `.credentials.yaml` 等文件只验证结构/格式，不输出字段值；敏感文件内容不进 marker。自定义 provider 数据无法识别时保留原状并诊断，不能静默当作当前 schema。
- [ ] 调用顺序固定 `acquire lease → parse marker → inspect → preflight → reserveHomeWrite → profile/cache → boot`；Desktop、CLI、Safe Mode、会修改 home 的 plugin 命令共享该顺序。doctor 只做 lease 诊断/清理，不通过它写格式 marker。
- [ ] `reserveHomeWrite` 在潜在新格式写入之前，原子持久化 schema 1 marker 的候选 epoch、releaseId、format 签名；失败启动也不自动降低 epoch，以防已经部分写入。支持格式变化需先有测试证据；不能无故把每个新 Desktop 版本都设成新 epoch。
- [ ] M3 reader 已能拒绝 epoch 2；M4 保持 schema 1 字段合法，即便升级失败也不让旧包错误认为仍安全。旧的无 guard M0/其他 CLI 不列入受支持回退对象，文档明确直接运行它们无法受此机制约束。
- [ ] 本阶段不实现自动不可逆迁移。若真实候选依赖迁移，则 preflight 返回 MIGRATION_REQUIRED，先补独立迁移 ADR/离线备份验证再考虑升级；保留现有健康版可用。运行失败注入及 no-write 测试，提交 `feat: enforce compatibility before shared home writes`。

## Task 4：上一健康制品到候选制品的演练

**Files:**

- Create: `tests/upgrade/rehearsal.mjs`、`tests/upgrade/fixtures/manifest-cases.json`
- Create: `tests/helpers/upgrade-fixture.mjs`、`scripts/rehearse-upgrade.mjs`
- Create: `docs/upgrade-guide.md`
- Modify: root scripts、私有 CI artifact 选择流程

**Interfaces:** `rehearse:upgrade` 显式接收旧/新 artifact index，不使用“最新文件”猜测对象。

```bash
corepack pnpm@11.7.0 rehearse:upgrade -- \
  --previous release/previous/artifacts.json \
  --candidate release/candidate/artifacts.json
```

- [ ] 从 M3 健康制品在临时 home 创建两轮合成会话、settings sentinel、一个第三方 fixture bundle，完全退出并保存数据副本；校验副本与原 fixture 摘要，后续所有演练只用副本，不读用户真实 home。
- [ ] 先验证 release index/DMG/内嵌清单 SHA，再安装候选到另一临时应用目录。旧应用退出并释放 lease 后，候选读取同一副本，继续会话，退出、重启、再次读取，验证历史和新增内容。
- [ ] 当前阶段执行时检查上游是否出现新 tag。有合适候选才另开 `codex/upgrade-dsh-<实际标签>` 更新 tag/commit/闭包；保持功能/架构分支独立。没有新 tag 时记录 `same-baseline-reinstall`，不伪造升级成功记录。
- [ ] 拒绝降级负例：在独立 fixture 中写入合法 schema 1/epoch 2 marker，启动真实 M3 previous `.app`，验证在 profile/cache/Host 写入前拒绝；另测新 schema、未知 provider 格式和损坏 marker。负例属于故障注入，不声称存在真实上游新数据版本。
- [ ] 兼容回退正例：清单和格式检查明确证明 previous 支持该 fixture 时，用其继续会话；若没有可证明兼容的真实旧版，则记录“只有拒绝负例/同基线回装完成”，不能宣称验证了跨版本降级。
- [ ] Desktop 版本替换前后，第三方 fixture package/lockfile 摘要不变；任何兼容性拒绝都不偷偷卸载、升级用户插件或重写 home settings。
- [ ] 故障注入 reserve marker 后/Host 首写后崩溃、退出时 lease 仍忙、候选制品损坏，检查清理与保守拒绝。备份恢复只允许恢复到新的测试目录验证，不自动覆盖原 home。
- [ ] 写 `upgrade-guide.md`：退出旧程序、检查制品与兼容性、复制备份、替换应用、启动验证、保留旧 DMG、拒绝降级时保留数据并恢复兼容应用。执行演练并提交 `test: rehearse packaged upgrades and reject unsafe downgrades`。

## Task 5：v1 放行证据和人工观察

**Files:** Create `docs/validation/m4-acceptance.md`；Modify release scripts、CI、README/开发指南/主方案/架构/数据布局/SECURITY。

- [ ] 将门禁分为快速 `check` 与完整 `verify:release`；后者必须聚合兼容性、闭包、补丁、真实共享 home、源码/安装包 smoke、升级演练，不能只跑构建。

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 generate:compatibility
corepack pnpm@11.7.0 verify:compatibility
corepack pnpm@11.7.0 verify:dsh-closure
corepack pnpm@11.7.0 verify:patches
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 package:dmg
corepack pnpm@11.7.0 smoke:package
corepack pnpm@11.7.0 verify:artifacts
corepack pnpm@11.7.0 rehearse:upgrade -- --previous release/previous/artifacts.json --candidate release/candidate/artifacts.json
git diff --check
```

- [ ] candidate/previous 目录由 release 脚本显式归档；复制后重新验证 digest，不能重新命名或修改已验收 DMG 的内部内容。保留上一健康制品和候选各自的测试摘要，不覆盖旧结果。
- [ ] Standards 审查版本唯一来源、边界、日志；Spec 对照 v1 完成定义逐条引用任务与测试；安全审查拒绝发生在写入前、marker 崩溃一致性与旧 guard 行为。
- [ ] 记录制品路径/SHA、基线 commit/tag、运行架构、Node/Electron 真实运行版本、本地补丁列表、所有门禁结果，以及是否实际跨上游版本升级。
- [ ] 交付状态分为 `candidate-verified` 与 `current`。自动测试完成只标前者；用户至少完成一个正常工作日的人工使用观察，记录启动、退出、会话继续、托盘/恢复体验后才标 current。用户未观察时明确留下此项，不伪造完成。
- [ ] 更新 README 手动升级/回退限制、支持架构与配套 CLI，提交 `docs: record verified v1 release candidate and upgrade evidence`。用户未授权公开发行时不创建公开 release 或自动上传到公开地址。

**M4 完成定义：** 候选制品闭包和来源可验证、升级/重启和拒绝降级具有真实制品证据、上一健康 DMG 已保留；正式“当前日用版”还以人工观察记录为最后放行条件。
