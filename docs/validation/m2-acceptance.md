# M2 验收记录：非破坏性恢复

- **状态：完成，源码级验收通过**（2026-09-03 定稿，`6eeeb83`）。核心恢复链、Safe Mode、profile 事务、冲突保护、relaunch-once、IPC 隔离全部接通；三轮外部审查的 P1 全部闭合，最后两个持久化边界（marker 删除 durability、journal 完整 schema 校验）已在 `b786b02` 关闭。**不宣称"完全 CLEAN"**——审查不可能完备，遗留项见 §6。
- 日期：2026-09-02（初版）／ 2026-09-02 深夜修订（自查修复后）
- 基线：`main` @ `b8cf701`（M1 验收合并后）
- 结果分支：`codex/m2-recovery`（本记录随最终 docs 提交）
- 执行计划：[M2 Implementation Plan](../superpowers/plans/2026-09-02-m2-nondestructive-recovery.md)
- 决策记录：[ADR-0006](../adr/0006-profile-revision-recovery.md)、[ADR-0007](../adr/0007-launcher-recovery-ipc.md)、[startup-recovery 协议](../protocols/startup-recovery.md)

## 0. 修订说明

初版验收（`71c68b9`）记录的"集成 28/28 全绿、五 smoke 通过"是真实的，但**门禁数字掩盖了链路断裂**：随后的六轮代码审查（3 轮双轴 + 2 轮专项 + 1 轮终审）发现核心恢复链未接入启动路径、Safe Mode 硬编码关闭、stage 名不匹配导致分类不可达等结构性问题。本记录描述的是**修复后**的验收状态；修复提交见 §2。初版声明中不实的部分（marker "已实现于 controller" 实为死 API、smoke "验证 relaunch ≤1" 实为空转断言）以本版为准。

## 1. 执行环境

- 与 M1 相同的 macOS 26 / Apple clang 21 / Node 24.11.1 / pnpm 11.7.0 / DSH 0.1.2-alpha.3 / Electron 44.1.0
- 全部测试使用临时 home（mkdtemp + dev/ino 身份复验清理）；真实 `~/.dsh` 未被触碰

## 2. 提交清单

**实现提交（7 个，初版）**

