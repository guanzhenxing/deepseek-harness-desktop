# 开发指南

- 状态：M0–M6 已验收合并（基线 DSH 0.1.2-rc.1）；v0.1.0 发布收口进行中
- 日期：2026-09-08

## 1. 当前阶段

仓库已完成 M0、M1（共享 home + lease + dsh-native）、M2（失败分类、修订事务恢复、恢复窗口、有界重试、cache 隔离、Safe Mode）、M3（托盘/菜单/窗口生命周期、外链策略、home 兼容性准入门、打包候选 DMG 与安装级冒烟）、M4（版本闭包与升级演练）、M5（确定性 SBOM、许可证清单、统一发行证据与合成插件引入）与 M6（安装制品启动性能测量与优化）验收。当前 DSH 基线为 0.1.2-rc.1；验收记录见 [validation](validation/)。

实施范围由[纯 DSH 桌面壳实施方案](native-dsh-desktop-plan.md)定义，稳定边界见[架构](architecture.md)，不可逆决策见 [ADR 索引](adr/README.md)。

M1–M4 的逐任务执行文档与 zcode 首轮交接指令见[执行路线](superpowers/plans/2026-09-02-m1-m4-execution-roadmap.md)；Post-M4 交付列车（rc.1 升级资格 → M5 → M6）的计划文档见 [superpowers/plans](superpowers/plans/)。`verify:release`、`verify:release-evidence`、`verify:plugin-intake`、`rehearse:upgrade` 等命令均已交付并在制品级验证。

## 2. 开发环境

要求：

- macOS；
- Node.js 24.11.1；
- pnpm 11.7.0；
- Git 2.47 或兼容版本；
- M0 打包阶段需要可运行对应架构 Electron 应用的本机环境。

Node engines 与上游 DSH 基线保持为 `^22.19.0 || >=24.0.0`，本仓库开发和 CI 选择固定的 24.11.1。pnpm 11.7.0 与当前 DSH 基线一致。

初始化：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

当前可用命令：

| 命令                       | 用途                                                    |
| -------------------------- | ------------------------------------------------------- |
| `pnpm build`               | 构建全部 TypeScript project references                  |
| `pnpm format:check`        | 检查格式但不修改文件                                    |
| `pnpm lint`                | 静态规则与依赖边界                                      |
| `pnpm typecheck`           | Host、client 与脚本 TypeScript 类型检查                 |
| `pnpm test:unit`           | 纯函数、schema、state machine 和组件单元测试            |
| `pnpm test:integration`    | 构建后用隔离 home 启动真实 DSH Host 和官方 Web surface  |
| `pnpm build:icons`         | 从原创 SVG 生成 ICNS 与托盘模板（macOS 自带工具）       |
| `pnpm stage:runtime`       | 物化自含 staging 闭包（Host/CLI/Node/pnpm/helper）      |
| `pnpm verify:runtime-tree` | 校验 staging 完整性、符号链接闭包、singleton 与原生 ABI |
| `pnpm package:dir`         | icons → staging → 校验 → 未打包 `.app`（ad-hoc 签名）   |
| `pnpm package:dmg`         | 在 staging 之上生成 DMG 候选                            |
| `pnpm smoke:dsh-ui`        | 独立 Electron/Host PID 的最小官方 DSH UI 闭环           |
| `pnpm smoke:host-crash`    | 只终止 Host，验证 launcher 恢复页与最终无残留进程       |
| `pnpm check:docs`          | 检查必需文档、兼容性事实、本地链接与文本格式            |
| `pnpm check`               | 合并当前阶段要求的全部快速阻塞门禁                      |

`pnpm smoke:package` 及后续交付的 `verify:release` / `verify:release-evidence` / `verify:plugin-intake` / `rehearse:upgrade` 都在安装制品（`.app`/DMG 副本）上执行，源码 smoke 不构成安装包验收。打包固定
electron-builder 26.15.3（配置 schema 以安装包内的 app-builder-lib 为准）；Host/CLI 运行时全部来自
`release/staging`（pnpm `--prod` deploy + 官方 Node/pnpm 制品校验），`.app` 内不依赖仓库
node_modules、pnpm store、系统 Node/pnpm 或 ASAR 虚拟路径。

命令名是仓库契约；package 内部脚本可以变化，但 CI 和开发文档不引用临时实现路径。

## 3. 工作项分类

每个变更先有一个可追踪的 issue 或本地 spec，至少写清：

- 用户或维护问题；
- 范围和明确不改的内容；
- 影响的进程、数据和信任边界；
- 可观察验收条件；
- 回滚或失败行为。

以下变化必须先建立 ADR：

- 新增或改变进程/信任边界；
- 改变状态唯一权威或持久化 schema；
- 新增 privileged native capability；
- 公共协议 major version 变化；
- 选择 market provider、remote relay、设备凭据格式或 updater channel；
- 数据不可逆迁移或公开发布策略。

局部实现、可逆重构和 bug 修复使用 issue/spec 与测试即可，不为每个提交创建 ADR。

## 4. 分支与提交

采用 trunk-based workflow：

- `main` 始终保持当前阶段可验证；
- 使用短生命周期 `feat/<name>`、`fix/<name>`、`docs/<name>` 或 `chore/<name>`；
- 一个分支只解决一个可独立审查的问题；
- 提交保持小而完整，使用 `feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:` 前缀；
- 不把 DSH baseline 升级与壳架构重构或产品功能放在同一分支；
- 不提交真实 DSH home、credentials、authenticated URL、签名私钥或脱敏前日志。

