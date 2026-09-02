# M2 验收记录：非破坏性恢复

- 日期：2026-09-02
- 基线：`main` @ `b8cf701`（M1 验收合并后）
- 结果提交：`codex/m2-recovery`（本记录随 `docs: record verified m2 recovery acceptance` 提交）
- 执行计划：[M2 Implementation Plan](../superpowers/plans/2026-09-02-m2-nondestructive-recovery.md)
- 决策记录：[ADR-0006](../adr/0006-profile-revision-recovery.md)、[ADR-0007](../adr/0007-launcher-recovery-ipc.md)、[startup-recovery 协议](../protocols/startup-recovery.md)

## 1. 执行环境

- 与 M1 相同的 macOS 26 / Apple clang 21 / Node 24.11.1 / pnpm 11.7.0 / DSH 0.1.2-alpha.3 / Electron 44.1.0
- 全部测试使用临时 home；真实 `~/.dsh` 未被触碰

## 2. 提交清单

| 提交      | 内容                                                                                                                                                                                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `d0685bb` | Task 1：`failure-policy`（10 类失败分类、脱敏摘要、shouldRollbackProfile）、host-runner 命名阶段（resolve-runtime/resolve-profile/load-home-patch/boot/publish-surface + 致命信息透传）、ADR-0006 与 startup-recovery 协议                                                                                                     |
| `5249c68` | 瞬态进程状态扫描噪声修复（pid 复用/exec 中间态：helper 复查存活 + 短重试；测试有界重试）                                                                                                                                                                                                                                       |
| `f0f61c5` | Task 2：`reconcile-plan`（纯计划）+ `revision-transaction`（journal、逐文件 apply/commit/rollback、retained、20 条保留）+ `revision-recovery`（prepared/applying 幂等恢复、applied 无归因 needs-review）；reconcile 的 lease 路径切换到事务化                                                                                  |
| `6d1d188` | Task 3：`RecoverySessionController`（外层 lease + 一次性 attempt、60 秒窗口 3 次重试、quit 竞态合并、hostCrashed 保 lease）、恢复窗口（独立 partition/sandbox、.cts preload、窄 IPC 逐消息校验、CSP 无网络/inline）、懒创建（隐藏未加载窗口会卡 Electron quit——实测发现并记录于 ADR-0007）、closed 后 webContents 销毁竞态修复 |
| `7c38ea4` | Task 4：`quarantineProjectionCache`（固定布局校验、同文件系统 rename、意图 journal、512 MiB 阈值、备份保留）                                                                                                                                                                                                                   |
| `8f361d2` | Task 5：`desktop-recovery-bridge`（官方 base+web+bridge 三 bundle、loopback surface、openBrowser/printUrl=false）、`safe-profile`（desktop-safe-mode 精确三 bundle、冲突不覆盖）、`boot-profile`（safe/normal 组合互斥）、host-runner `mode:'safe'` + surface purpose 'recovery'                                               |
| （本次）  | Task 6：`smoke:profile-recovery`、`smoke:safe-mode`、CI/脚本接入与本验收记录                                                                                                                                                                                                                                                   |

## 3. 门禁结果（全部通过）

| 命令                                | 退出码 | 摘要                                                                                                                                                    |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`                             | 0      | 15 文件 / 141 单测（含 failure-policy 18、recovery-controller 7、revision-transaction 8、safe-profile 3、bridge 4、projection-cache 5、recovery-ipc 5） |
| `build:native`                      | 0      | lease-helper 编译                                                                                                                                       |
| `test:integration`                  | 0      | 7 文件 / 30 集成（含 revision-recovery 6、safe-mode 2、projection-cache 1）                                                                             |
| `test:shared-home`                  | 0      | 4 场景（双向接续 + 互斥 + restart 间隙）                                                                                                                |
| `smoke:dsh-ui` / `smoke:host-crash` | 0      | M0/M1 冒烟不回归                                                                                                                                        |
| `smoke:shared-home`                 | 0      | 双向 + 双向拒绝 + sentinel                                                                                                                              |
| `smoke:profile-recovery`            | 0      | 不可回滚失败不覆盖用户字节；journal ≤20                                                                                                                 |
| `smoke:safe-mode`                   | 0      | Safe Mode 不加载正常 profile 第三方 bundle、不改写正常 profile                                                                                          |
| `git diff --check`                  | 0      | 无空白错误                                                                                                                                              |

## 4. 故障注入与不变量

| 场景                                | 结果                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| 候选被用户改写后 rollback           | `conflict`，用户字节原样保留（单测 + 集成）                                        |
| prepared/applying/rolling-back 中断 | 磁盘事实幂等恢复（断电点对照 SHA）；rollback 中断可重复完成                        |
| applied 无归因                      | `needs-review`，不猜测 profile 有错                                                |
| 明确不可回滚失败                    | `retained` 终态（含类别），下次启动不偷偷回滚                                      |
| 恢复窗口连续重试                    | 只产生一个 attempt；60 秒窗口 3 次预算；quit 竞态以 quit 为准且 lease 恰好释放一次 |
| 恢复窗口销毁竞态                    | `closed` 后不触碰已销毁 webContents（用户实测崩溃反馈后修复）                      |
| 超 512 MiB cache                    | 持 lease 同文件系统 rename 至 quarantine 备份；symlink/未知布局不动                |
| Safe Mode                           | 精确三 bundle；正常 profile 第三方 bundle 不执行；bad normal manifest 字节不变     |
| IPC sender                          | 非恢复窗口/子 frame/loopback 页/query/hash/未知 schema 全部拒绝                    |

## 5. Standards / Spec / 安全结论

- **Standards**：新包 `desktop-recovery-bridge` 不依赖 desktop-plugin（有 bundle 测试约束）；恢复摘要经 token 打码、home 路径替换、控制字符清洗、1024 上限；journal/快照 0600/0700 且可能含敏感内容不进日志。
- **Spec**：正常链 `lease → cache 检查 → 恢复未完成 journal → reconcile plan → journal → apply → ready → 稳定 → committed`；失败链 stop/确认 → 分类 → 仅 profile-write/profile-composition 且未 healthy 且确有修改才回滚 → 最多一次 relaunch（marker 机制已实现于 controller，launcher 接线随 M3 稳定化）；Safe Mode 独占 Host、不与正常 Host 并行。
- **安全**：恢复窗口 CSP 禁网禁 inline、逐消息 sender/frame/path/schema 校验、doctor 只显示命令；cache 隔离不动 sessions/storages 其他数据。

## 6. 未验证项与遗留

- CI 的 macOS job 未在 GitHub Actions 实际运行（本地全绿）；需在 macos-15 上补 `smoke:profile-recovery`/`smoke:safe-mode` 两个 step（本地脚本已接入 package.json）。
- 恢复窗口的“profile 自动恢复 relaunch 仅一次”的 marker 持久化（userData/recovery）在 controller 提供 API，launcher 尚未跨进程持久化 marker——M2 验收按“窗口内单 attempt + 手动重试预算”验证；跨 relaunch 预算接线随 M3 打包窗口生命周期一并落地。
- Safe Mode 当前以官方 `web` bundle 组合为基础（base+web+bridge）；desktop-safe-mode profile 在真实用户 home 中的 bridge 安装投影（profile-local node_modules）依赖 M3 打包后的资源布局，开发态由集成测试显式投影验证。
- smoke:profile-recovery 的“自动 relaunch ≤1”以 journal 终态 + 单进程语义验证；跨进程 relaunch 计数随上一条 marker 项一并补齐。
