# DeepSeek Harness Desktop

DeepSeek Harness Desktop 是面向 macOS 个人本机使用的原生 DSH 桌面壳。它使用独立 DSH bundle 插件承载 Desktop 集成，并由薄 Electron launcher 负责启动、Host 监督、窗口以及 Host 无法启动时仍可用的最低恢复控制面。

## 当前状态

M0 独立最小闭环已经实现：Electron launcher 在独立 `utilityProcess` 中启动 DSH Host，`desktop` bundle 插件通过 Host-control 1.0 发布 authenticated loopback surface，BrowserWindow 加载官方 DSH Web UI；Host 被终止后 launcher 保持存活并显示自有恢复页。

M0 仍是开发源码入口，只使用 Electron `userData/m0-dsh-home` 下的隔离 home，不读取或修改 `~/.dsh`。共享 home/配套 CLI 属于 M1，Safe Mode 与修订恢复属于 M2，`.app`/DMG 打包属于 M3；当前结果不应作为日用版安装。

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

- Desktop 运行时，不启动另一个会写该 home 的 DSH Host，也不执行修改该 home/profile 的 `dsh plugin`；
- 使用 CLI 管理或运行 DSH 前，先完全退出 Desktop；
- M1 将提供持有相同 home lease 的 `dsh-native` 配套 CLI；
- 长期路线是一个 Host 被 Electron、本地 CLI 和授权远程客户端复用。

## 架构摘要

```text
Electron launcher
  → profile-manager (M0 isolated home)
  → host-supervisor
      → independent DSH Host
          → desktop-plugin
          → official DSH Web UI

M1 adds: home-lease + shared ~/.dsh + supported CLI
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
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 smoke:dsh-ui
corepack pnpm@11.7.0 smoke:host-crash
```

## 文档

- [M1–M4 执行路线与 zcode 交接](docs/superpowers/plans/2026-09-02-m1-m4-execution-roadmap.md)：各阶段目标、依赖、执行指令与验收记录要求；四份分阶段计划已编写，尚未实施；
- [实施方案](docs/native-dsh-desktop-plan.md)：v1 范围、里程碑、测试和扩展路线；
- [架构](docs/architecture.md)：组件、进程、信任边界和依赖方向；
- [Host-control 1.0](docs/protocols/host-control.md)：launcher/Host normative 协议；
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
apps/                # Electron launcher 与独立 Host 入口
packages/            # 契约、profile、插件、监督器与 shell-core
tests/               # 隔离 home 的源码级桌面冒烟
```

## 许可证

当前仓库是个人使用、未公开发行的私有项目，根 package 标记为 `UNLICENSED`。公开发布或接受外部贡献前必须明确许可证，并记录任何直接移植代码的第三方版权与许可。
