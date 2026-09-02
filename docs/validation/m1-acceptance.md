# M1 验收记录：共享 home 与单 Host

- 日期：2026-09-02
- 基线：`main` @ `2f84e04`（M0 验收）
- 结果提交：`codex/m1-shared-home` 初版 @ `2d3f0c6`；审查修复轮见 §7（表内门禁数字为修复后复跑结果）
- 执行计划：[M1 Implementation Plan](../superpowers/plans/2026-09-02-m1-shared-home-single-host.md)
- 决策记录：[ADR-0005](../adr/0005-home-lease-process-identity.md)、[home-lease 协议](../protocols/home-lease.md)

## 1. 执行环境

- macOS 26 (darwin 25.6.0, arm64)，Apple clang 21.0.0（Xcode Command Line Tools）
- Node.js 24.11.1，pnpm 11.7.0（corepack）
- DSH 固定版 `@deepseek-ai/*@0.1.2-alpha.3`（lockfile），Electron 44.1.0
- 真实 `~/.dsh` 未被读取或写入；全部测试使用临时 home（见 §4）

## 2. 提交清单

| 提交      | 内容                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fce2d4e` | docs: M1–M4 计划文档入库（codex 编写，zcode 执行前基线化）                                                                                                                      |
| `75b06f9` | Task 1：`product-config`、`resolveDesktopHome`（与固定版上游隔离进程对照）、隔离 home fixture、边界规则                                                                         |
| `9a46c94` | Task 2：`home-lease` 协议（owner schema、guard 短临界区、原生 `lease-helper.c`、fsync 补强）、ADR-0005 与协议文档                                                               |
| `c67a6bf` | Task 3：launcher/CLI 启动链改为 `lease → reconcile → beforeSpawn → spawn(waiting) → attachHost → bootstrap → ready`，退出链 stop→confirm→release；Host cwd 迁入中性 launch root |
| `ccc5da9` | Task 4：`dsh-native` 包装进程（argv 原样转发 + 授权式子进程）、`doctor --unlock`、退出码与协议更新                                                                              |
| `2d3f0c6` | Task 5：mock LLM + 共享 home driver，双向真实会话接续、互斥负例、CI macOS job                                                                                                   |

## 3. 门禁结果（全部通过）

| 命令                                     | 退出码 | 结果摘要                                                                                          | 耗时 |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- | ---- |
| `corepack pnpm@11.7.0 check`             | 0      | 15 个测试文件 / 115 个单测通过；prettier/eslint/边界/文档检查通过                                 | 11s  |
| `corepack pnpm@11.7.0 build:native`      | 0      | `lease-helper` 编译成功                                                                           | 1s   |
| `corepack pnpm@11.7.0 test:integration`  | 0      | 5 个文件 / 22 个集成测试通过（真实 DSH Host boot、双进程抢锁、doctor 竞态、会话图、restart 间隙） | 28s  |
| `corepack pnpm@11.7.0 test:shared-home`  | 0      | 双向场景各持久化 2 轮；跨 profile 互斥与 restart 间隙负例                                         | 26s  |
| `corepack pnpm@11.7.0 smoke:dsh-ui`      | 0      | ui-ready，launcher/Host 进程分离                                                                  | 8s   |
| `corepack pnpm@11.7.0 smoke:host-crash`  | 0      | ui-ready + host-crash-recovery                                                                    | 3s   |
| `corepack pnpm@11.7.0 smoke:shared-home` | 0      | 双向接续 + 双向拒绝 + settings/凭据 sentinel + 退出后无残留锁                                     | 34s  |
| `git diff --check`                       | 0      | 无空白错误                                                                                        | —    |

注：`check` 不含真实 Host 集成与 Electron 冒烟；上述集成/冒烟均在本机 macOS 实际执行。CI 已增加 `macos-15` job 运行 native helper 构建、集成、共享 home 与三条 smoke；Linux job 保持纯 `check`（未在 CI 环境实际运行过，标记为未验证）。

## 4. 测试数据边界证明

- 所有 home 测试通过 `createIsolatedHomeFixture()`（或 shared-home driver 的 `dsh-desktop-m0-smoke-*` 临时 userData）创建：创建时拒绝环境 `DSH_HOME` 已设置、仓库目录、filesystem root 与真实 `~/.dsh`；清理前复核 realpath 与 dev/ino。
- 共享 home 场景写入合成 `.credentials.yaml`（0600，含 sentinel ref）、`settings.yaml`（mock LLM baseURL）与 home 级 `cordis.patch.yml`（会话明文 JSONL，便于断言）；LLM 为本地 loopback mock，未访问任何付费模型。
- 冒烟后断言：凭据 sentinel 未丢失、userData 下凭据文件仅 1 份（未被复制）、settings 未被重写、`run/host.lock` 全部清空、全部子进程退出（waitUntilDead）。
- 真实 `~/.dsh` 的“不变证明”来自路径边界（resolveDesktopHome 只在非 smoke 真实启动时解析默认 home；所有自动化入口均显式指向临时 home）+ fixture 的写入前拒绝规则。

## 5. 故障注入结果

| 场景                                                                | 结果                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 同 home 不同 profile 并发 acquire                                   | 恰一个 winner，其余 `HOME_BUSY`（单测 + 8 并发真实争抢集成）                                                 |
| owner 进程被 SIGKILL（未 release）                                  | 后续 acquire 得 `HOME_STALE`，不自动回收；doctor 确认无活跃 owner 后 `unlocked`，重复执行 `already-unlocked` |
| owner 身份不可判定（unknown probe / 坏 owner 文件 / 缺 owner 文件） | `LEASE_UNKNOWN` 拒绝；坏 owner + 扫描到受支持入口运行 → `ACTIVE_OWNER` 拒绝                                  |
| 换 generation 后旧 handle release                                   | `LEASE_CHANGED` 拒绝，不动新锁                                                                               |
| Host 记录仍存活时 release                                           | `HOST_ACTIVE` 拒绝；identity unknown 时 `LEASE_UNKNOWN` 拒绝                                                 |
| `pendingSpawn` 未确认时 release / doctor                            | `PENDING_SPAWN` / `IDENTITY_UNKNOWN` 拒绝（保守）                                                            |
| attachHost 失败（未授权子进程）                                     | 子进程被 terminate+kill 回收，`confirmHostExited` 清登记，`BOOT_FAILED` 上报；子进程从未收到 boot 授权       |
| stop 与 spawn 并发（late spawn）                                    | stop 等待 in-flight spawn 完成后回收子进程，start promise 以 `BOOT_FAILED` 收尾，无泄漏                      |
| lock 目录被塞入未知文件                                             | `ENOTEMPTY` → `LEASE_UNKNOWN`，保留目录                                                                      |
| Desktop 活跃时 CLI boot / plugin 变更                               | 退出码 3 `HOME_BUSY`（smoke 实测）                                                                           |
| CLI 活跃时 Desktop 启动                                             | 在 reconcile 前被拒（`lease-refused` 报告，退出码 1；smoke 实测）                                            |

## 6. Standards / Spec / 安全结论

- **Standards**：依赖方向符合边界检查（`product-config` 无 Electron/DSH 依赖；`home-lease` 只允许 `@deepseek-ai/dsh-atomic-write`；launcher Main 无 DSH runtime import；新增规则均有负例 fixture）。owner 文件不含凭据、capability、authenticated URL 或命令行；日志与对话框只输出 owner 摘要，不打印完整 home 路径（自定义 home 以 “相同 DSH_HOME” 提示）。
- **Spec（主方案 M1 前四项共享 home 测试）**：① CLI 创建→Desktop 列出并继续 ✓；② Desktop 创建→CLI 继续续 ✓（均验证 `session/list` + `session/create` 采纳同一 sessionId + `session/prompt` 真实一轮，`turn/end` 计数 = 2）；③ 同 home 串行互斥（双方向 + 跨 profile）✓；④ 所有权诊断与安全退出（doctor 三态、退出链 stop→confirmHostExited→release，release 失败保留 lease 并报告）✓。
- **安全边界**：PID 重用由 boottime+启动时间身份区分（`kill(pid,0)` 不作为身份）；双 doctor 竞态由 guard `flock` 短临界区消除（并发新 acquisition 不会被旧 doctor 删除）；owner 写入为原子替换 + 文件/目录 fsync；guard `O_NOFOLLOW` + 父目录 dev/ino 校验拒绝置换。

## 7. 审查修复（2026-09-02 第二轮，codex review 后）

初版验收后 codex 审查指出租约故障路径缺口，以下修复均已落地并有测试：

| 审查项                                                    | 修复                                                                                                                                                                                                                                                   | 证据                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| P1 doctor 只扫描 Electron、漏扫活跃 dsh-native/Node child | 原生 helper 新增 `scanargv`（KERN_PROCARGS2 内存匹配 argv 针脚，绝不输出 argv）；doctor 扫描 = 可执行文件匹配 + argv 针脚匹配（dsh-native 脚本、CLI child 模块、Host 入口、官方 dsh bin，裸 `dsh` 也保守拒绝），任一扫描不可判定即 unknown fail-closed | `doctor-race.integration.test.ts` "refuses to unlock a corrupt owner while a supported CLI process is running" |
| P1 Desktop 取得 lease 后启动失败不 stop/确认              | `DesktopShellController.#start` 失败路径先 `attempt.stop('quit')`（含 confirmHostExited）再进恢复页；lease 由正常退出链释放                                                                                                                            | `lifecycle.test.ts` "stops the started Host and keeps the lease when surface loading fails"                    |
| P1 CLI child fork 后 identify/attachHost 失败不回收       | 未授权 child 先 SIGTERM→SIGKILL 回收并等待退出，再清登记、释放 lease                                                                                                                                                                                   | `cli.test.ts` "reaps the unauthorized child when host registration fails"                                      |
| P1（Spec）release 未复核 supervisor 身份                  | release 在 guard 内增加 supervisor 身份复核（≠same → LEASE_CHANGED）                                                                                                                                                                                   | `lease.test.ts` "refuses to release when the recorded supervisor identity is not this process"                 |
| P2 run/guard 权限未收紧                                   | `ensureHomeLayout` 将既有 `run/` chmod 0700、`host-lease.guard` chmod 0600                                                                                                                                                                             | `lease.test.ts` "tightens pre-existing run and guard permissions"                                              |
| P2 测试 fixture 不一致                                    | `reconcile.test.ts` 迁移到 `createIsolatedHomeFixture`                                                                                                                                                                                                 | 全部 home 测试统一走 fixture                                                                                   |
| P2 缺双 doctor 竞态与 restart 间隙测试                    | 新增 `doctor-race.integration.test.ts`（3 轮并发 doctor×2+acquirer，断言胜者锁不被误删）与 shared-home 的 host-restart-gap 场景（Host SIGKILL 后 Desktop 恢复页期间第三入口仍 exit 3）                                                                 | 两文件                                                                                                         |
| P3 M1 分支包含 M1–M4 计划文档                             | 保留：这是与用户确认过的基线化默认（计划文档作为 M1 分支第一个提交），非运行时行为                                                                                                                                                                     | `fce2d4e`                                                                                                      |

