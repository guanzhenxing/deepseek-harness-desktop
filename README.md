# DeepSeek Harness Desktop

DeepSeek Harness Desktop 是面向 macOS 个人本机使用的原生 DSH 桌面壳。它使用独立 DSH bundle 插件承载 Desktop 集成，并由薄 Electron launcher 负责启动、Host 监督、窗口以及 Host 无法启动时仍可用的最低恢复控制面。

## 当前状态

M1 共享 home 已完成源码级验收：Desktop 与配套 CLI `dsh-native` 顺序共享同一 DSH home，任何 Host boot、profile 写入前都必须先取得整 home lease（原子 `mkdir` 锁 + OS 进程启动身份 + guard 短临界区，见 [home-lease 协议](docs/protocols/home-lease.md)）。CLI 子进程在 lease 上登记 OS 身份并等待授权后才 import 官方 `@deepseek-ai/dsh` 入口；`dsh-native doctor --unlock` 在确认没有活跃 owner 后清理残留锁，不提供 force 绕过。双向会话接续（CLI 创建→Desktop 继续、Desktop 创建→CLI 继续）有真实官方 DSH 图 + mock LLM 的集成与冒烟证据。

Desktop 默认解析 `$DSH_HOME`/`~/.dsh`；开发冒烟仍走专用临时 home。M3 打包候选已完成制品级验收：托盘/菜单/窗口生命周期、受控外链、home 兼容性准入门（ADR-0009）、自含 Host/CLI 运行时候选 DMG（ad-hoc 签名、未公证）与 15 场景安装级冒烟（含安装应用上的真实恢复/Safe Mode 链）；M2 非破坏性恢复（10 类失败分类、修订事务、恢复窗口、Safe Mode）与 M1 共享 home/lease 见 [验收记录](docs/validation/)。验收详情：[M3 验收](docs/validation/m3-acceptance.md)。

v1 目标：

- macOS 本机安装的 DMG；
- 官方 DSH Web UI 的原生窗口、Dock、托盘和生命周期；
- DSH Host 在独立 Node-capable 子进程运行；
- 默认使用 `desktop` profile 和 `~/.dsh`；
- Desktop 与配套 CLI 顺序共享凭据、设置、会话和 storages；
- profile 修订恢复不覆盖 home 级用户数据。

插件市场、远程访问、自动更新、setup wizard、桌面终端和多 profile UI 不进入 v1，但架构已经为它们保留独立插件、原生 adapter 和版本化契约边界。

## 重要并发限制

“共享 `~/.dsh`”表示 Desktop 与 CLI 在不同时间读取同一份磁盘数据，不表示两个 DSH Host 可以同时写入该 home。

v1 的受支持入口遵循整份 home 单 Host 规则：

- Desktop 运行时，`dsh-native` 的 boot 与 `plugin` 变更会被 home lease 拒绝（退出码 3）；反之亦然；不同 profile 不构成例外；
- `dsh-native` 是唯一受本项目支持并遵守 lease 的 CLI；其他裸 `dsh` 不经过本项目拦截，使用前必须完全退出 Desktop 与 `dsh-native`；
- 残留锁用 `dsh-native doctor --unlock` 在确认无活跃 owner 后清理；
- 长期路线是一个 Host 被 Electron、本地 CLI 和授权远程客户端复用。

## 架构摘要

```text
Electron launcher / dsh-native wrapper
  → home-lease (whole-home writer lease)
  → profile-manager (desktop profile reconcile)
  → host-supervisor
      → independent DSH Host (waits for boot authorization)
          → desktop-plugin
          → official DSH Web UI
```

正常 Desktop 产品逻辑属于 `desktop-plugin`；进程创建、boot 前 lease、Electron 资源和 boot-independent 恢复属于 launcher。第三方 DSH 插件与 Host 同权运行，独立 Host 进程是故障边界而不是权限 sandbox。

## 开发基线

- Node.js：24.11.1；
- pnpm：11.7.0；
- DSH：[`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.3)，commit [`dd6322d604e00eec1ba5e0c8541159906a21094a`](https://github.com/deepseek-ai/deepseek-harness/commit/dd6322d604e00eec1ba5e0c8541159906a21094a)。

机器可读版本权威是 [`docs/compatibility.json`](docs/compatibility.json) 与 lockfile；Markdown 中的版本只用于说明，不独立决定兼容性。

安装并运行当前门禁：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check            # format/lint/typecheck/单测/文档检查
corepack pnpm@11.7.0 build:native     # 编译 lease helper（需要 Xcode CLT，macOS）
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home # 双向共享 home 会话接续
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
corepack pnpm@11.7.0 smoke:shared-home
corepack pnpm@11.7.0 smoke:profile-recovery   # M2：修订恢复不变量
corepack pnpm@11.7.0 smoke:safe-mode          # M2：Safe Mode 隔离
  corepack pnpm@11.7.0 package:dir              # M3：staging 校验 + 未打包 .app
  corepack pnpm@11.7.0 package:dmg              # M3：候选 DMG + 制品清单
  corepack pnpm@11.7.0 verify:artifacts         # M3：DMG SHA 与内嵌清单校验
  corepack pnpm@11.7.0 smoke:package            # M3：安装级 15 场景验收
corepack pnpm@11.7.0 dsh-native -- --profile headless "..."   # 开发入口（持 lease）
```

## 文档

- [M1–M4 执行路线与 zcode 交接](docs/superpowers/plans/2026-09-02-m1-m4-execution-roadmap.md)：各阶段目标、依赖、执行指令与验收记录要求；M1、M2 已合并 `main`；M3 已完成制品级验收（`codex/m3-packaged-desktop`，含 codex 复审修复，合并待定）；M4 待执行；
- [实施方案](docs/native-dsh-desktop-plan.md)：v1 范围、里程碑、测试和扩展路线；
- [架构](docs/architecture.md)：组件、进程、信任边界和依赖方向；
- [Host-control 1.0](docs/protocols/host-control.md)：launcher/Host normative 协议；
- [home-lease 协议](docs/protocols/home-lease.md)：整 home 写入互斥、owner 身份与 doctor 清锁（含 `dsh-native` 退出码）；
- [数据布局](docs/data-layout.md)：路径、所有权、恢复和迁移；
- [安全策略](SECURITY.md)：威胁模型与未来能力进入条件；
- [开发指南](docs/development.md)：分支、测试、审查和发布流程；
- [兼容性清单](docs/compatibility.json)：M0 的 Desktop、DSH、Electron、Node、pnpm 与协议版本事实；
- [ADR 索引](docs/adr/README.md)：已接受的架构决策。

## 仓库结构

```text
.github/workflows/   # CI 门禁
docs/                # 方案、架构、协议、ADR 和开发文档
scripts/             # 仓库验证与后续构建脚本
apps/                # Electron launcher、bundled CLI（dsh-native）与独立 Host 入口
packages/            # 契约、product-config、home-lease、profile、插件、监督器与 shell-core
tests/               # 隔离 home 的源码级桌面冒烟与共享 home driver
```

## 许可证

当前仓库是个人使用、未公开发行的私有项目，根 package 标记为 `UNLICENSED`。公开发布或接受外部贡献前必须明确许可证，并记录任何直接移植代码的第三方版权与许可。