仓库首次 bootstrap 可以直接建立 `main`；此后的功能开发使用短分支或独立 worktree。

## 5. 实施循环

每个工作项遵循：

```text
issue/spec
→ boundary review
→ ADR when required
→ smallest vertical slice
→ contract/unit tests
→ implementation
→ integration and failure injection
→ packaged-artifact smoke when applicable
→ standards/spec/security review
→ merge
```

### 5.1 最小纵向切片

优先交付可观察的端到端路径，而不是先铺满所有抽象。例如 M0 第一条切片必须从 launcher 创建 Host runner，一直走到 `desktop-plugin` 发布 surface 并挂载官方 UI；不能只完成一组没有运行路径的 package skeleton。

### 5.2 Contract-first 与 TDD

以下部分先写失败测试，再实现最小行为：

- Host-control schema、版本协商和状态机；
- home lease acquisition/release/doctor；
- `ProfileRef` 与 reconcile；
- 修订校验恢复；
- Host supervisor 的启动、ready、crash 和 dispose；
- privileged Electron IPC 验证。

跨进程协议保留 launcher-new/Host-old 和 launcher-old/Host-new 双向 fixtures。测试不得仅断言 TypeScript 编译通过。

### 5.3 Fixture 与故障注入

profile、lease、会话和迁移测试只使用[数据布局](data-layout.md)规定的 `<testHome>`。

按变更范围主动注入：

- Host 在 hello、surface、ready、dispose 各阶段退出；
- launcher 在 profile transaction 各原子边界退出；
- stale、身份不明和 generation 不匹配 lease；
- profile SHA 被外部修改；
- renderer 导航、origin 和 IPC 参数非法；
- 打包环境缺少仓库 `node_modules`。

测试结束后先验证临时目录身份，再执行清理；不对环境变量展开后的宽路径做递归删除。

## 6. 审查门禁

| 变更范围                | 必须通过                                                        |
| ----------------------- | --------------------------------------------------------------- |
| 所有变更                | `pnpm check`、spec 验收、相关文档同步                           |
| schema/state machine    | unit tests、双向 contract fixtures、错误/重放用例               |
| profile/home/lease      | unit、隔离 home integration、crash recovery、真实 home 不变证明 |
| Host 进程               | lifecycle integration、残留进程检查、crash-loop 上限            |
| Electron/IPC/navigation | security review、错误 sender/origin/schema 测试                 |
| runtime/build/package   | `.app`/DMG 冒烟，不只运行开发入口                               |
| DSH baseline            | 兼容性清单、补丁对账、完整测试与独立升级分支                    |
| market/remote/updater   | 新 ADR、threat-model review、供应链/授权/迁移专项测试           |

审查沿两个轴分别给结论：

1. Standards：是否符合架构、ADR、安全和开发规范；
2. Spec：是否实现工作项要求，有无遗漏或范围漂移。

## 7. 文档规则

| 文档                              | 内容权威                       | 何时更新                         |
| --------------------------------- | ------------------------------ | -------------------------------- |
| `README.md`                       | 用户入口、当前状态和最小命令   | 用户可见范围或启动方式变化       |
| `docs/architecture.md`            | 当前组件、进程、信任和依赖边界 | 架构现状变化                     |
| `docs/native-dsh-desktop-plan.md` | v1 里程碑与未来路线            | 交付范围、顺序或估时变化         |
| `docs/adr/**`                     | 不可逆决策及依据               | 新决策、替代或废弃旧决策         |
| `docs/protocols/**`               | normative 跨边界协议           | schema、状态机或版本支持变化     |
| `docs/data-layout.md`             | 路径、所有权、备份和迁移       | 新持久化状态或迁移出现           |
| `SECURITY.md`                     | 威胁模型和安全进入条件         | 信任边界、公开发行或报告流程变化 |

版本事实只从依赖锁或 [`compatibility.json`](compatibility.json) 生成。不要在多个 Markdown 文件中手工维护不同的“当前版本”。

`pnpm check:docs` 必须随新增文档继续验证本地链接和格式。

## 8. 发布流程

v1 只发布本机候选 DMG：

1. 从短生命周期 release candidate 分支构建；
2. 生成 Desktop/DSH/plugin API/format compatibility manifest；
3. 运行 unit、integration 和全部桌面冒烟；
4. 对安装后的 `.app`/DMG 而不是源码入口执行测试；
5. 生成 SHA-256、补丁清单和测试摘要；
6. 使用复制的数据 fixture 做升级、重启和禁止不安全降级；
7. 人工使用一个观察周期；
8. 观察通过后才标记为当前版本，并保留上一健康 DMG。

公开分发前必须另立 ADR，完成 Developer ID、hardened runtime、notarization、正式许可证、隐私说明、安全联系和更新通道。

## 9. M0 完成证据

- `desktop-contracts`、`profile-manager`、`desktop-plugin`、`host-supervisor` 与 `shell-core` 均有自动测试；
- Electron Main 的监督器根入口不导出 Host runner，只有独立 `host-entry` 加载 DSH；
- `pnpm test:integration` 从独立 Node PID 验证 authenticated official boot graph；
- `pnpm smoke:dsh-ui` 验证官方 modules、侧栏、会话输入区域和设置入口；
- `pnpm smoke:host-crash` 验证 Host 崩溃不带走 launcher，并验证最终无残留 PID；
- 所有测试和开发启动使用显式隔离 home，不触碰默认 DSH home。

进入 M1 时必须先保持这些证据继续通过，再引入 home lease 和共享数据测试。
