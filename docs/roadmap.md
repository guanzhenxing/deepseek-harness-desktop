# 路线图

以下能力都不在当前版本内。是否与何时实现由真实需求、上游能力和维护成本决定；各项进入实现前必须满足对应门槛并建立 ADR。它们不是永久排除项。

## 范围外能力清单

| 功能                     | 它解决什么问题                                                                                                           | 当前处理                                        | 何时重新评估                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Windows/Linux 支持       | 处理不同窗口、托盘、安装器、终端和系统安全模型                                                                           | 仅验证 macOS                                    | 出现明确的跨平台使用需求时                                                            |
| 插件市场                 | 浏览、安装、升级、禁用第三方 DSH 插件，并支持可替换的 catalog provider                                                   | 用户通过标准 `dsh plugin` 命令管理插件          | 完成插件元数据、兼容性、信任策略和事务式安装设计后                                    |
| Setup wizard             | 首次启动时集中选择呈现模式、窗口材质、market、通知、浏览器访问和 LAN 暴露等选项                                          | 只在缺少凭据时给出本地提示，其余使用官方设置页 | 设置项增长到需要引导时                                                                |
| 更新服务                 | 检查并安装 Desktop 发行版，同时管理内置 DSH、插件和数据格式的兼容关系                                                    | 手动执行版本升级和 DMG 替换                     | 完成签名、兼容性清单、迁移预检和安全降级规则后                                        |
| 远程访问与控制           | 让已配对设备通过独立身份查看会话、提交任务或执行授权范围内的控制                                                         | 固定 `127.0.0.1`，仅本机访问                    | 完成 Host 端授权、配对撤销、TLS/可信中继和审计设计后                                  |
| 桌面终端集成             | 从托盘打开系统终端，并注入当前 profile 对应的私有 `dsh`/`pnpm`/`node` shim                                               | 使用普通终端和本项目配套 CLI                    | profile 环境切换造成明显使用摩擦时                                                    |
| 多 profile 桌面管理      | 在托盘中创建、选择和切换 profile，并通过 profile manager 向插件暴露当前选择                                              | 固定使用 `desktop` profile                      | 确实需要在一个桌面应用内切换多个 DSH 组合时                                           |
| launcher-owned home 管理 | 让桌面发行版选择或隔离自己的 DSH home，避免碰触默认 CLI 数据                                                             | 明确使用默认 `~/.dsh`                           | 需要多身份、测试隔离或公开发行时                                                      |
| 多 Host 并发             | 让多个 Host 同时安全写同一个 home                                                                                        | 使用 home lease 串行化                          | 只有上游提供完整跨进程 ownership/locking 时才重新评估；本项目优先走一个 Host 多客户端 |

## 演进方向

### 单 Host 多客户端

长期目标是“一个长期运行的 DSH Host、多个本地或远程客户端”：

```text
一个长期运行的 DSH Host
  ├── Electron 本地客户端
  ├── 配套 CLI 客户端
  └── 经授权的远程客户端
```

- 为长期 Host 定义本地 attach/discovery 协议和进程所有权；
- 让配套 CLI 作为客户端连接 Desktop Host，逐步替代整份 home 排他互斥；
- 保留 home lease 作为 Host 所有权锁，而不是每个客户端的使用锁；
- 优先复用上游 typed Remote、事件流、SDK 或 ACP 中适合的正式能力；
- 客户端具有不同 principal；“能连上 Host”不等于拥有相同权限。

### 更新基础设施

- Developer ID 签名、hardened runtime、notarization 和可信发布通道；
- 机器可读兼容性清单驱动的升级前备份、迁移预检和禁止不安全降级；
- launcher 提供 Host 无法启动时仍可用的最小更新状态机，`desktop-updater` 插件提供正常应用内 UI、兼容性解释与 channel 策略；
- launcher 持久化通过校验的 last-effective policy，并内置不可由 Host 替换的签名信任根与 emergency stable source；
- 先实现手动检查、下载确认和安装确认，再评估后台下载；更新请求默认不发送持久 installation id。

### 受信插件市场

- 先发布只读 catalog 和兼容性检查，再开放安装；
- `MarketProvider`、`PluginPackageManager` 与 `PluginTrustPolicy` 三个独立边界；
- 安装使用 staging、精确版本、校验和、发行者信息、不可变 generation、事务记录和失败回滚；
- 每个 `ProfileRef` 维护 `desired`、`active`、`lastKnownGood`；停止 Host 后才切换，至少保留上一组健康 generation；
- 受管 profile 的外部修改作为 drift 处理，只能显式导入为新 generation 或恢复 active 投影；
- 使用兼容性清单验证 Host singleton 和 peer resolution；
- 把可执行插件与 preset/配置包定义为不同制品类型，后者采用预览与原子导入，不继承代码安装授权。

### 配对式远程访问

- 先在固定 DSH 基线上验证 principal 传播、逐方法 scope 强制、审计和撤销扩展点；验证失败时不进入远程实现；
- 第一阶段只做显式启用的 LAN/可信网络访问，第二阶段才评估互联网 relay；
- Harness 始终只绑定 loopback；独立 bridge 暴露受限 surface，公网 tunnel/relay 只能指向 bridge；
- 每台设备单独配对、授权和撤销，Host 记录 principal、scope 与审计事件；
- 按能力区分只读、会话控制、任务提交和管理操作；默认拒绝远程安装、凭据写入和升级。

### 其他产品化能力

- 按需要加入 setup wizard、桌面终端和多 profile UI；
- 所有 profile 相关 API 继续接收 `ProfileRef`，`desktop` 只是默认选择；
- 向上游贡献可复用的 session ownership、storage revision、客户端 attach 和插件构建能力。

## 上游 DSH 基线升级

升级只由以下信号触发：上游发布新 tag、当前基线存在影响本项目的 bug/安全问题/格式变化、真实使用暴露需要新版本解决的问题。是否放行只取决于本项目的依赖闭包、补丁对账、测试和打包产物。

上游出现新 tag 时，真实升级在独立候选分支 `upgrade-dsh-<实际标签>` 上演练：更新 tag/commit/闭包 → 重跑全部门禁 → 升级演练（历史保留、第三方 bundle 不被触碰、降级/未知格式拒绝）。升级失败不阻塞其他交付，回退保留已验证基线。流程细节见[升级指南](upgrade-guide.md)与 [upstream-baseline](upstream-baseline.md)。

涉及不可逆数据迁移的上游版本（如 Session 持久化所有权变化）需要独立的迁移资格计划，不并入常规升级。
