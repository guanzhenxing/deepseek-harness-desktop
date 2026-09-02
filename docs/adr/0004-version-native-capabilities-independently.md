# ADR-0004：按原生能力独立定义和版本化跨进程契约

- 日期：2026-09-01
- 状态：已接受
- 决策人：Jesen（guanzhenxing）

## 1. 问题

v1 只有 `desktopSurface`，但后续市场、远程、更新、终端和多 profile 会增加 `desktopProfileManager`、`desktopUpdater`、`desktopSecureStore`、`desktopTerminal` 等能力。

如果所有能力共享一个通用 `desktopRuntime` 或一个全局协议版本，小能力升级会迫使整个 Host/launcher 契约一起变化，并可能向第三方插件暴露不需要的 Electron 权限。

Host 控制通道只能证明消息来自 launcher 启动的 Host 进程。第三方插件与第一方插件在同一 Host 进程运行，因此 capability、包依赖和服务名都不能证明具体调用插件的身份。

## 2. 决策

初期保留一个物理 `desktop-contracts` 包，但每项能力通过独立 subpath export 发布，例如：

```text
desktop-contracts/host-control
desktop-contracts/profile-manager
desktop-contracts/updater
desktop-contracts/secure-store
desktop-contracts/remote-bridge
```

每个 subpath 独立声明 `{ name, major, minor }`，维护 schema、类型、状态机和双向契约 fixture，不依赖 Electron 或 DSH 的具体 transport。

版本规则如下：

1. major 不一致时拒绝建立该能力；
2. minor 通过双方支持范围协商；
3. 同一 major 内只允许增加可选字段或协商后的新消息；
4. 发送方不得发送协商 minor 不支持的消息；
5. 未知消息、缺失必填字段、重复终态、错误 lease generation 或失效 capability 一律拒绝；
6. Desktop 发行版兼容性清单记录每项能力的支持范围。

Host-control 1.0 的 envelope、消息和状态机由 [`docs/protocols/host-control.md`](../protocols/host-control.md) 固定。

## 3. 敏感能力规则

Host-process capability 不作为插件身份。低风险的 surface publication 仍按 Host 身份、mode、profile、loopback URL 和 schema 验证。

以下操作还必须执行能力自身的策略，并通过 launcher-owned UI 取得本地用户确认：

- 安装、禁用、回退或导入 profile 插件；
- 下载后安装 Desktop 更新；
- 创建、导出或删除远程设备凭据；
- 以后可能开放的终端或系统级操作。

`desktopSecureStore` 不向 Host 返回原始私钥或可长期复用的主秘密，只提供用途受限的生成、签名、解密、封装和删除操作。远程 principal 默认不能调用 profile、updater 或凭据管理能力。

## 4. 结果与代价

正面结果：

- 新增能力不扩大既有 surface 契约；
- launcher 和插件可以按能力独立演进；
- 协议兼容性可以通过 fixtures 和发行清单验证；
- 文档不会把同进程插件依赖误写成安全隔离。

需要承担：

- 每项能力都要维护 schema、协商和错误模型；
- launcher 需要独立的能力注册和用户确认入口；
- 如果一个物理包变得难以独立发布或审计，再通过 ADR 拆成多个包。

## 5. 被否决的备选

| 备选                                    | 未选择原因                                   |
| --------------------------------------- | -------------------------------------------- |
| 通用 `desktopRuntime`                   | 权限面过大，并把所有能力绑定到一个版本周期   |
| 仅用 TypeScript 类型、不做运行时 schema | 跨进程输入不能依赖静态类型保证               |
| 把 Host capability 当作插件身份         | 同进程第三方插件可以取得相同 Host 运行时权限 |
| secure store 返回原始私钥               | 任何 Host 插件都可能读取并长期复制该秘密     |
