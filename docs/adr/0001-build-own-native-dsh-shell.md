# ADR-0001：自建独立的 DSH Desktop 插件与 Electron launcher

- 日期：2026-08-31
- 修订：2026-09-01（独立 Host、恢复 surface 与扩展控制面）
- 状态：已接受

## 1. 问题

上游 DeepSeek Harness 提供 CLI、Web UI、插件系统、会话和工具能力，但没有官方桌面应用。

本项目需要面向个人本机使用的 macOS 桌面形态，并希望默认沿用 CLI 的 `~/.dsh` 数据，而不是采用一个功能和生命周期均由外部社区发行版决定的桌面产品。

需要决定的是：

1. 直接使用社区安装版；
2. fork 社区桌面项目后裁剪；
3. 独立实现一个最小 DSH Desktop 插件及其 Electron launcher。

## 2. 决策

选择第三种方案：本仓库独立实现 DSH Desktop，不依赖其他产品仓库。

产品由两个边界清楚的部分组成：

- `desktop-plugin`：声明 `dsh.bundle.patch` 的 DSH 插件，是 Desktop 的产品集成主体；
- `desktop-launcher`：很薄的 Electron 自举与监督入口，负责 boot 前的应用身份、进程锁、DSH home lease、Host 子进程、Electron 原生资源，以及 Host 不可用时仍必须工作的最小恢复/更新控制面。

launcher 在独立的 Node-capable 子进程中 boot DSH Host，DSH Loader 在该子进程加载插件。Electron Main 与 renderer 不加载 Host 或第三方插件代码。

插件通过 Host runner 注入的窄化 `desktopSurface` proxy 发布本地 surface。proxy 经可序列化的私有控制通道把结构化消息交给 launcher；插件再通过官方 `connection` 服务取得 authenticated URL，并通知 launcher 创建窗口。

Safe Mode 不加载正常 `desktop-plugin`，而是加载最小第一方 `desktop-recovery-bridge`。它只通过相同的 `desktopSurface` 契约发布 authenticated recovery URL；launcher-owned 的最低恢复面仍不依赖任何 Host 成功启动。具体决策见 [ADR-0002](0002-use-a-minimal-recovery-bridge.md)。

控制通道绑定一次性 capability、protocol version、lease generation 与 Host 身份，不接受任意 Electron 方法或 stdout 文案协议。

Host 与 launcher 之间不提供通用 `desktopRuntime`。后续原生能力各自拥有独立契约，例如 `desktopUpdater`、`desktopSecureStore` 或 `desktopProfileManager`。这些能力可以暂时位于同一个 `desktop-contracts` 包，但必须使用独立 subpath export 和协议版本；具体决策见 [ADR-0004](0004-version-native-capabilities-independently.md)。

第一方功能插件只声明自身实际使用的能力契约；这种依赖最小化用于缩小接口面，不构成插件身份或权限隔离。敏感操作仍按 ADR-0004 执行能力策略和 launcher-owned 用户确认。

profile 组装、修订恢复、Safe Mode 投影与未来 generation 事务由 Electron-independent `profile-manager` 统一拥有，`shell-core` 只负责编排；具体决策见 [ADR-0003](0003-separate-profile-manager.md)。

插件市场、远程访问和桌面升级不会继续堆入 `desktop-plugin`。它们分别作为独立 DSH bundle/plugin 组合，并由 launcher 提供不能在插件内完成的最小原生机制。更新和恢复中必须在 Host boot 失败时工作的最低控制面是 launcher 职责，正常产品策略与 UI 仍属于相应插件。

默认使用：

- profile：`desktop`；
- DSH home：`resolveDshHome()`，即 `$DSH_HOME` 覆盖，否则 `~/.dsh`；
- Web Server：只绑定 `127.0.0.1`；
- DSH 基线：项目初始化时最新的上游发布 tag。

v1 使用 loopback authenticated URL 作为本地 surface transport。这是可替换的实现选择，不是 Desktop 业务协议；以后可以在不合并本地与远程权限的前提下切换为 Electron IPC transport。

长期演进方向是一个长期运行的 DSH Host，由 Electron、本地 CLI 和经授权的远程客户端复用。v1 的 home lease 是过渡期 Host 写入保护，不是长期客户端模型。

本 ADR 只固定扩展边界，不选择具体的 market provider、远程 relay、设备凭据格式或 updater channel。每项能力进入实现前单独建立 ADR。

完整实施边界、并发策略、暂缓功能与测试见[路线图](../roadmap.md)、[架构](../architecture.md)与[开发指南](../development.md)。

## 3. 依据

### 3.1 独立实现符合目标

