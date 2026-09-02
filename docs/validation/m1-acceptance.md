# M1 验收记录：共享 home 与单 Host

- 日期：2026-09-02
- 基线：`main` @ `2f84e04`（M0 验收）
- 结果提交：`codex/m1-shared-home` @ `2d3f0c6`（本记录随 `docs: record verified m1 shared home acceptance` 提交）
- 执行计划：[M1 Implementation Plan](../superpowers/plans/2026-09-02-m1-shared-home-single-host.md)
- 决策记录：[ADR-0005](../adr/0005-home-lease-process-identity.md)、[home-lease 协议](../protocols/home-lease.md)

## 1. 执行环境

- macOS 26 (darwin 25.6.0, arm64)，Apple clang 21.0.0（Xcode Command Line Tools）
- Node.js 24.11.1，pnpm 11.7.0（corepack）
- DSH 固定版 `@deepseek-ai/*@0.1.2-alpha.3`（lockfile），Electron 44.1.0
- 真实 `~/.dsh` 未被读取或写入；全部测试使用临时 home（见 §4）

## 2. 提交清单

| 提交 | 内容 |
| --- | --- |
| `fce2d4e` | docs: M1–M4 计划文档入库（codex 编写，zcode 执行前基线化） |
| `75b06f9` | Task 1：`product-config`、`resolveDesktopHome`（与固定版上游隔离进程对照）、隔离 home fixture、边界规则 |
| `9a46c94` | Task 2：`home-lease` 协议（owner schema、guard 短临界区、原生 `lease-helper.c`、fsync 补强）、ADR-0005 与协议文档 |
| `c67a6bf` | Task 3：launcher/CLI 启动链改为 `lease → reconcile → beforeSpawn → spawn(waiting) → attachHost → bootstrap → ready`，退出链 stop→confirm→release；Host cwd 迁入中性 launch root |
| `ccc5da9` | Task 4：`dsh-native` 包装进程（argv 原样转发 + 授权式子进程）、`doctor --unlock`、退出码与协议更新 |
| `2d3f0c6` | Task 5：mock LLM + 共享 home driver，双向真实会话接续、互斥负例、CI macOS job |

## 3. 门禁结果（全部通过）

| 命令 | 退出码 | 结果摘要 | 耗时 |
| --- | --- | --- | --- |
| `corepack pnpm@11.7.0 check` | 0 | 15 个测试文件 / 111 个单测通过；prettier/eslint/边界/文档检查通过 | 11s |
| `corepack pnpm@11.7.0 build:native` | 0 | `lease-helper` 编译成功 | 1s |
| `corepack pnpm@11.7.0 test:integration` | 0 | 4 个文件 / 19 个集成测试通过（真实 DSH Host boot、双进程抢锁、doctor、会话图） | 25s |
| `corepack pnpm@11.7.0 test:shared-home` | 0 | 双向场景各持久化 2 轮；跨 profile 互斥负例 | 25s |
| `corepack pnpm@11.7.0 smoke:dsh-ui` | 0 | ui-ready，launcher/Host 进程分离 | 8s |
| `corepack pnpm@11.7.0 smoke:host-crash` | 0 | ui-ready + host-crash-recovery | 3s |
| `corepack pnpm@11.7.0 smoke:shared-home` | 0 | 双向接续 + 双向拒绝 + settings/凭据 sentinel + 退出后无残留锁 | 34s |
| `git diff --check` | 0 | 无空白错误 | — |

注：`check` 不含真实 Host 集成与 Electron 冒烟；上述集成/冒烟均在本机 macOS 实际执行。CI 已增加 `macos-15` job 运行 native helper 构建、集成、共享 home 与三条 smoke；Linux job 保持纯 `check`（未在 CI 环境实际运行过，标记为未验证）。

## 4. 测试数据边界证明

- 所有 home 测试通过 `createIsolatedHomeFixture()`（或 shared-home driver 的 `dsh-desktop-m0-smoke-*` 临时 userData）创建：创建时拒绝环境 `DSH_HOME` 已设置、仓库目录、filesystem root 与真实 `~/.dsh`；清理前复核 realpath 与 dev/ino。
- 共享 home 场景写入合成 `.credentials.yaml`（0600，含 sentinel ref）、`settings.yaml`（mock LLM baseURL）与 home 级 `cordis.patch.yml`（会话明文 JSONL，便于断言）；LLM 为本地 loopback mock，未访问任何付费模型。
- 冒烟后断言：凭据 sentinel 未丢失、userData 下凭据文件仅 1 份（未被复制）、settings 未被重写、`run/host.lock` 全部清空、全部子进程退出（waitUntilDead）。
- 真实 `~/.dsh` 的“不变证明”来自路径边界（resolveDesktopHome 只在非 smoke 真实启动时解析默认 home；所有自动化入口均显式指向临时 home）+ fixture 的写入前拒绝规则。