| 提交      | 内容                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d0685bb` | Task 1：`failure-policy`（10 类失败分类、脱敏摘要、shouldRollbackProfile）、host-runner 命名阶段、ADR-0006 与 startup-recovery 协议                            |
| `5249c68` | 瞬态进程状态扫描噪声修复（计划外，实测 pid 复用误报所需）                                                                                                      |
| `f0f61c5` | Task 2：`reconcile-plan` + `revision-transaction`（journal、逐文件 apply/commit/rollback、retained、20 条保留）+ `revision-recovery`（幂等恢复、needs-review） |
| `6d1d188` | Task 3：`RecoverySessionController`、恢复窗口（独立 partition/sandbox、窄 IPC、懒创建）、closed 销毁竞态修复                                                   |
| `7c38ea4` | Task 4：`quarantineProjectionCache`（固定布局校验、rename、意图 journal、512 MiB）                                                                             |
| `8f361d2` | Task 5：`desktop-recovery-bridge`、`safe-profile`、`boot-profile` 互斥、host-runner `mode:'safe'`                                                              |
| `71c68b9` | Task 6（初版）：smoke 接入与初版验收记录                                                                                                                       |

**自查修复提交（6 个，本修订新增）**

| 提交      | 轮次                | 内容                                                                                                                                                                                                                                                                         |
| --------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `47561a9` | 初审（双轴）        | 恢复链接入 main.ts（commit/rollback/retain/relaunch-once/marker）、stage 名对齐（publish-surface/host-control/reconcile-profile）、Safe Mode 全链接线（含 Electron 侧解堵与 `lease.switchProfile`）、IPC 精确 URL+主 frame、journal 保留/再校验/原子写、smoke 重写为真实驱动 |
| `a49e347` | 第 1 轮（双轴）     | conflict 后 pending 泄漏、inFlight 泄漏、quit 竞态 lease 搁浅、adopted 碰撞、crash 窗口、marker fsync                                                                                                                                                                        |
| `1162c89` | 第 2 轮（正确性）   | 碰撞检测前移 plan 阶段、onHealthy 钩子、stopping 守卫、双 start 防护、merge 语义细化                                                                                                                                                                                         |
| `b685443` | 第 3 轮（安全）     | journal ref 越界校验、quarantine journal 白名单、symlink 父目录、脱敏补引号/Bearer/api-key 形态、CSP 收紧                                                                                                                                                                    |
| `5fc26ad` | 第 4 轮（验收清单） | 补 bridge 失效→恢复窗口仍可诊断/退出的 smoke 场景                                                                                                                                                                                                                            |
| `8390bed` | 第 5 轮（新群体）   | retry 非 retryable 控制器侧拒绝、created-file 漂移 conflict、死代码移除（DesktopShellController/recovery.html）、retention smoke 真实化                                                                                                                                      |

第 6 轮终审（全量最后扫描）：CLEAN，无新发现。

**codex 外部审查修复（2026-09-03，第二个修订）**：codex 复审否定了"终审 CLEAN"结论，指出 3 个 P1 与若干缺口，全部修复——Safe Mode 注入面（safe profile 目录内容白名单 + host-runner safe 分支不加载 profile-local patch，两侧独立强制）、relaunch-once 预算改 home 级 marker（新事务 id 不再重置）、applyProfileTransaction 运行时白名单、marker `schemaVersion` 化与未知格式保护、`cache-quarantine` 分类映射补齐、unknown-layout 结构化诊断行、ADR 索引补 0006/0007 并新增 [ADR-0008](../adr/0008-projection-cache-quarantine.md)、projection-cache 测试改用共享 isolated-home fixture、architecture/data-layout 过时的"计划交付"措辞更正、故障矩阵补实际运行证据（§4 的 `M2-MATRIX` 行）。

**codex 二审修复（2026-09-03，第三个修订）**：marker 写入失败不再静默继续 relaunch（预算未落盘 = 不消耗 relaunch，直接进恢复页，故障注入单测覆盖）；损坏的 marker 文件（解析失败）与未知 schema 一视同仁——预算视为已消耗且永不覆写/删除（marker store 移入 shell-core 成为共享实现并单测）；`fallbackFailure` 统一走 `toStartupFailure` 脱敏（loadSurface/commit/port 的普通异常不再绕过 token/home 打码，测试覆盖）；恢复页文案区分"home 权威数据未改"与"profile 候选已保留于 journal"；矩阵 `hostPid` 更名 `sessionPid` 并说明其语义；profile-recovery smoke 新增 cross-process 链（文件版 marker 串两个会话验证跨进程预算不被重置、健康后清除恢复）；projection-cache 损坏 journal 返回 unknown-layout 且字节不变（"不触碰未知数据"闭合）；credentials 摘要把 guidance 计入 1024 上限。；**codex 三审（P1 清零，2 个 P2 残留修复）**：marker 清除改为 durable（rm 后目录 fsync，断电不能"复活"已清除的 marker），onHealthy 的 marker 清理与恢复窗口销毁解耦（清理失败不再连带吞掉窗口销毁，错误显式记日志）；projection-cache journal 的 v1 记录做字段级严格校验（id/bytes/createdAt/phase 类型与取值），可解析但结构损坏的 v1 journal 一律按未知数据处理（unknown-layout、字节不变）。

**自查攻击轮（2026-09-03，第四轮，双代理攻击轴+spec/standards 轴）**：P1×1 + P2×4 + P3×3，全部修复——`run/profile-transactions` 里的杂散文件（如 Finder 的 .DS_Store）曾让 journal 扫描抛 ENOTDIR：启动死循环、且健康启动后 prune 抛错会把已挂载的会话拆进恢复页（现非事务条目跳过、真实 I/O 错误保守判 corrupt）；journal `state` 白名单（位翻转的垃圾状态不再被当作"从未启动"而静默回滚）；reconcile 不再把 apply 阶段冲突的事务当正常 pending 返回（半应用 profile 不再被启动）；cache 隔离成功输出结构化日志（备份相对路径+字节），恢复页文案注明缓存例外；`doctorCommand` 在恢复窗口不再显示——会话持锁期间 doctor 必然拒绝解锁，摘要改为指向 journal 目录；rollback 的 before 快照缺失判 conflict 而非扫描失败；`prepareSafeProfile` 的 readdir 不再把 EACCES 吞成"空目录"；safe mode + 损坏 home patch 的行为（失败、不静默不重写）新增集成测试；credentials/network 两个 boot-code 映射如实标注为上游依赖（当前上游不产生结构化 code，分类落 unknown）；data-layout 补 shared-home 下 launch root 行。

**codex 五审修复（2026-09-03，第五轮，3 P1 + 5 P2）**：safe 分支 `loadProfile` 传 `userLayer: false`——safe profile 的本地 `cordis.patch.yml` 连解析都不发生（毒 patch 集成测试升级为不可解析 YAML，仍启动到 ready）；事务恢复扫描与 adopted-采纳按 `journal.ref.name === ref.name` 限定归属（其他 profile 的事务不被 Desktop 回滚/采纳，corrupt 仍保守 needs-review）；safe-profile 与事务根的父目录链拒绝用户植入 symlink（`profiles/`、`desktop-safe-mode/`、`run/`、`profile-transactions/`，`assertRealDirectory` 共享 helper + 逃逸测试）；cache 目录树不可枚举（如 EACCES）返回 unknown-layout 而非按 0 字节放行；故障矩阵补齐至十类真会话证据（每行 before/after SHA + sessionPid + leaseGeneration，合成注入的类别带 producerNote 标注）；README/roadmap/主方案三处"待执行/计划交付"措辞更正；doctor 口径全文与实现一致（恢复窗口持锁期间不显示 unlock，release 失败的 doctor 建议只出现在日志）；两个 M2 smoke 改用共享 `createIsolatedHomeFixture`（isolated-home 迁移为 .mjs + .d.mts 单一实现，14 个测试文件随迁）。

## 3. 门禁结果（全部通过，修复后 HEAD）

| 命令                     | 退出码 | 摘要                                                                                                                                                           |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                  | 0      | 格式/lint/边界/类型/单测 194 通过（23 文件）/docs 校验（29 文件）                                                                                              |
| `build:native`           | 0      | lease-helper 编译                                                                                                                                              |
| `test:integration`       | 0      | 32 集成（8 文件，含 safe 模式毒 patch 边界）                                                                                                                   |
| `test:shared-home`       | 0      | 4 场景（双向接续 + 互斥 + restart 间隙）                                                                                                                       |
| `smoke:dsh-ui`           | 0      | M0 冒烟不回归                                                                                                                                                  |
| `smoke:host-crash`       | 0      | M0 冒烟不回归                                                                                                                                                  |
| `smoke:shared-home`      | 0      | M1 双向 + sentinel                                                                                                                                             |
| `smoke:profile-recovery` | 0      | 失败链（回滚+恰好一次 relaunch+sentinel 不变）、conflict 链（不覆盖+Safe Mode 不污染+禁 retry+摘要指向 journal）、健康链（committed）、24 轮保留 prune 到恰 20 |
| `smoke:safe-mode`        | 0      | host 级（hostile bundle 不加载、正常 profile 字节不变）+ 会话级（safe-mode 接线 healthy、三 bundle、quit 释放）+ bridge 失效→恢复窗口诊断/退出有效             |
| `git diff --check`       | 0      | 无空白错误                                                                                                                                                     |

## 4. 故障矩阵（spec Task 6 要求的十行记录）

判定函数 `shouldRollbackProfile`（`packages/shell-core/src/failure-policy.ts`）；生产 producer 见 [startup-recovery 协议](../protocols/startup-recovery.md) §1。"改 profile"列指该类别失败发生时会话是否存在未结算的 pending 事务。

| category            | 典型 stage/code                        | 改 profile | 准许 rollback | 生产 producer                                  | 验证                                                                         |
| ------------------- | -------------------------------------- | ---------- | ------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| lease               | `lease`（M1 错误码）                   | 否         | 否            | 入口生命周期                                   | 不进恢复窗口（对话框/退出码）；表驱动测试                                    |
| profile-write       | `reconcile-profile`/`RECONCILE_FAILED` | 是         | **是**        | desktop-recovery apply 相位                    | smoke 失败链：回滚→恰好一次 relaunch；单测 retain/rollback 分叉              |
| profile-composition | `resolve-profile`/`PROFILE_INVALID`    | 是         | **是**        | host-runner + desktop-recovery plan 相位       | smoke 失败链；非 retryable 门控测试                                          |
| home-config         | `load-home-patch`/`HOME_PATCH_INVALID` | 是         | 否            | host-runner                                    | 表驱动测试；retained 保留用户字节                                            |
| credentials         | `boot`/`MISSING_CREDENTIAL`            | 是         | 否            | host-runner boot code                          | 表驱动测试；指引文案只引导官方设置                                           |
| network             | `boot`/`PORT_IN_USE`                   | 是         | 否            | host-runner boot code                          | 表驱动测试                                                                   |
| runtime             | `resolve-runtime`/`host-control`       | 是         | 否            | host-runner                                    | smoke：runtime 失败→retained×24 轮、prune 到 20                              |
| renderer            | `publish-surface`/`SURFACE_MISSING`    | 是         | 否            | host-runner publish 阶段                       | bridge 失效 smoke（renderer 类失败→恢复窗口，不回滚）                        |
| native-ui           | —（无生产 producer，接口预留）         | —          | 否            | 无（M3+ 原生菜单/托盘接入后产生）              | 表驱动测试（策略层）                                                         |
| unknown             | 未识别 stage/code                      | 视情况     | 否            | fallback、`recover-transactions`（有意不映射） | needs-review/conflict smoke：禁 retry、摘要指向 journal、不猜测 profile 有错 |

逐行**实际运行证据**（`smoke:profile-recovery` 输出的 `M2-MATRIX` 结构化行，2026-09-03 实跑，SHA 为 manifest 前 12 个 hex；空摘要 `e3b0c44298fc` 表示"文件不存在"，回滚后回到 before 即回到不存在）：

```text
M2-MATRIX {"scenario":"attributed-failure","category":"profile-composition","changed":true,"rollbackGranted":true,"beforeSha":"e3b0c44298fc","afterSha":"e3b0c44298fc","sessionPid":35699,"leaseGeneration":"b9e97613-59fa-4bd5-b7a6-74ac4b47f6da"}
M2-MATRIX {"scenario":"drifted-candidate","category":"profile-composition","changed":true,"rollbackGranted":false,"outcome":"conflict","beforeSha":"e3b0c44298fc","afterSha":"cfe7182082e4","sessionPid":35699,"leaseGeneration":"a1b8a6c2-bd55-4834-b8aa-53edf13bc0b1"}
M2-MATRIX {"scenario":"healthy-commit","category":"runtime","changed":true,"rollbackGranted":false,"committed":true,"beforeSha":"e3b0c44298fc","afterSha":"d193ec18a8a9","sessionPid":35699,"leaseGeneration":"4455e9f7-3fa5-4a17-8bba-747488a6f565"}
M2-MATRIX {"scenario":"retained-runtime","category":"runtime","changed":true,"rollbackGranted":false,"outcome":"retained","beforeSha":"e3b0c44298fc","afterSha":"321a3361d07c","journalCount":24,"sessionPid":35699,"leaseGeneration":"2749784a-015f-4c91-9afc-5399fb37959e"}
```

（完整输出共 11 行：上述 4 行 + healthy-commit 与 retained-runtime 的 beforeSha 补全 + `matrix-<category>` 系列覆盖 home-config/credentials/network/renderer/native-ui/unknown 各一行真会话 retained 证据 + `matrix-lease` 一行入口生命周期拒绝证据；每次运行 SHA 一致、PID/generation 随运行变化。）

`sessionPid` 是驱动会话的进程 PID——该 smoke 的 Host attempt 为会话内桩（矩阵证明的是会话/事务语义）；真实 Host 子进程的 PID 与 lease generation 记录见 `smoke:dsh-ui`/`smoke:host-crash`/`smoke:shared-home` 与 lease owner 文件。逐事务的完整 before/candidate SHA 权威记录在 `transaction.json`（journal 即证据载体，测试读取磁盘事实断言）；上表之外的非启动类（lease/credentials/network/native-ui 等）由表驱动单测覆盖判定函数，它们的 producer 语义见协议 §1。

## 5. 不变量与安全结论

- **权属与修订条件**：白名单三文件（`reconcile-plan`）、journal ref 越界即 corrupt（`readJournal`）、所有恢复写要求 `lease.assertHeld()`、rollback 写回前逐文件复验 inode/SHA、事务 created 文件阶段间漂移 → conflict。
- **一次自动恢复最多 relaunch 一次**：会话内 `#autoRestartUsed` + 跨进程 marker（`<userData>/recovery/<home 摘要>.json`，fsync 原子写，健康后清除）。smoke 断言恰好 2 次 normal boot。
- **双失败仍可诊断退出**：普通 Host 与 Safe Mode 都失败（bridge 失效 smoke）→ 本地恢复窗口显示分类与脱敏摘要（需人工介入的态指向 journal 目录），quit 释放 lease。
- **home 权威数据不覆盖**：sentinel（credentials/settings/home patch）在全部四条 smoke 链中字节不变；journal 只含白名单文件快照。
- **IPC**：exact webContents + exact loaded URL + 主 frame + 固定 schema + recovery 态，逐消息校验；window-open 拒绝；CSP `script-src recovery-view.js`。
- **脱敏**：token（含引号形态）/api-key/password/Bearer 打码、home 路径占位、控制字符清洗、1024 上限。

## 6. 未验证项与遗留

- CI 的 macOS job 未在 GitHub Actions 实际运行（本地全绿）；`smoke:profile-recovery`/`smoke:safe-mode` step 已接入 workflow。
- native-ui 类别在生产路径暂无 producer（策略与测试就绪，接入点在 M3+ 原生菜单/托盘）。
- Safe Mode 的 bridge 在真实用户 home 中的安装投影（profile-local node_modules）依赖 M3 打包资源布局；开发态由集成测试显式投影验证。
- "真实断电"的物理演练未执行；跨进程 relaunch 预算已由 profile-recovery smoke 的 cross-process 链覆盖（文件版 marker store 串两个会话模拟进程重启：预算不被重置、健康后清除恢复），marker 写失败阻断 relaunch 由单测故障注入覆盖。
- 仍为源码级验收：`.app`/DMG 属 M3，版本闭包与升级演练属 M4。