### 自我审查两轮（2026-09-02，`fix: harden signal forwarding and conservative reaping`）

对最终代码做两轮独立自审（第一轮攻击者/协议视角，第二轮测试/规格视角），发现并修复：

| 发现                                                                                                                                                             | 修复                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 信号处理器累积且 `kill(-pgid)` 对已消亡组抛 ESRCH，可能在处理器内产生未捕获异常                                                                                  | 转发与 kill 全部 try/catch；child 退出后 `process.off` 移除全部处理器                                                      |
| launcher supervisor 对未授权 child 有限等待后**无条件** confirmHostExited，无法证明死亡也会清 pendingSpawn → release 成功；与 CLI 侧保守语义（保留 lease）不一致 | 仅在可证明退出时 confirm；否则保留 pendingSpawn，release 以 PENDING_SPAWN 拒绝、lease 保留上报（新增 unkillable 反例测试） |
| `defaultGroupAlive` 对 EPERM 等非 ESRCH 错误直接抛出                                                                                                             | 视为"存活"（保守）                                                                                                         |
| 无 profile 透传路径组不可证死时返回 4 但无任何输出                                                                                                               | 打印残留进程提示                                                                                                           |

第二轮（测试/规格）未发现新缺口；记录残余：guard 若被硬链接到用户自有的其他文件，fd-based fchmod 会同时收紧同一 inode——同 uid 攻击者本可直接 chmod，不在威胁模型内。