本项目追求的是官方 DSH Web UI 的最小原生承载，而不是通用桌面发行版。

独立实现可以直接控制 profile、home、窗口生命周期、升级节奏和数据恢复范围，不必继承市场、首次设置向导、多 profile 管理、跨平台安装器和更新服务等当前不需要的产品层。

这些功能只是 v1 暂缓，并非永久排除。以后出现真实需求时，可以在本项目边界内逐项设计。

### 3.2 Desktop 应当是插件，但不能只有插件

DSH 插件只有在 Host boot 并加载 profile 后才能运行，因此不能自行完成以下 boot 前工作：

- 创建 Electron 主进程；
- 获取应用单实例锁；
- 在访问 `~/.dsh` 前获取 home lease；
- 设置 Electron userData 与应用身份；
- 处理 DSH 尚未启动时的错误。

因此 Desktop 以插件承载 DSH 集成，以 launcher 承载自举、Host 监督和 Electron 资源所有权。launcher 不是第二套产品逻辑。

受支持的隔离冒烟入口使用 Electron 单实例私有的 `<userData>/m0-dsh-home`，以隔离 home authority 替代 durable lease；正式入口在默认 home `~/.dsh` 上使用本 ADR 的完整 home lease。

Host 与 Electron Main 采用独立进程，原因是第三方插件或 Host 的启动失败、未捕获错误和主动重启不应同时摧毁恢复窗口、更新控制面和应用生命周期监督。launcher 可以在不退出 Electron 的情况下停止正常 Host、启动候选 Host 或 Safe Mode，并在失败后给出诊断。

进程隔离是故障域和生命周期边界，不是第三方代码权限沙箱；Host 子进程仍按当前用户权限运行。

### 3.3 使用 `desktop` profile

`desktop` 不是上游官方模板名；官方模板仅有 `web`、`acp`、`headless`、`sdk`、`sdk-minimal`。它是 anywhere-labs 桌面版建立的命名惯例，本项目沿用该名称而不再另造产品别名。

直接启动不存在的 `desktop` profile 时，上游会报错。只有通过 `dsh plugin` 首次管理时，上游才使用仅含 `dsh-base` 的默认 bundle 做最小初始化。

profile 的组装与修复由本项目 `profile-manager` 中的 `reconcileDesktopProfile()` 完成。它修复 `dsh-base`、`dsh-web-app` 和本插件的前缀，保留第三方 bundle，且不能用固定清单覆盖整个 profile。

桌面端的自动恢复也只能在修订校验通过时修改 `~/.dsh/profiles/desktop` 下的白名单文件。

### 3.4 共享 home 是数据互通，不是多 Host 并发

`~/.dsh` 是磁盘目录，不是常驻协调服务。Desktop 与 CLI 各自启动时都会 boot 独立 Host。

共享 home 让它们在不同时间读取同一份凭据、设置、会话和 storage，但不同 profile 并不会隔离这些数据。

上游当前没有为所有 session/storage 写路径提供跨进程协调，因此 v1 对受支持入口采用同 home 单 Host 策略。

home lease 是覆盖整个受支持入口写入生命周期的进程所有权协议。Desktop 内部重启 Host 或切换 Safe Mode 时仍由 launcher 持有，不直接复用上游面向短时单文件写入的 `withFileLock`。实现复用原子元数据写入，并保持排他创建、不按年龄抢锁的相同原则。

该限制以后可以随着上游跨进程能力或“一个 Host、多个客户端”架构重新评估。

### 3.5 外部桌面项目只是固定版本的参考资料

初始化调研阅读了 anywhere-labs/dsh-desktop 与 dataelement/dsh-desktop 的特定提交。前者用于理解 Desktop 插件/launcher 边界、profile 修复、Electron 生命周期和打包方式；后者用于理解独立 Host 监督、Safe Mode、不可变插件 generation、配对 bridge 和更新状态机。

这些参考实现不是本项目依赖、升级信号、兼容性门或运行时基线。

参考 commit、release 和 vendored DSH 版本记录在 [upstream-baseline](../upstream-baseline.md)；只有以后实际采用了新的外部思路时才更新该记录。

### 3.6 后续能力仍保持插件化

“Desktop 是插件”不表示所有桌面功能都属于同一个插件。`desktop-plugin` 只承载本地桌面 surface 集成；市场、远程访问、更新和终端是不同生命周期、权限与失败域，应分别组合。

launcher 只提供操作系统机制和 boot-independent 控制面。市场 catalog、远程授权策略、升级 channel 与兼容性解释等产品逻辑仍属于 DSH 插件，不能转移到 Electron 主进程形成第二套业务系统。

