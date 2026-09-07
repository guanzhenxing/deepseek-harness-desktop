# M6 Selected Optimisation: Host Readiness Stability Window

- 日期：2026-09-08
- 状态：选定（依据 `release/startup-performance.json` 基线测量，候选 `m4-0.0.0-darwin-arm64-5119422`）
- 上游计划：[M6 Startup Performance V2](2026-09-07-m6-startup-performance-v2.md) Task 4

## 1. 选中的行（决策表唯一一行）

**`host-spawned` → `host-ready`** —— 允许方向："verify compile-cache hits or defer non-ready Host work"；强制不变量：Host 独立进程、bootstrap 能力、lease、profile 仲裁、Safe Mode 全部保持。

## 2. 测量依据

热启动（10 次，同一安装/家目录/userData）阶段中位数：host-spawned→host-ready **1191.5ms（占 57.8%）**，是次大阶段（surface-loaded 304.5ms）的 **3.9 倍**；P95/中位 = 1265/1191.5 ≤ 2（稳定）。初始化轮同阶段 1686ms（编译缓存冷）。

源码定位：`HostSupervisor` 在收到 Host 的 ready 消息（surface + origin 已到）之后，用 `setTimeout(…, stabilityMs)` **额外持有 ready** 才解析 `start()`——这段是纯等待，不属于任何 Host 工作。`apps/desktop-launcher/src/main.ts` 将正常模式配置为 **1000ms**、冒烟模式 100ms：

```ts
stabilityMs: smokeMode === undefined ? 1_000 : 100,
```

即真实用户每次启动在主导阶段多付 **900ms 纯计时器等待**；同时基准（冒烟模式）因此低估真实启动。

## 3. 变更（两步，先保真后优化）

1. **测量保真**：`startup-perf` 冒烟模式使用**正常模式**的 stabilityMs（基准测的就是日用启动）。落地后重建制品并复测，作为本优化的 **before 基线**（按 M6 Task 5 Step 1 以摘要保全）。
2. **优化**：stability 窗口统一为 **100ms**（`HostSupervisor` 构造默认 `?? 1_000` → `?? 100`；`main.ts` 不再按模式区分）。100ms 已被全部 16 个打包冒烟场景（含 host-crash）长期验证。

行为测试（先失败）：`packages/host-supervisor/test/supervisor.test.ts` 断言缺省构造的 `stabilityMs` 为 100（现值 1000）。

## 4. 安全论证（对抗视角）

- 窗口唯一作用：ready 后短时内崩溃的 Host 归因为"启动失败"而非"运行中崩溃"。缩短后，ready 后 ~100ms–1s 的崩溃走 `hostCrashed`（M2 恢复链，relaunch-once）而非 start() 拒绝（boot 重试）——两条恢复路径均为 M2/M3 交付面且有打包冒烟覆盖（installed-host-crash、installed-controller-recovery）。
- 不变量不受影响：Host 仍为独立 utilityProcess、bootstrap 能力/lease/profile 仲裁/Safe Mode 不经此窗口；watchdog 健康监督独立于该窗口。
- lease/watchdog/崩溃恢复的既有测试全部保持为回归门。

## 5. 验收标准

- before/after 各一份 `release/startup-performance.json`（before 归档进 `release/evidence/` 并记录 SHA）。
- 选中阶段热 P95 改善 ≥15%（基线预期 ~2100ms → 目标 ≤1075ms 量级，实际以保真基线为准）；热端到端 P95 ≤ 2500ms；其他阶段回退 ≤10%（需解释）。
- 回归命令：`pnpm check`、`pnpm test:integration`、`pnpm test:shared-home`、`pnpm smoke:package`、`pnpm verify:release`、`pnpm smoke:startup-performance`（最终 DMG 上）。