自审期间的深入调查还发现并修复一个并发正确性缺陷：**8 路并发 acquire 在系统负载下偶发把 `refused-openat`（ENOENT）当作 LEASE_UNKNOWN**。逐步定位（helper 带 errno/步骤标记 + 满负载复现）证明根因是 macOS 对 `openat(O_RDWR|O_CREAT|O_NOFOLLOW)` 打开**并发中刚被创建**的已存在文件会误报 ENOENT。修复：guard 打开改为两阶段——先纯 `O_NOFOLLOW` 打开已存在文件，ENOENT 才用 `O_CREAT|O_EXCL` 独占创建，EEXIST 回退重试。修复后 40 轮 × 8 路并发 + 整套集成套件满负载复现零异常；同时 acquire 阶段把 guard 争用（GUARD_BUSY）映射为 HOME_BUSY，使并发争抢的语义确定。

### 第二次自我审查两轮（2026-09-02，`fix: redact smoke surface tokens and defer empty profiles`）

按 codex 同款 Standards/Spec 视角再做两遍：

- **Standards**：共享 home driver 曾把 Electron 每行 stdout 原样回显，包括带一次性 `?token=` 的 ui-ready 报告（会进入 CI 日志）——现在该行不回显（smoke 日志 `token=` 出现次数为 0，已验证）；`--profile ''` 原先被包装层以退出码 3 拒绝，现视为未解析直通，由上游自己报错（遵循上游语义）；边界导入复查无违规（launcher 的 `@deepseek-ai/dsh-*` 字符串仅是 UI 标记比较，非 import；home-lease 仅 dsh-atomic-write）。
- **Spec**：逐条对照计划 Task 1–6 checkbox 与协议声明（退出码 0/透传/2/3/4 两处一致、`bin.dsh` 解析、唯一解析 home 传入 bootstrap、Linux 仅注入 probe、会话持久化重读验证、恢复页不持锁）——无新缺口。

