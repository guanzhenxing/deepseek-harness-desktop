# M1–M4：zcode 执行路线与交接

- 日期：2026-09-02
- 状态：M1 已实施、审查与验收完成（2026-09-02 合并 `main` @ `6d7a19e`，验收记录见 [M1 验收](../../validation/m1-acceptance.md)）；M2–M4 未实施
- 代码基线：`main`，`2f84e04`（M0 验收记录）；本次只修改文档
- 需求权威：[实施方案](../../native-dsh-desktop-plan.md)、[架构](../../architecture.md)、[数据布局](../../data-layout.md)、[安全策略](../../../SECURITY.md)

## 每阶段交付什么

| 阶段 | 用户得到的能力                             | 主要工作                                                                     | 完成门槛                                                                   | 执行计划                                            |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| M1   | Desktop 与配套 CLI 能轮流使用同一份数据    | 共享 home、整 home lease、进程身份、`dsh-native`、doctor、双向会话测试       | 同 home 并发入口在 boot/写 profile 前被拒绝；两个入口能接续同一会话        | [M1 计划](2026-09-02-m1-shared-home-single-host.md) |
| M2   | 启动失败时有可操作恢复页，用户数据不被覆盖 | profile 修订事务、故障分类、有界重试、缓存隔离、Safe Mode 与 recovery bridge | 故障注入与事务中断后可恢复；SHA 冲突拒绝覆盖；正常与 Safe Mode Host 不重叠 | [M2 计划](2026-09-02-m2-nondestructive-recovery.md) |
| M3   | 可安装、可日常操作的本机候选 `.app`/DMG    | 托盘/菜单/窗口状态、外链与认证、完整运行时打包、安装后冒烟                   | 脱离源码和开发依赖仍能启动、对话、恢复与退出，CLI 也可运行                 | [M3 计划](2026-09-02-m3-packaged-desktop.md)        |
| M4   | 版本来源可核对，手动升级有兼容性保护       | 发行清单、依赖闭包、补丁账本、格式预检、升级/重启/拒绝降级演练               | 制品、基线与测试证据一致；不兼容版本在启动写入前拒绝打开 home              | [M4 计划](2026-09-02-m4-release-compatibility.md)   |

执行顺序固定为 `M0 → M1 → M2 → M3 → M4`。每阶段基于上一阶段通过验收的提交开始；跨阶段一起开发会使数据故障、恢复故障和打包故障难以区分。表中的能力是计划目标，不代表当前已经可用。

## 从当前代码得到的实施约束

