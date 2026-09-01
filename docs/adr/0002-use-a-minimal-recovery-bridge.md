# ADR-0002：使用最小第一方 recovery bridge 发布 Safe Mode surface

- 日期：2026-09-01
- 状态：已接受
- 决策人：Jesen（guanzhenxing）

## 1. 问题

正常启动由 `desktop-plugin` 等待 DSH `connection` 服务并通过 `desktopSurface` 发布 authenticated loopback URL。

插件市场要求 Safe Mode 不加载正常 profile、第三方 bundle 或正常 `desktop-plugin`。如果 Safe Mode 只加载 `dsh-base` 与 `dsh-web-app`，Host 虽然可能启动成功，却没有组件把 authenticated URL 交给 launcher；恢复窗口因此无法展示官方 DSH Web UI。

把 connection 获取逻辑复制进 Electron Main 会让 launcher 依赖 DSH 运行时细节，也会破坏“Electron Main 不加载 Host 代码”的边界。

## 2. 决策

Safe Mode profile 固定加载：

1. `@deepseek-ai/dsh-base`；
2. `@deepseek-ai/dsh-web-app`；
3. 本项目随应用发布的最小第一方 `desktop-recovery-bridge`。

`desktop-recovery-bridge` 只承担以下职责：

- 可选取得 Host runner 注入的 `desktopSurface`；
- 等待官方 `connection` 服务；
- 验证 surface URL 仍为 loopback；
- 通过 Host-control 契约发布 authenticated recovery surface；
- 在缺少 launcher 能力时可读降级。

它不注册产品 settings，不读取 market catalog，不执行 profile 修改、故障归因或更新策略，也不拥有 Electron 窗口和进程生命周期。

正常 `desktop-plugin` 与 recovery bridge 使用同一 Host-control 协议。启动时的 profile 与 mode 已由 launcher、lease generation 和 Host 身份绑定；launcher 不根据 publisher 包名建立信任。

Safe Mode profile 由 `profile-manager` 创建和校验，不读取正常 `desktop` profile 的依赖树、第三方 bundle 或 patch layer。用户选择禁用或回退插件时，由 profile-manager 的显式事务修改正常 profile。

如果 Safe Mode Host 或 recovery bridge 本身失败，launcher-owned 的启动日志摘要、lease 诊断、重试、更新入口和退出仍然可用。

## 3. 结果与代价

正面结果：

- Safe Mode 能使用官方 DSH Web UI，而不依赖正常 Desktop 插件成功加载；
- Electron Main 不需要理解 DSH `connection` 服务；
- 正常与恢复启动共用一套 surface 协议和契约测试；
- recovery bridge 足够小，可以作为第一方恢复信任基的一部分重点测试。

需要承担：

- 发行版多维护一个最小 DSH bundle；
- Safe Mode 验收必须覆盖 recovery bridge 缺失、加载失败和重复发布；
- recovery bridge 的依赖闭包必须固定在发行版兼容性清单中。

## 4. 被否决的备选

| 备选 | 未选择原因 |
| --- | --- |
| Safe Mode 只加载 `dsh-base + dsh-web-app` | 没有组件发布 authenticated surface，无法完成恢复 UI handoff |
| Safe Mode 继续加载正常 `desktop-plugin` | 正常插件及其 patch 正是恢复路径需要绕开的失败来源之一 |
| Electron Main 直接取得 DSH connection | 会把 Host 运行时 API 和认证逻辑复制进 boot-independent launcher |
| 解析 Host stdout 中的 URL | 文案不构成稳定协议，且容易泄露认证 URL |