### 第三轮审查修复（2026-09-02，`fix: wait for cli descendants and pin guard parent`）

| 审查项                                        | 修复                                                                                                                                                                                            | 证据                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| P1 授权 CLI 只等直接 child，不等写 home 后代  | CLI 子进程改为独立进程组（detached fork）；直接 child 退出后探测**整组**存活（`kill(-pgid,0)`），10s 宽限→组 TERM→组 KILL；仍无法证明组消亡则保留 lease、退出码 4（协议已更新）；信号转发至整组 | `cli.test.ts` 两个组测试（迟落后代收敛释放 / 组不可证死保留锁）；真实流程由 test:shared-home 与 smoke:shared-home 覆盖 |
| P1 guard chmod TOCTOU（lstat→chmod 路径窗口） | TS 侧收紧改为 fd-based：`open(O_RDONLY                                                                                                                                                          | O_NONBLOCK                                                                                                             | O_NOFOLLOW[ | O_DIRECTORY])`+`fchmod`，symlink→ELOOP 拒绝、FIFO/非常规 inode 拒绝；helper 侧改为 `openat(父目录fd, guard名, O_NOFOLLOW…)`，父目录以 fd+fstat 钉住（dev/ino 校验后不再按路径访问） | lease 单测 symlink/FIFO 反例；helper 手工验证 refused 路径；既有权限收紧测试 |
| P3 协议命令清单缺 scanargv                    | 协议 §3 补 `scanargv`、openat 语义、组等待语义                                                                                                                                                  | docs/protocols/home-lease.md                                                                                           |

### 第二轮审查修复（2026-09-02，`fix: enforce conservative lease release on failure paths`）

| 审查项                                | 修复                                                                                                                                      | 证据                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P1 CLI 回收超时后仍释放 lease         | `reapUnauthorizedChild` 返回是否可证明退出；无法证明时跳过 confirm/release，lease 保留给 doctor，退出码 4（写入协议）                     | `cli.test.ts` "keeps the lease when an unauthorized child cannot be proven dead"（exited 永不决议的 child，锁保留） |
| P1 启动失败路径保留 lease 与协议相悖  | `#start` 失败链改为 attempt.stop → lease.release（失败经 onLeaseReleaseError 报告后才保留）→ 恢复页；reconcile 失败（无 attempt）同样释放 | `lifecycle.test.ts` 两个失败测试改为断言 release；新增 reconcile 失败用例                                           |
| P1 chmod 跟随 guard symlink           | `ensureHomeLayout` 在 chmod 之前以 lstat 检查 guard，symlink 直接 LEASE_UNKNOWN 拒绝                                                      | `lease.test.ts` "rejects a symlinked guard before any chmod side effect"（目标文件权限保持 0644）                   |
| P2 shared-home fixture 清理无身份复核 | 创建时记录 userData realpath/dev/ino + tmpdir realpath，删除前全部复核，不匹配即拒绝                                                      | `shared-home-driver.mjs` recordDirectoryIdentity/removeVerifiedTree                                                 |

## 9. 未验证项与遗留风险

- CI 的 `macos-15` job 尚未在 GitHub Actions 实际运行（本地同等命令已全部通过）；Linux `check` job 依赖既有配置。
- `ParentPort` 的 `close` 事件依赖 Electron 运行时行为（类型未声明，已按 EventEmitter 订阅）；父进程死亡的兜底仍是子进程 10s bootstrap 超时。
- smoke 输出中的 surface URL 携带一次性 token（仅存在于临时 home 场景，场景结束即销毁）；正式运行的日志不输出该 URL。
- 写 home 后代通过进程组存活探测收敛：直接 child 退出后给整组 10s 宽限再 TERM→KILL 升级，组不可证死时保留 lease（退出码 4）。极端场景（后代脱离进程组 double-fork 进新会话）无法被组探测覆盖——当前固定版 CLI 无此行为，M2/M3 引入相关上游行为时复查。doctor 的 argv 针脚覆盖我们自己的入口脚本与官方 dsh bin，不覆盖后代派生的任意 pnpm 进程（其 argv 不含针脚）。
- argv 针脚按子串匹配：任何把针脚路径放进自身 argv 的无关进程（如 `sh -c '<完整路径> ...'`）都会让 doctor 保守拒绝——方向安全（拒绝解锁），只影响可用性。
- M2（修订恢复/Safe Mode）、M3（打包）、M4（兼容性）未交付；本记录只覆盖 M1 范围。