## 5. 故障注入结果

| 场景 | 结果 |
| --- | --- |
| 同 home 不同 profile 并发 acquire | 恰一个 winner，其余 `HOME_BUSY`（单测 + 8 并发真实争抢集成） |
| owner 进程被 SIGKILL（未 release） | 后续 acquire 得 `HOME_STALE`，不自动回收；doctor 确认无活跃 owner 后 `unlocked`，重复执行 `already-unlocked` |
| owner 身份不可判定（unknown probe / 坏 owner 文件 / 缺 owner 文件） | `LEASE_UNKNOWN` 拒绝；坏 owner + 扫描到受支持入口运行 → `ACTIVE_OWNER` 拒绝 |
| 换 generation 后旧 handle release | `LEASE_CHANGED` 拒绝，不动新锁 |
| Host 记录仍存活时 release | `HOST_ACTIVE` 拒绝；identity unknown 时 `LEASE_UNKNOWN` 拒绝 |
| `pendingSpawn` 未确认时 release / doctor | `PENDING_SPAWN` / `IDENTITY_UNKNOWN` 拒绝（保守） |
| attachHost 失败（未授权子进程） | 子进程被 terminate+kill 回收，`confirmHostExited` 清登记，`BOOT_FAILED` 上报；子进程从未收到 boot 授权 |
| stop 与 spawn 并发（late spawn） | stop 等待 in-flight spawn 完成后回收子进程，start promise 以 `BOOT_FAILED` 收尾，无泄漏 |
| lock 目录被塞入未知文件 | `ENOTEMPTY` → `LEASE_UNKNOWN`，保留目录 |
| Desktop 活跃时 CLI boot / plugin 变更 | 退出码 3 `HOME_BUSY`（smoke 实测） |
| CLI 活跃时 Desktop 启动 | 在 reconcile 前被拒（`lease-refused` 报告，退出码 1；smoke 实测） |

## 6. Standards / Spec / 安全结论

- **Standards**：依赖方向符合边界检查（`product-config` 无 Electron/DSH 依赖；`home-lease` 只允许 `@deepseek-ai/dsh-atomic-write`；launcher Main 无 DSH runtime import；新增规则均有负例 fixture）。owner 文件不含凭据、capability、authenticated URL 或命令行；日志与对话框只输出 owner 摘要，不打印完整 home 路径（自定义 home 以 “相同 DSH_HOME” 提示）。
- **Spec（主方案 M1 前四项共享 home 测试）**：① CLI 创建→Desktop 列出并继续 ✓；② Desktop 创建→CLI 继续续 ✓（均验证 `session/list` + `session/create` 采纳同一 sessionId + `session/prompt` 真实一轮，`turn/end` 计数 = 2）；③ 同 home 串行互斥（双方向 + 跨 profile）✓；④ 所有权诊断与安全退出（doctor 三态、退出链 stop→confirmHostExited→release，release 失败保留 lease 并报告）✓。
- **安全边界**：PID 重用由 boottime+启动时间身份区分（`kill(pid,0)` 不作为身份）；双 doctor 竞态由 guard `flock` 短临界区消除（并发新 acquisition 不会被旧 doctor 删除）；owner 写入为原子替换 + 文件/目录 fsync；guard `O_NOFOLLOW` + 父目录 dev/ino 校验拒绝置换。

## 7. 未验证项与遗留风险

- CI 的 `macos-15` job 尚未在 GitHub Actions 实际运行（本地同等命令已全部通过）；Linux `check` job 依赖既有配置。
- `ParentPort` 的 `close` 事件依赖 Electron 运行时行为（类型未声明，已按 EventEmitter 订阅）；父进程死亡的兜底仍是子进程 10s bootstrap 超时。
- smoke 输出中的 surface URL 携带一次性 token（仅存在于临时 home 场景，场景结束即销毁）；正式运行的日志不输出该 URL。
- `dsh-native` 等待子进程退出即释放 lease；若官方 CLI 子进程自行 daemon 化留下写 home 的后代（当前固定版没有此行为），lease 会在后代仍存活时释放。M2/M3 如引入相关上游行为需复查。
- M2（修订恢复/Safe Mode）、M3（打包）、M4（兼容性）未交付；本记录只覆盖 M1 范围。
