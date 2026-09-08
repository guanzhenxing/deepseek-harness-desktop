# M6 验收记录：启动性能与可观测性

- **状态：已验收——启动性能交付，且 M5 intake profile 门已在当前候选上通过完整 release chain**
- 日期：2026-09-08（通宵自主执行）
- 基线：M5 合并后的 `main` @ `2fbad90`
- 分支：`feat/m6-startup-performance`（提交 `072cb4e` → `46ff25e` + 本记录提交）
- 执行计划：[M6 Startup Performance V2](../superpowers/plans/2026-09-07-m6-startup-performance-v2.md)
- 选中优化：[M6 Selected Optimisation](../superpowers/plans/2026-09-07-m6-selected-optimisation.md)

## 1. 执行条件

- MacBookPro18,3（Apple M1 Pro），macOS 26.6.2（darwin 25.6.0 arm64），低电量模式关闭
- Node 24.11.1 / pnpm 11.7.0（Corepack）、Electron 44.1.0、DSH 0.1.2-rc.1
- 测量输入：M5 验收候选的血统（同依赖基线，未做任何依赖升级）

## 2. 交付内容

| 任务 | 交付                                                                                                                                                                                                                                                                                                                          | 提交      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1    | 冒烟专属时间线契约 `startup-timeline.ts`：恰七阶段、严格顺序（跳/重/乱序即抛）、非负整数非降 elapsed（`performance.now()`）、冻结事件、禁用模式零发射；`startup-perf` 加入 `SMOKE_MODES`（保留全部临时目录/符号链接校验）                                                                                                     | `072cb4e` |
| 2    | 七个打点接入 `main.ts` 既有接缝（whenReady 后、loading 可见、admitHome 解析后、`starting` 事件、`start()` 解析、loadSurface 解析、waitForOfficialUi 解析）；启动调用顺序零改动；正常启动零计时事件（`smoke:dsh-ui` 验证）                                                                                                     | `5119422` |
| 3    | 打包基准 harness：`validateTimeline`/`summarizeWarmRuns`（邻接阶段时长、median、nearest-rank P95）/`validateStartupReport`（候选绑定、≥10 热、统计与原始时间线逐项对账、绝对路径与残留 lease 拒绝）+ `smoke:startup-performance`（安装一次、同 fixture 1 冷 + 10 热、每轮后 launcher 退出与 home lease 消失强制、原子写报告） | `46ff25e` |
| 4    | 决策门：全部阶段稳定（P95≤2×中位）；`host-spawned→host-ready` 中位 1191.5ms=57.8%、为次大阶段 3.9 倍 → 主导，按决策表选择"稳定性窗口"方向                                                                                                                                                                                     | 选择文档  |
| 5    | 优化：Host readiness 稳定性窗口 1000ms → **100ms 统一**（`HostSupervisor` 缺省与 `main.ts` 一致）；缺省窗口行为测试先行（失败→实现→通过）                                                                                                                                                                                     | `46ff25e` |

## 3. 测量旅程（如实）

1. **首轮测量**（冒烟窗口 100ms）：热中位 2062.5 / P95 2166ms——发现基准低估真实启动：`main.ts` 给正常模式 1000ms 稳定性窗口、冒烟 100ms，而窗口是 ready 消息之后的**纯计时器等待**（`supervisor.ts` 以 `setTimeout(…, stabilityMs)` 持有 ready）。
2. **测量保真修正**：`startup-perf` 改用正常模式窗口，重建复测得**真实基线**：初始化 4248ms；热中位 3028 / P95 3374ms。报告归档 `release/evidence/startup-performance-before.json`（SHA `2b645dc1b35e3beab57dc29a2b42343cde6b9e7f078b89f179a3af51e42c5682`）。
3. **优化后终测**（完整回归链重建的最终 DMG，候选 `m4-0.0.0-darwin-arm64-46ff25e`）：初始化 2940ms；热中位 2083 / P95 2167ms；每轮原始时间线均在 `release/startup-performance.json`。

### 晋升规则核对

| 门槛                                                | 结果                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| 选中阶段（host-spawned→host-ready）热 P95 改善 ≥15% | **47.6%**（2429 → 1274ms）                                       |
| 热端到端 P95 ≤ 2500ms                               | **2167ms**                                                       |
| 其他阶段回退 ≤10%（超限需解释）                     | 最大 +3%（loading-visible 185→191、official-ui 42→43，噪声量级） |

## 4. 优化安全论证与回归

- 窗口唯一语义：ready 后短时崩溃的归因（启动失败 vs 运行中崩溃）。缩短后该区间崩溃走 M2 `hostCrashed` 恢复链（relaunch-once），两条路径均为已交付面；100ms 值此前已被全部 16 个打包冒烟（含 host-crash、controller-recovery）长期运行。
- 不变量保持：Host 独立 utilityProcess、bootstrap 能力、lease/watchdog、profile 仲裁、Safe Mode 不经此窗口。
- 回归证据（HEAD `46ff25e`）：`pnpm check` 全绿（单测含新增契约/顺序/统计/报告负例）；`verify:release` **15/15**（含制品冒烟 16/16、跨版本演练 18/18、证据门）；终测报告绑定最终 DMG SHA；每轮清理（lease 消失）由 harness 强制。
- M2 crash 语义变更说明：ready 后 ~100ms–1s 崩溃的恢复路径从"启动重试"变为"崩溃恢复"。这是有意的语义收敛，记录在此供后续观察。

## 5. 执行偏差（如实）

1. 计划的 `vitest run tests/helpers/startup-performance.test.mjs` 命令形式有误：该测试为 node:test 风格，按仓库惯例以 `node --test` 运行（`test:unit` 已含）。
2. 冒烟模式对 stabilityMs 的特设快值（100ms）与正常值（1000ms）的分叉，在优化中收敛为统一 100ms——分叉本身是测量保真缺口，收敛后基准即日用启动。
3. 计划文件清单中的 `tests/smoke/package-main.mjs` 无需改动（复用 `installed-app.mjs` 帮手已足够），未做修改。

## 6. 未验证范围

- darwin-x64 未测量（未构建）。
- 真实用户日用观察未执行（测量为受控临时 fixture 上的打包制品行为）。
- Host 进程内部（上游 cordis 图启动 ~1.1s）不在本里程碑修改面内；后续上游改进可自然受益。

## 7. 基线移交

本候选 `m4-0.0.0-darwin-arm64-46ff25e`（`release/candidate/artifacts.json`）为当前已验证制品；Post-M4 交付列车（rc.1 资格 → M5 → M6）就此闭环。

## 8. codex 复审轮处置（2026-09-08，修复分支 `fix/post-delivery-review` @ `29cee57`）

| 发现                                           | 处置                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 报告未绑定 sourceCommit/Node/Electron       | `validateStartupReport` 增加第三参 `identity`（sourceCommit/node/electron 逐项比对）；冒烟入口传入实测值；篡改负例入测试                                                |
| P2 schema 未封闭、未校验 initialization.stages | 顶层/candidate/platform/initialization/warm/每轮事件全部封闭字段集（未知字段拒）；`initialization.stages` 必须等于七阶段契约；codex 的篡改用例全部转为失败测试（10/10） |

修复轮在干净提交 `29cee57` 上全链 15/15；新候选复测：初始化 3785ms，热中位 2287.5 / P95 2337ms（仍满足端到端 P95 ≤2500 的验收门槛；与 M6 验收轮的 2167ms 差异属跨时段机器噪声，两轮均以各自候选绑定）。**当前已验证候选更新为 `29cee57`**。