1. 当前 launcher 使用 `userData/m0-dsh-home`，`ProfileWriteAuthority` 只有隔离模式。M1 必须先接入 lease，再改变默认 home；不能先删掉隔离检查。
2. 当前 `HostSupervisor` 每实例只能启动一次，`DesktopShellController.start()` 缓存首次 Promise。重试必须创建新的 Host attempt，保留外层 lease，不能重复调用旧 supervisor 的 `start()`。
3. 当前 Electron 的 `startIdentity` 是随机通道身份。它不能替代重启后 doctor 所需的操作系统进程启动身份；M1 分开存储这两种身份。
4. 当前 `recovery.html` 是静态“启动中”页面。M2 需要真正的阶段诊断和按钮；只保持窗口存活不算完成恢复。
5. 当前 Host runner、Electron bootstrap 限定 `mode: 'normal'`；Safe Mode 需要贯穿 bootstrap、profile 解析与 surface purpose。Host-control 已有 `normal/safe`，不需要为 bridge 新建一套 surface 协议。
6. 当前 profile reconcile 可能创建 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml` 三个文件，却只返回 manifest 摘要。M2 要覆盖三个文件的存在性及逐文件摘要。
7. 当前 launcher 关窗会退出，没有完整托盘/菜单/窗口状态行为。M3 把这些作为实现任务，不能只增加 smoke 名称。
8. 当前兼容性检查只对照少量 package 字段。M4 才实现完整闭包、持久化格式与制品校验。

## 本次明确的范围

- Safe Mode 基础能力安排在 M2。它也是 E3 插件市场的前置条件；M2 不实现 catalog、安装、定点禁用或 generation ledger。
- M2 实现的是 profile 文件修订事务，当前仓库没有“五件套 checkpoint”可供删除。
- M3 是 macOS 本机自用候选包，先验收本机架构。未实际构建和测试的架构不能列为支持；公众分发、Developer ID/notarization 和自动更新仍属于后续决策。
- M4 是手动升级验证与本地放行流程，不实现 updater 服务。无新上游 tag 时，用同基线候选重装和兼容性负例演练，不人为升级版本。
- 保留现有产品名 `DeepSeek Harness Desktop`，默认 profile 为 `desktop`，CLI 为 `dsh-native`，设置 namespace 为 `dsh-native-shell`。产品标识集中在 M1 配置包，避免再产生多套文案。
- 原方案的 1–2 天阶段估时不作为交付承诺。完成顺序以数据安全、真实进程测试、安装包测试门槛为准。

## zcode 的统一执行规则

1. 先读当前阶段计划及其 Spec 链接，再检查 `git status --short`、分支与上一阶段验收记录。保留现有未提交修改。
2. 建议每阶段使用一个 `codex/m1-shared-home`、`codex/m2-recovery`、`codex/m3-package`、`codex/m4-compatibility` 短分支。分支名不是运行时约束。
3. 文档中的新路径、新接口和新脚本都是该阶段的交付物。它们目前不存在，不应在创建前当成可用命令。
4. 新 package 同步 package manifest、精确依赖、`tsconfig.json` references、Vitest alias、导出和依赖边界检查；不要只创建源码文件。
5. 每项行为先写能观察失败的测试，再实现，再运行相关门禁。每个 Task 单独提交；格式/文档更新随对应行为提交。
6. 所有 home 测试都使用新建的临时目录，包含伪凭据和合成会话。真实 home 的“不变证明”通过测试路径拦截和读写审计完成，不遍历或散列用户真实数据。
7. 新增持久 schema、lease 原语或 privileged recovery IPC 时，在对应 Task 中补 ADR 和协议文档；这些常规实施决策按本计划推进，无需为每个函数向用户确认。
8. 阶段验收分别写 Standards、Spec、安全边界结论。环境无法运行的门禁标记“未验证”，不把 skip 算通过。
9. 不自动安装到用户正在使用的应用目录、不连接真实 home、不推送或发布制品。自动化 `.app` 安装测试使用临时安装目录。
10. 每阶段通过后更新 README 和主方案中的当前状态，写验收记录，再交接下一阶段。未通过项保持未勾选。

## 现有基线命令

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
```

先证明这些门禁在执行机上通过。当前 `check` 不包含真实 Host 集成或 Electron smoke，不能只跑 `check` 就声称阶段完成。新增阶段命令分别在四份计划里定义。

## 可直接交给 zcode 的首轮指令

```text
请在 deepseek-harness-desktop 仓库执行 M1。
先阅读 docs/superpowers/plans/2026-09-02-m1-m4-execution-roadmap.md，
再严格按 docs/superpowers/plans/2026-09-02-m1-shared-home-single-host.md 逐 Task 实施。
M0 基线为 main 上的 2f84e04；先检查当前仓库变化并复跑基线门禁。
使用临时 DSH home 做全部测试，先实现 home lease 再切换共享 home。
每项任务提交前检查对应验收条件；完成后给出命令结果、提交、遗留风险和验收记录路径。
本轮只完成 M1，不提前做 M2–M4，不推送、不发布、不操作我的真实 ~/.dsh。
```

后续轮次把阶段号和计划文件换成表中的对应项，并以上一阶段实际验收提交为起点。

## 阶段验收记录格式

记录保存为 `docs/validation/m1-acceptance.md` 至 `m4-acceptance.md`，至少包含：基线/结果 commit、执行环境、每个命令和退出码、故障注入结果、测试 fixture 清理证明、Standards/Spec/安全结论、未验证项。M3/M4 还需列出制品路径、SHA-256、实际安装架构和人工观察状态。
