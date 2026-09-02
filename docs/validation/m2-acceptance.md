# M2 验收记录：非破坏性恢复

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

| 提交      | 内容                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d0685bb` | Task 1：`failure-policy`（10 类失败分类、脱敏摘要、shouldRollbackProfile）、host-runner 命名阶段、ADR-0006 与 startup-recovery 协议                                                                          |
| `5249c68` | 瞬态进程状态扫描噪声修复（计划外，实测 pid 复用误报所需）                                                                                                                                                    |
| `f0f61c5` | Task 2：`reconcile-plan` + `revision-transaction`（journal、逐文件 apply/commit/rollback、retained、20 条保留）+ `revision-recovery`（幂等恢复、needs-review）                                                  |
| `6d1d188` | Task 3：`RecoverySessionController`、恢复窗口（独立 partition/sandbox、窄 IPC、懒创建）、closed 销毁竞态修复                                                                                                  |
| `7c38ea4` | Task 4：`quarantineProjectionCache`（固定布局校验、rename、意图 journal、512 MiB）                                                                                                                            |
| `8f361d2` | Task 5：`desktop-recovery-bridge`、`safe-profile`、`boot-profile` 互斥、host-runner `mode:'safe'`                                                                                                             |
| `71c68b9` | Task 6（初版）：smoke 接入与初版验收记录                                                                                                                                                                      |

**自查修复提交（6 个，本修订新增）**

| 提交      | 轮次                      | 内容                                                                                                                          |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `47561a9` | 初审（双轴）              | 恢复链接入 main.ts（commit/rollback/retain/relaunch-once/marker）、stage 名对齐（publish-surface/host-control/reconcile-profile）、Safe Mode 全链接线（含 Electron 侧解堵与 `lease.switchProfile`）、IPC 精确 URL+主 frame、journal 保留/再校验/原子写、smoke 重写为真实驱动 |
| `a49e347` | 第 1 轮（双轴）           | conflict 后 pending 泄漏、inFlight 泄漏、quit 竞态 lease 搁浅、adopted 碰撞、crash 窗口、marker fsync                                            |
| `1162c89` | 第 2 轮（正确性）         | 碰撞检测前移 plan 阶段、onHealthy 钩子、stopping 守卫、双 start 防护、merge 语义细化                                                          |
| `b685443` | 第 3 轮（安全）           | journal ref 越界校验、quarantine journal 白名单、symlink 父目录、脱敏补引号/Bearer/api-key 形态、CSP 收紧                                        |
| `5fc26ad` | 第 4 轮（验收清单）       | 补 bridge 失效→恢复窗口仍可诊断/退出的 smoke 场景                                                                                            |
| `8390bed` | 第 5 轮（新群体）         | retry 非 retryable 控制器侧拒绝、created-file 漂移 conflict、死代码移除（DesktopShellController/recovery.html）、retention smoke 真实化        |

第 6 轮终审（全量最后扫描）：CLEAN，无新发现。

## 3. 门禁结果（全部通过，修复后 HEAD）

| 命令                     | 退出码 | 摘要                                                                    |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `check`                  | 0      | 格式/lint/边界/类型/单测 183 通过（22 文件）/docs 校验                  |
| `build:native`           | 0      | lease-helper 编译                                                       |
| `test:integration`       | 0      | 31 集成（8 文件）                                                       |
| `test:shared-home`       | 0      | 4 场景（双向接续 + 互斥 + restart 间隙）                                |
| `smoke:dsh-ui`           | 0      | M0 冒烟不回归                                                           |
| `smoke:host-crash`       | 0      | M0 冒烟不回归                                                           |
| `smoke:shared-home`      | 0      | M1 双向 + sentinel                                                      |
| `smoke:profile-recovery` | 0      | 失败链（回滚+恰好一次 relaunch+sentinel 不变）、conflict 链（不覆盖+Safe Mode 不污染+禁 retry+doctor 提示）、健康链（committed）、24 轮保留 prune 到恰 20 |
| `smoke:safe-mode`        | 0      | host 级（hostile bundle 不加载、正常 profile 字节不变）+ 会话级（safe-mode 接线 healthy、三 bundle、quit 释放）+ bridge 失效→恢复窗口诊断/退出有效 |
| `git diff --check`       | 0      | 无空白错误                                                              |

## 4. 故障矩阵（spec Task 6 要求的十行记录）

判定函数 `shouldRollbackProfile`（`packages/shell-core/src/failure-policy.ts`）；生产 producer 见 [startup-recovery 协议](../protocols/startup-recovery.md) §1。"改 profile"列指该类别失败发生时会话是否存在未结算的 pending 事务。

| category           | 典型 stage/code                 | 改 profile | 准许 rollback | 生产 producer | 验证                                                                   |
| ------------------ | ------------------------------- | ---------- | ------------- | ------------- | ---------------------------------------------------------------------- |
| lease              | `lease`（M1 错误码）            | 否         | 否            | 入口生命周期  | 不进恢复窗口（对话框/退出码）；表驱动测试                              |
| profile-write      | `reconcile-profile`/`RECONCILE_FAILED` | 是  | **是**        | desktop-recovery apply 相位 | smoke 失败链：回滚→恰好一次 relaunch；单测 retain/rollback 分叉        |
| profile-composition | `resolve-profile`/`PROFILE_INVALID` | 是 | **是**        | host-runner + desktop-recovery plan 相位 | smoke 失败链；非 retryable 门控测试                                    |
| home-config        | `load-home-patch`/`HOME_PATCH_INVALID` | 是 | 否           | host-runner   | 表驱动测试；retained 保留用户字节                                      |
| credentials        | `boot`/`MISSING_CREDENTIAL`      | 是         | 否            | host-runner boot code | 表驱动测试；指引文案只引导官方设置                                     |
| network            | `boot`/`PORT_IN_USE`             | 是         | 否            | host-runner boot code | 表驱动测试                                                             |
| runtime            | `resolve-runtime`/`host-control` | 是         | 否            | host-runner   | smoke：runtime 失败→retained×24 轮、prune 到 20                        |
| renderer           | `publish-surface`/`SURFACE_MISSING` | 是       | 否            | host-runner publish 阶段 | bridge 失效 smoke（renderer 类失败→恢复窗口，不回滚）                  |
| native-ui          | —（无生产 producer，接口预留）  | —          | 否            | 无（M3+ 原生菜单/托盘接入后产生） | 表驱动测试（策略层）                                                   |
| unknown            | 未识别 stage/code               | 视情况    | 否            | fallback、`recover-transactions`（有意不映射） | needs-review/conflict smoke：禁 retry、doctor 指引、不猜测 profile 有错 |

实际前后 hash 与 Host PID/lease generation 的逐行记录：journal（`transaction.json` 的 before/candidate SHA）与 lease owner 文件（PID/generation）即权威载体，测试通过读取这些磁盘事实断言（见 smoke 的 journalStates/sentinel 断言），不在本文档重复粘贴会过期的值。

## 5. 不变量与安全结论

- **权属与修订条件**：白名单三文件（`reconcile-plan`）、journal ref 越界即 corrupt（`readJournal`）、所有恢复写要求 `lease.assertHeld()`、rollback 写回前逐文件复验 inode/SHA、事务 created 文件阶段间漂移 → conflict。
- **一次自动恢复最多 relaunch 一次**：会话内 `#autoRestartUsed` + 跨进程 marker（`<userData>/recovery/<home 摘要>.json`，fsync 原子写，健康后清除）。smoke 断言恰好 2 次 normal boot。
- **双失败仍可诊断退出**：普通 Host 与 Safe Mode 都失败（bridge 失效 smoke）→ 本地恢复窗口显示分类/摘要/doctor 指引，quit 释放 lease。
- **home 权威数据不覆盖**：sentinel（credentials/settings/home patch）在全部四条 smoke 链中字节不变；journal 只含白名单文件快照。
- **IPC**：exact webContents + exact loaded URL + 主 frame + 固定 schema + recovery 态，逐消息校验；window-open 拒绝；CSP `script-src recovery-view.js`。
- **脱敏**：token（含引号形态）/api-key/password/Bearer 打码、home 路径占位、控制字符清洗、1024 上限。

## 6. 未验证项与遗留

- CI 的 macOS job 未在 GitHub Actions 实际运行（本地全绿）；`smoke:profile-recovery`/`smoke:safe-mode` step 已接入 workflow。
- native-ui 类别在生产路径暂无 producer（策略与测试就绪，接入点在 M3+ 原生菜单/托盘）。
- Safe Mode 的 bridge 在真实用户 home 中的安装投影（profile-local node_modules）依赖 M3 打包资源布局；开发态由集成测试显式投影验证。
- 一次自动恢复的跨进程 relaunch 计数依赖 marker 持久化已实现；但"真实断电后 marker 残留 + 下次启动拒绝 relaunch"的端到端断电演练未执行（journal 断电点由集成测试的故障注入覆盖，marker 的同类注入未单列）。
- 仍为源码级验收：`.app`/DMG 属 M3，版本闭包与升级演练属 M4。
