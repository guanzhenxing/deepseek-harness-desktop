# DeepSeek Harness Desktop

DeepSeek Harness Desktop 是面向 macOS 个人本机使用的原生 DSH 桌面壳。它使用独立 DSH bundle 插件承载 Desktop 集成，并由薄 Electron launcher 负责启动、Host 监督、窗口以及 Host 无法启动时仍可用的最低恢复控制面。

## 当前状态

pre-M0 架构与仓库基线已经完成，M0 功能实现尚未开始。当前仓库包含设计、协议、数据、安全和开发流程文档，以及验证这些文档的 CI 骨架；还没有可运行的 Electron 应用。

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
  → home-lease
  → profile-manager
  → host-supervisor
      → isolated DSH Host
          → desktop-plugin
          → official DSH Web UI
```

正常 Desktop 产品逻辑属于 `desktop-plugin`；进程创建、boot 前 lease、Electron 资源和 boot-independent 恢复属于 launcher。第三方 DSH 插件与 Host 同权运行，独立 Host 进程是故障边界而不是权限 sandbox。

## 开发基线

- Node.js：24.11.1；
- pnpm：11.7.0；
- DSH：[`dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.3)，commit [`dd6322d604e00eec1ba5e0c8541159906a21094a`](https://github.com/deepseek-ai/deepseek-harness/commit/dd6322d604e00eec1ba5e0c8541159906a21094a)。

该 DSH tag 已在 2026-09-01 进入 pre-M0 前重新检查；当时没有更新的 `dsh-v*` tag。M0 正式引入依赖时仍以 lockfile 和 compatibility manifest 为版本权威。

安装并运行当前门禁：

```bash
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 check
```

## 文档

- [实施方案](docs/native-dsh-desktop-plan.md)：v1 范围、里程碑、测试和扩展路线；
- [架构](docs/architecture.md)：组件、进程、信任边界和依赖方向；
- [Host-control 1.0](docs/protocols/host-control.md)：launcher/Host normative 协议；
- [数据布局](docs/data-layout.md)：路径、所有权、恢复和迁移；
- [安全策略](SECURITY.md)：威胁模型与未来能力进入条件；
- [开发指南](docs/development.md)：分支、测试、审查和发布流程；
- [ADR 索引](docs/adr/README.md)：已接受的架构决策。

## 仓库结构

```text
.github/workflows/   # CI 门禁
docs/                # 方案、架构、协议、ADR 和开发文档
scripts/             # 仓库验证与后续构建脚本
apps/                # M0 开始后建立应用入口
packages/            # M0 开始后建立机制包和 DSH 插件
tests/               # M0 开始后建立隔离 fixture、集成和冒烟测试
```

## 许可证

当前仓库是个人使用、未公开发行的私有项目，根 package 标记为 `UNLICENSED`。公开发布或接受外部贡献前必须明确许可证，并记录任何直接移植代码的第三方版权与许可。