更新是明确例外中的分层，而不是放弃插件化：launcher 必须在 Host 无法 boot 时仍能校验可信更新元数据、停止 Host、替换应用和 relaunch；`desktop-updater` 插件负责正常应用内提示、策略和兼容性解释。launcher 必须保存经过校验的 last-effective policy，并内置不可由 Host 替换的签名信任根和 emergency stable source。Safe Mode 与定点 profile 修复同理，由 launcher 提供可用控制面，由明确的 profile manager 事务执行修改。

### 3.7 远程连接需要独立身份与 Host 端授权

loopback browser session 适合 v1 本机访问，但不能直接扩展成远程设备身份。远程功能必须让 Harness 继续只绑定 loopback，由独立 bridge 暴露受限 surface，并提供配对、逐设备撤销、TLS 或可信中继、审计，以及按 Host 方法执行的 scope 检查。

客户端的 `isLoopback` 只用于呈现，不能决定某次写入是否获准。bridge allowlist 和远端 IP 也不能替代 Host 授权。远程 principal 默认无权安装插件、写凭据、切换 profile 或更新 Desktop。

进入远程实现前必须用当时固定的 DSH 基线完成 feasibility prototype，证明 principal 可以传播到 Host，并在每个目标方法执行前强制检查 scope、审计和撤销。若上游缺少相应扩展点，先补授权中间层或推动上游能力，不得以 bridge 检查代替 Host 授权。

### 3.8 升级由多条版本轴共同约束

Desktop 应用、内置 DSH runtime、profile 插件和持久化格式分别拥有版本。上一版 DMG 只能回退应用二进制，不能保证读取新版本已经写入的数据。

因此发行版必须携带兼容性清单。未来 updater 在替换应用前执行签名校验、迁移预检和降级检查；插件升级与 Desktop 升级保持为两个独立事务。

插件升级采用不可变 generation：在隔离 staging 中解析和校验，停止 Host 后才切换 `active`，失败只回退本次事务，并保留 `lastKnownGood`。profile-manager 使用持久化事务 journal 记录 `staging`、`verified`、`prepared`、`activating`、`health-checking`、`committed` 与 `rolled-back`，确保 launcher 在任一阶段崩溃后可以幂等继续或回退。开放市场安装前必须先具备不读取正常第三方组合的 Safe Mode 和定点禁用能力。

## 4. 被否决的备选

| 备选                                       | 未选择原因                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 直接使用社区安装版                         | 可以作为现成工具，但其产品功能、数据根、更新节奏和界面取舍不由本项目控制                                                           |
| fork 社区桌面项目后裁剪                    | 会继承与本项目目标无关的跨平台、安装、恢复和产品功能，同时长期承担上游合并与裁剪冲突                                               |
| launcher 在 Electron Main 进程内 boot Host | 实现较少一层进程通信，但 Host/第三方插件故障会同时破坏恢复与更新控制面，也难以在不退出 Electron 的情况下切换候选 Host 或 Safe Mode |
| Chrome app mode                            | 能承载 Web UI，但缺少所需的原生生命周期、托盘、进程所有权和可控的打包边界                                                          |

## 5. 结果与代价

正面结果：

- Desktop 的 DSH 集成保持插件化；
- Host 故障与 Electron 壳分离，恢复和更新控制面不依赖正常 profile 成功启动；
- 默认与 CLI 顺序共享 `~/.dsh`；
- 项目拥有自己的需求、代码、发布和升级判断；
- v1 可以保持小而清楚，暂缓功能以后通过独立插件加入；
- 单 Host 多客户端、远程授权和版本兼容具有明确演进方向。

需要承担：

- Electron 壳、打包和 macOS 生命周期由本项目维护；
- 需要维护跨进程控制契约、Host 监督、父子进程清理和故障恢复测试；
- 最新 DSH alpha 未发布 npm 时，需要建立可复现的制品链；
- 本项目必须自行验证每次 DSH 升级；
- 在上游缺少完整跨进程协调期间，需要 home lease 或等价的单 Host 机制；
- 公开市场、远程控制和自动更新都需要额外的供应链、安全与迁移基础设施。

## 6. 初始外部事实

- 上游仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 上游在决策时没有官方 Desktop app，`apps/` 以 CLI 和 Web 为主。
- 外部参考仓库：<https://github.com/anywhere-labs/dsh-desktop>
- 外部参考仓库：<https://github.com/dataelement/dsh-desktop>
- 任何带版本号、commit 或“最新”字样的事实都由 [upstream-baseline](../upstream-baseline.md) 的固定参考记录维护，不在本 ADR 中充当长期升级依据。
