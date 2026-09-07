# 纯 DSH 桌面壳实施方案

- 日期：2026-09-01
- 状态：拟实施
- 关联决策：[ADR-0001](adr/0001-build-own-native-dsh-shell.md)
- 目标平台：macOS，个人本机使用

## 1. 结论

本项目自建一个只承载官方 DSH Web UI 的 Desktop 插件，并用一个很薄的 Electron launcher 监督承载该插件的独立 DSH Host 进程。

Desktop 插件是本地桌面集成主体；launcher 只负责插件无法自举的原生启动边界、Host 进程监督，以及 Host 无法启动时仍必须可用的最小恢复/更新控制面。

桌面端与配套 CLI 是两个独立入口，各自拥有应用身份与启动时的 profile 选择，但默认绑定同一 `~/.dsh`，从而顺序共享凭据、设置、工作区和会话。

这里的“共享”指桌面端和 CLI 在不同时间启动时，读写同一份磁盘数据；它不是“CLI 自动连接到桌面端已经运行的 Host”。桌面端和 CLI 各自启动时都会创建独立的 DSH Host 进程。

上游目前只在单个进程内部协调 session 和 storage 写入，因此两个 Host 同时运行时可能竞争同一个 home。

v1 采用“一份 DSH home 同时只允许一个受支持 Host 写入”的保守策略；这不是永久产品限制。

v1 先完成最小桌面闭环，暂缓插件市场、远程访问、更新服务、首次设置向导、桌面终端和多 profile 管理等产品化功能。它们不是永久排除项，具体释义和进入条件见 §2.2 与 §12。

这些后续能力不会继续堆入 `desktop-plugin`。市场、远程访问和更新各自拥有独立 DSH 插件；launcher 只向它们提供窄化的原生能力。恢复与更新中必须在 Host boot 失败时仍可工作的最小机制属于 launcher 控制面，正常产品策略和 UI 仍由对应插件承载。

长期演进目标是“一个长期 Host、多个本地或远程客户端”。

anywhere-labs 与 dataelement 的桌面项目只作为固定 commit 的外部参考实现，既不是本项目依赖，也不参与版本放行。

## 2. 目标与非目标

### 2.1 v1 目标

1. 原生窗口、Dock、托盘、单实例、窗口状态恢复和 macOS 菜单行为完整。
2. Desktop 以独立 DSH bundle 插件存在；普通 DSH 启动缺少 Electron runtime 时，插件明确降级而不拖垮其余组合。
3. Electron launcher 在独立的 Node-capable 子进程中启动官方 DSH Host；Electron Main 与 renderer 都不加载 Host 或第三方插件代码，BrowserWindow 只加载 loopback 上的 authenticated URL。
4. 使用桌面专属 profile `desktop`（非上游官方模板名），默认 home 为 `~/.dsh`。
5. 桌面端退出后，配套 CLI 可以读取并继续同一批会话；CLI 退出后，桌面端也能读取其结果。
6. 阻止受支持入口同时写入同一 home，不以“不同 profile”冒充进程隔离。
7. 启动恢复只修改桌面壳拥有的 profile 文件，绝不自动回滚 home 级设置和用户数据。
8. 依赖版本精确固定，升级经过本项目自己的单元、集成、冒烟和打包验证。
9. 产出可在本机安装的 DMG；v1 不面向公众分发。
10. Host 启动失败或异常退出时 Electron 壳保持存活，显示可操作诊断，并允许有界重试或退出。

### 2.2 v1 暂缓项（不代表永久排除）

以下功能只是不进入 v1。后续是否实现由实际使用需求、上游能力和维护成本另行决定：

| 功能                     | 它解决什么问题                                                                                                           | v1 处理                                        | 何时重新评估                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Windows/Linux 支持       | 处理不同窗口、托盘、安装器、终端和系统安全模型                                                                           | 仅验证 macOS                                   | 出现明确的跨平台使用需求时                                                            |
| 插件市场                 | 浏览、安装、升级、禁用第三方 DSH 插件，并支持可替换的 catalog provider                                                   | 用户仍通过标准 `dsh plugin` 命令管理插件       | 完成插件元数据、兼容性、信任策略和事务式安装设计后                                    |
| Setup wizard             | 首次启动时集中选择呈现模式、窗口材质、market、通知、浏览器访问和 LAN 暴露等选项                                          | 只在缺少凭据时给出本地提示，其余使用官方设置页 | v1 设置项增长到需要引导时                                                             |
| 更新服务                 | 检查并安装 Desktop 发行版，同时管理内置 DSH、插件和数据格式的兼容关系                                                    | 手动执行版本升级和 DMG 替换                    | 完成签名、兼容性清单、迁移预检和安全降级规则后                                        |
| 远程访问与控制           | 让已配对设备通过独立身份查看会话、提交任务或执行授权范围内的控制                                                         | 固定 `127.0.0.1`，仅本机访问                   | 完成 Host 端授权、配对撤销、TLS/可信中继和审计设计后                                  |
| 更新请求身份             | anywhere-labs 的版本检查会发送当前桌面版本和持久化的随机 installation UUID；这是更新服务的请求标识，不等同于通用行为分析 | 不发版本检查请求，也不创建 installation id     | 设计更新服务时一并评估最小数据原则                                                    |
| 桌面终端集成             | 从托盘打开系统终端，并注入当前 profile 对应的私有 `dsh`/`pnpm`/`node` shim                                               | 使用普通终端和本项目配套 CLI                   | profile 环境切换造成明显使用摩擦时                                                    |
| 多 profile 桌面管理      | 在托盘中创建、选择和切换 profile，并通过 profile manager 向插件暴露当前选择                                              | v1 固定使用 `desktop` profile                  | 确实需要在一个桌面应用内切换多个 DSH 组合时                                           |
| launcher-owned home 管理 | 让桌面发行版选择或隔离自己的 DSH home，避免碰触默认 CLI 数据                                                             | v1 明确使用默认 `~/.dsh`                       | 需要多身份、测试隔离或公开发行时                                                      |
| 多 Host 并发             | 让多个 Host 同时安全写同一个 home                                                                                        | v1 使用 home lease 串行化                      | 只有上游提供完整跨进程 ownership/locking 时才重新评估；本项目优先走一个 Host 多客户端 |

## 3. 核心原则

### 3.1 共享 home，隔离应用身份与 profile

共享数据根默认由 `resolveDshHome()` 解析，因此遵循 `$DSH_HOME` 覆盖，否则使用 `~/.dsh`。桌面端不再把 `DSH_HOME` 强制改成产品私有目录。

隔离项如下：

| 对象                              | 位置/名称                              | 所有者                           | 桌面端是否可自动回滚                   |
| --------------------------------- | -------------------------------------- | -------------------------------- | -------------------------------------- |
| DSH 凭据                          | `~/.dsh/.credentials.yaml`             | 用户/DSH                         | 否                                     |
| DSH 设置                          | `~/.dsh/settings.yaml`                 | 用户/所有 profile                | 否                                     |
| home patch                        | `~/.dsh/cordis.patch.yml`              | 用户                             | 否                                     |
| 会话日志                          | `~/.dsh/sessions/**`                   | DSH                              | 否                                     |
| domain storage                    | `~/.dsh/storages`                      | DSH/用户                         | 否                                     |
| 桌面 profile                      | `~/.dsh/profiles/desktop`              | `profile-manager` 与用户共同使用 | 仅满足修订校验时                       |
| Safe Mode profile（市场前置能力） | `~/.dsh/profiles/desktop-safe-mode`    | launcher/`profile-manager`       | 只管理自身文件，不自动修改正常 profile |
| Electron userData                 | macOS Application Support 下的专属目录 | 桌面壳                           | 是                                     |
| 渲染会话                          | `persist:dsh-desktop-renderer`         | 桌面壳                           | 是                                     |

profile 名采用 `desktop`。它不是上游官方模板名；上游 `PROFILE_TEMPLATES` 只有 `web`、`acp`、`headless`、`sdk`、`sdk-minimal`。

`desktop` 沿用 anywhere-labs 桌面版建立的命名惯例；本项目不再引入 `dsh-native-desktop` 之类的产品别名。

直接启动一个不存在的非模板 profile 时，上游会报错。

只有通过 `dsh plugin --profile desktop ...` 首次管理时，上游才以 `DEFAULT_PROFILE_BUNDLES` 做最小初始化，初始 bundle 仅有 `@deepseek-ai/dsh-base`。

上游不会为已存在的非模板 profile 重排 bundle。把 `dsh-base`、`dsh-web-app` 与本插件写入新 profile，并修复其前缀、保留第三方 bundle 顺序，属于本项目 `profile-manager` 的 `reconcileDesktopProfile()`。

`reconcileDesktopProfile()` 不能用固定清单覆盖整个 profile，也不能修改其他 profile。

### 3.2 同一个 home 只允许一个活跃 Host

`~/.dsh` 是普通磁盘目录，不是一个负责协调客户端的常驻服务。desktop 与 CLI 每次启动都会各自 boot 一个 Host；“共享 home”只保证它们能看见同一份磁盘数据。

不同 profile 只隔离组合配方，不隔离 `settings.yaml`、会话和 `storages/*.json`。

上游 JSONL session backend 要求同一会话只有一个活跃 writer，JSON storage 也没有跨进程写锁。因此 v1 对整个 home 取排他 lease，而不是只锁 profile。

Desktop 正在运行时，仍然可以正常打开终端并执行普通系统命令。但受支持入口不会再启动第二个会写 `~/.dsh` 的 DSH Host，也不会执行修改该 home/profile 的 `dsh plugin` 命令。

需要使用这类 CLI 命令时先完全退出 Desktop；CLI 结束后再启动 Desktop。以后改成“一个 Host、多个客户端”后，这项限制可以取消。

lease 目录为 `<home>/run/host.lock/`，通过原子 `mkdir` 获取，目录内记录：

- schema version；
- 随机 lease generation；
- supervisor PID 与进程启动时间标识；
- Host 子进程 PID 与进程启动时间标识（子进程创建后原子补写）；
- 启动入口（desktop 或 bundled-cli）；
- profile；
- 创建时间；
- 应用版本。

home lease 不直接复用上游 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`。该原语用于短时单文件 read-modify-write，只记录 PID，并在有界等待后失败。

home lease 覆盖整个受支持入口的写入生命周期。Desktop 由 launcher 持有，跨 Host 重启、安全模式和 profile 事务保持不释放；配套 CLI 由包装进程持有，直到其 Host 子进程退出。该 lease 还要支持所有者诊断和受控恢复，因此是独立协议。

实现应复用上游 `writeFileAtomic` 写入 owner 元数据，并对齐 `withFileLock` 的两项原则：排他创建，以及绝不根据文件年龄猜测 owner 已失效。

长生命周期 lease 仍由独立的 `home-lease` 包负责。

处理规则：

1. 桌面端与配套 CLI 都必须在任何 DSH boot、profile 写入或 cache 恢复之前取得 lease。
2. lease 所有者仍存活时，竞争者不得抢占、杀进程或修改 lock；它只显示所有者信息并退出。
3. 所有者确认不存在时才允许清理陈旧 lease。PID 存活但身份无法确认时视为仍被占用，不自动清理。
4. 正常关停先请求 Host dispose，并确认 Host 子进程已经退出；之后才释放 lease。释放前必须重新读取 owner，只有 generation、supervisor PID 和进程启动标识仍与本次 acquisition 一致时才删除；身份不匹配时拒绝删除。
5. 应用自己的 `requestSingleInstanceLock()` 继续保留；它解决同一 Electron 应用重复启动，home lease 解决不同 DSH 入口竞争。
6. launcher 异常退出时必须尽力终止其 Host 子进程。`doctor --unlock` 同时检查 supervisor 与 Host 身份；只要任一受支持 Host 仍存活，就不能清理 lease。

如果进程在创建 lease 目录后、写完 owner 信息前崩溃，该 lease 视为身份不明并保持不动。

配套的 `dsh-native doctor --unlock` 先扫描受支持的桌面与 CLI 进程。确认没有活跃 owner 后再由用户显式清理；启动流程本身不根据 lock 年龄强制解锁。

Desktop 因身份不明 lease 启动失败时，错误对话框和 stderr 必须给出可复制的 `dsh-native doctor --unlock` 命令，并说明该命令会先检查活跃 owner。

普通日志只记录错误类别，不记录完整 home 路径。

项目附带 `dsh-native` CLI 启动器，转发完整 CLI 参数并使用与桌面包一致的 DSH 版本。它持有 lease 直到子进程退出。共享 `~/.dsh` 时，这是受支持的 CLI 入口。

直接使用其他 CLI 时，用户必须先完全退出桌面端。README 要明确区分“数据可互通”和“进程可并发”；不得再使用“多 profile 天然支持并发共存”的表述。

未来不以“允许更多 Host 共同写 home”作为首选路线。本项目优先让配套 CLI 和远程客户端复用桌面端持有的长期 Host。

只有上游提供完整跨进程 ownership/locking 时，才重新评估多 Host 并发。

### 3.3 长期演进目标：一个 Host、多个客户端

v1 的 Desktop 和 CLI 仍是两个互斥入口，但目标架构已经确定为：

```text
一个长期运行的 DSH Host
  ├── Electron 本地客户端
  ├── 配套 CLI 客户端
  └── 经授权的远程客户端
```

这项方向约束后续设计，但不要求 v1 提前实现常驻 daemon、CLI attach 或远程服务。具体约束如下：

1. Host 是 session、storage、插件状态和业务权限的唯一运行时权威。
2. 客户端通过正式的 typed Remote、事件流或等价的本地 carrier 与 Host 交互，不能直接改写会话文件。
3. 本地 Electron、配套 CLI 和远程设备具有不同 principal；“能连上 Host”不等于拥有相同权限。
4. `isLoopback` 只能用于界面呈现和能力提示，不能充当 Host 端授权依据。
5. 远程访问不得通过再启动一个共享 `~/.dsh` 的 Host 实现。

v1 的 loopback authenticated URL 是一种本地传输实现，不是 Desktop 插件的永久业务协议。插件只依赖抽象的本地 surface handoff；以后可切换为 `file:// + IPC bridge`，而不改写 Desktop 产品逻辑。

### 3.4 壳只恢复自己拥有的状态

v1 不采用把 profile 文件与 home 级 `settings.yaml`、`cordis.patch.yml` 一起恢复的“五件套 checkpoint”。纯壳采用“启动前 profile 快照 + 修订校验”，不做 home 全局快照。

启动恢复流程：

1. 取得 home lease。
2. 在自动修改 profile 前，记录目标文件的存在性、内容和 SHA-256。
3. 由 `profile-manager` 运行 `reconcileDesktopProfile()`，记录本次自动修改后的 SHA-256。
4. 候选 Host 子进程完成结构化握手、通过稳定性窗口且 BrowserWindow 挂载成功后，将修改后版本标记为 healthy。
5. 如果本次启动失败且确实自动修改过 profile，只在当前文件仍等于“本次修改后 SHA”时恢复修改前内容。
6. 如果当前 SHA 已变化，说明用户或其他程序做过修改；停止自动恢复并给出诊断，绝不覆盖。
7. 恢复只涉及 `profiles/desktop` 下明确列入白名单的文件，并通过临时文件加原子替换写回。
8. 一次恢复后最多 relaunch 一次，marker 防止循环。

以下错误不触发 profile 回滚：

- home lease 被占用；
- 端口冲突或权限错误；
- home 级 patch/settings 语法错误；
- 凭据缺失；
- 图标、菜单或 Electron userData 错误；
- 打包运行时本身不兼容。

打包运行时不兼容时，profile 回滚无法恢复旧依赖。上一版 DMG 只能回退应用二进制；只有持久化格式仍向后兼容时，它才能继续读取现有 home。

配置 checkpoint 和旧 DMG 都不能描述成无条件的数据回滚。

超大 `session_projcache` 隔离仍可保留，但只能在取得 home lease 后执行。隔离前后记录路径、大小和备份文件，不删除源数据；该缓存属于可重建派生数据。

### 3.5 Host 无法启动时仍可用的控制面

Electron launcher 在 Host 启动前已经存在，并且不加载 DSH 或第三方插件代码。它必须能在以下情况下保持运行：Host boot 失败、Host 异常退出、正常 profile 被第三方插件阻塞，以及安装更新前主动停止 Host。

v1 的 launcher-owned 恢复面只提供启动日志摘要、重试、退出和 lease 诊断，不在 Electron Main 中复制 DSH 设置、会话或市场业务。

M2 已交付非破坏性的 Safe Mode（源码级验收通过），它同时是后续插件市场的前置条件：停止正常 Host 后，以独立的 `desktop-safe-mode` profile 启动 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与本项目最小第一方 bundle `desktop-recovery-bridge`。该 profile 不读取正常 `desktop` profile 的 `desktop-plugin`、第三方 bundle、依赖树或 patch layer，但仍复用同一 home 中的凭据、会话和用户数据。

`desktop-recovery-bridge` 只等待官方 `connection` 服务，并通过与正常 Desktop 相同的 Host-control surface 契约发布 authenticated recovery URL。它不包含市场 catalog、产品 settings、profile 变更、窗口逻辑或更新策略。即使 Safe Mode Host 或该 bridge 失败，launcher-owned 的日志摘要、lease 诊断、重试和退出仍然可用。

Safe Mode 不自动改写正常 profile。禁用或卸载某个第三方插件必须由用户明确选择，并经 `desktopProfileManager` 对准确插件 generation 执行事务。故障归因应综合 Host 日志、renderer 错误、profile manifest、lockfile、bundle/loader id、依赖关系和 patch row，不得仅凭“最后安装”猜测责任插件。

## 4. 代码架构

项目从一开始把通用壳机制与产品差异分开，避免形成多套长期维护实现。

```text
deepseek-harness-desktop/
├── apps/
│   └── desktop-launcher/        # Electron 自举入口、应用身份、素材与打包配置
├── packages/
│   ├── desktop-plugin/          # DSH bundle 插件，Desktop 产品集成主体
│   ├── desktop-recovery-bridge/ # M2 已交付，也是 E3 前置的 Safe Mode surface bridge
│   ├── desktop-contracts/       # 按能力分入口、独立版本的可序列化窄控制契约
│   ├── host-supervisor/         # 独立 Host 进程、握手、就绪探测、重启与有界关停
│   ├── profile-manager/         # ProfileRef、reconcile、修订恢复与未来 generation 事务
│   ├── shell-core/              # Electron 生命周期、窗口、托盘、日志与跨组件编排
│   └── home-lease/              # DSH home 排他 lease 与 CLI 复用
├── scripts/
│   ├── dsh-native.mjs           # 带 lease 的配套 CLI 入口
│   ├── sync-dsh-runtime.mjs     # 根据 fork lock 生成精确依赖
│   └── package-smoke.mjs        # 对打包产物执行冒烟
├── tests/
│   ├── integration/
│   └── fixtures/
└── docs/
```

### 4.1 Desktop 插件与 launcher 的边界

Desktop 必须是一个 DSH bundle 插件，但不能只有插件。插件要等 DSH Host boot 并加载 profile 后才会执行。

因此插件无法负责创建承载自己的 Electron 进程、获取 boot 前的 home lease，或处理 DSH 尚未启动时的失败。

完整关系如下：

```text
Electron desktop-launcher
  → 获取应用单实例锁与 home lease
  → prepare profile 与私有控制通道
  → 以中性 launch-root 启动独立 DSH Host 子进程
  → Host runner 调用 boot() 并注入 desktopSurface proxy/cmdline
  → DSH Loader 加载 desktop-plugin
  → desktop-plugin 取得窄化的 desktopSurface proxy
  → desktop-plugin 校验 loopback 并取得 authenticated URL
  → desktop-plugin 通过控制通道发布 { kind: 'loopback', url } surface
  → launcher 校验 channel capability、lease generation 与消息 schema
  → launcher 创建 BrowserWindow/Tray
```

`desktop-plugin` 的 `package.json` 必须声明 `dsh.bundle.patch`。patch 在官方 `dsh-web-app` 层之后插入插件，并关闭 `web-runtime.openBrowser/printUrl`。

v1 macOS 优先使用 Electron `utilityProcess.fork()` 承载 Host runner；若所选 Electron 版本不能满足 Node capability、消息通道或父进程退出清理要求，才改用随应用打包的同架构 Node 子进程。两种方式都必须通过相同的 `host-supervisor` 契约测试，选择结果不得泄漏到 `desktop-plugin`。

插件本身不导入 Electron，不直接创建窗口，也不拥有进程退出。Host 子进程与 Electron Main 的进程隔离用于故障收敛和生命周期控制，不宣称为第三方插件提供权限沙箱。

v1 唯一注入的公开原生契约是 `desktopSurface`。它是可序列化的窄控制契约，只接收受控的本地 surface 描述，并负责把该 surface 调度到 Electron 窗口。控制通道必须绑定一次性 capability、lease generation 和 Host 进程身份；不得提供任意 Electron 调用、任意 IPC 或通用 `desktopRuntime` 对象，也不得靠解析 stdout 文案传递 authenticated URL。

Desktop 插件负责：

- 声明 DSH bundle 和壳层 patch；
- 以可选方式取得 `desktopSurface`，无 launcher 时输出一次明确提示后降级；
- 注册 `dsh-native-shell` settings namespace；
- 校验 Web Server host 必须为 `127.0.0.1`；
- 等待 DSH `connection` 服务，取得 authenticated URL；
- 在 DSH effect 生命周期内调用 `desktopSurface.schedule({ kind: 'loopback', url })`；
- 只通过正式 DSH 服务、事件、路由或共享数据与其他插件交互。

Electron launcher 负责：

- 配置 Electron 应用身份和 userData；
- 在 DSH boot 前获取应用单实例锁与 home lease；
- 准备 profile、私有控制通道和不位于应用 bundle/用户 workspace 内的中性 `launch-root`；
- 监督独立 Host 子进程，校验握手与稳定性窗口，执行有界 dispose/terminate/kill；
- 拥有 BrowserWindow、Tray、Dock、菜单、快捷键和 renderer session；
- 在 Host 不可用时提供最小恢复/更新控制面；
- 处理 boot 前错误、Host 异常退出、重启和最终进程退出；
- 在 Host 子进程确认退出后释放 home lease。

这条边界保证“Desktop 是插件”，同时承认插件不能创建加载它的 Host。launcher 是自举适配器，不是第二套 Desktop 产品逻辑。

Safe Mode 使用相同链路，但 surface publisher 换成 `desktop-recovery-bridge`。Host-control 契约不根据 publisher 包名改变；launcher 只接受满足 mode、profile、capability、lease generation、Host 身份与消息 schema 的 surface。

`desktop-contracts` 只放置跨边界消息、服务定义和契约测试，不依赖 Electron。一个物理包内按 `host-control`、`profile-manager`、`updater`、`secure-store`、`remote-bridge` 等 subpath export 隔离能力，每项能力拥有独立的 `{ name, major, minor }` 版本。

同一 major 内只允许增加可选字段或协商后的新消息，major 不匹配直接失败。双方先协商 minor，发送方不得发送协商版本不支持的消息；未知类型、错误 generation、重复 ready 和失效 capability 一律拒绝。每个受支持版本都保留双向契约 fixture。

以后新增原生能力时，每项能力使用独立服务，例如 `desktopUpdater` 或 `desktopSecureStore`；不得扩展成万能对象。

Host 控制通道的 capability 只认证 launcher 所启动的 Host 进程，不能证明 Host 内是哪一个插件调用了服务。第三方插件与第一方插件同进程运行时，包依赖或服务名不是安全边界。profile 变更、Desktop 更新和密钥支持的操作必须再经过能力自身的策略校验与 launcher-owned 本地用户确认；`desktopSecureStore` 只提供签名、解密、封装或删除等窄操作，不向 Host 返回原始私钥。

### 4.2 `profile-manager` 的职责

- 定义和校验 `ProfileRef`，不硬编码 `desktop`。
- 通过 `reconcileDesktopProfile(ProfileRef)` 初始化或修复本项目拥有的 profile 投影。
- M0 在修改前记录存在性和 manifest SHA-256，执行白名单与原子替换；M2 再加入持久事务、修订校验和原子恢复。
- 创建和校验 Safe Mode profile 投影，但不在 Safe Mode 启动时自动修改正常 profile。
- 在 E3 引入后拥有不可变 generation ledger、事务 journal、drift 检测、定点禁用与回滚；Electron 和产品 UI 不成为第二权威。
- 不依赖 Electron；共享 home 写入要求调用方已持有对应 home lease；M0 专属 `userData/m0-dsh-home` 只接受显式隔离 authority。

### 4.3 `shell-core` 的职责

- 解析但不篡改 DSH home。
- 通过 `home-lease` 获取和释放 lease，通过 `profile-manager` 准备或恢复 profile。
- 为 launcher 编排 `profile-manager`、`host-supervisor`、窗口和恢复状态；官方 `boot()`、`provideCmdline()` 与 `desktopSurface` proxy 的注入只发生在 Host runner 子进程。
- Host runner 在中性临时 launch root 写启动用 `cordis.yml` 和选中 bundle 的局部 fallback；shared fallback 只投影安装依赖闭包，启动不修改 named profile。
- 管理 BrowserWindow、Tray、全局快捷键、窗口状态和外链策略。
- 有界关停 Host 子进程和 Electron 资源。
- 输出结构化本地日志。
- 编排 `profile-manager` 在所有权范围内执行启动恢复。
- 提供测试探针，但不包含产品或 PKM 文案。

### 4.4 产品配置的职责

`desktop-launcher` 与 `desktop-plugin` 共享一份只含产品差异的配置：

- `productName = DeepSeek Harness Desktop`；
- `binName = dsh-desktop`；
- `defaultProfileName = desktop`；
- `settingsNamespace = dsh-native-shell`；
- 默认 loopback 端口；
- 图标、托盘素材和菜单模板；
- 壳层 `cordis.patch.yml`；
- 首次凭据缺失提示。

`desktop` 是 v1 默认值，不是底层 API 的硬编码。profile 准备、恢复、插件管理和未来升级接口都接收已解析的 `ProfileRef`；v1 launcher 只传入 `desktop`。

纯壳不得包含任何 PKM workspace seed、memoryRoot/PARA 创建、PKM 路由、工作台状态或领域专用冒烟。本仓库独立拥有自己的需求、代码、发布和升级验证，不依赖其他产品仓库。

### 4.5 后续功能的插件与原生边界

后续功能独立组合，不继续扩张 `desktop-plugin`：

| 能力            | DSH 产品插件       | launcher/原生能力                                | 关键边界                                                                                     |
| --------------- | ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 插件市场        | `plugin-market`    | `desktopProfileManager`                          | catalog 与安装分离；不得直接把 UI 参数转发给 pnpm                                            |
| 远程访问        | `remote-access`    | `desktopSecureStore` 与独立 bridge/relay adapter | 复用 typed Remote；bridge 只承载受限 surface，身份和授权由 Host 强制执行                     |
| 桌面升级        | `desktop-updater`  | boot-independent `desktopUpdater`                | 插件承载正常 UI/策略；launcher 负责 Host 不可用时的检查入口、签名验证、替换、恢复与 relaunch |
| 桌面终端        | `desktop-terminal` | `desktopTerminal`                                | 只打开显式 profile 环境，不暴露任意 shell IPC                                                |
| 多 profile 管理 | `desktop-profiles` | `desktopProfileManager`                          | 所有操作接收 `ProfileRef`，默认值才是 `desktop`                                              |

市场安装是 profile 变更事务。活跃 Host 运行期间只允许在隔离 staging 目录中解析依赖、校验制品和静态验证配置。

每个插件版本安装为不可变 generation；generation id 至少绑定 package name、精确版本和解析后 lockfile/制品摘要。generation 提升后不得原地修改，升级必须创建新 generation。

每个 `ProfileRef` 分别记录 `desired`、`active` 与 `lastKnownGood`。这三个字段只记录已经提交或明确请求的 generation 引用，不能代替事务 journal。profile manifest、依赖链接和 bundle 列表是 active generation 的物化投影，不能与 generation ledger 形成两个互相竞争的权威来源。

每次 profile 变更都写入可恢复的事务 journal，状态依次为 `staging`、`verified`、`prepared`、`activating`、`health-checking`，最后进入 `committed` 或 `rolled-back`。每个状态转移先原子持久化意图和前后 generation，再执行外部副作用；重启后由 `profile-manager` 根据 journal、当前投影和 Host 健康记录幂等继续或回退，不能只靠目录是否存在猜测。

进入生效阶段前先停止接收新任务并 dispose Host，再原子切换 profile generation。候选 Host 启动失败时，只回退本次 profile 事务，然后重新启动旧 generation。

候选 Host 通过稳定性窗口后才更新 `active` 与 `lastKnownGood`。至少保留上一组健康 generation；清理只处理超过保留策略且未被 `desired`、`active`、`lastKnownGood` 引用的 generation。

v1 在 Desktop 完全退出后仍允许用户通过标准 `dsh plugin` 管理 `desktop` profile。E3 把某个 `ProfileRef` 纳入 generation 管理后，直接修改其 manifest、lockfile、bundle 或依赖链接会被标记为 `drift`；`profile-manager` 只能让用户显式选择“导入为新 generation”或“恢复 active 投影”，不得静默覆盖或把未知状态直接标记为 healthy。

React、Cordis 和 `@deepseek-ai/*` 等 Host singleton 由发行版兼容性清单声明所有权与支持范围。generation 校验必须确认这些依赖解析到 Host 的安装闭包，不能仅靠包名正则猜测兼容性。

不得在活跃 profile 中一边运行插件，一边改写其 `package.json`、lockfile 或依赖树。任何 boot 预检若需要启动 Host，都必须使用隔离测试 home。

第三方插件与 Host 同权运行。没有独立沙箱前，权限清单只能用于告知和策略拒绝，不能宣称已经隔离恶意代码。首个市场版本应采用受信 catalog、精确版本、校验和与明确发行者。

市场中的可执行插件、preset/配置包和 Desktop 应用更新是三类不同制品：分别使用代码信任、数据导入与原生签名/迁移策略。preset/配置包必须先预览和验证，再原子安装；不得与可执行插件共用含糊的“一键安装”权限。

远程访问保持 DSH Host 只绑定随机 loopback 端口。显式启用时由独立 bridge 暴露受限远程 surface；配对使用短期随机挑战和本机确认，互联网 tunnel/relay 只能转发 bridge，绝不能把 Harness 重新绑定到公网。bridge 不得根据远端 IP 自动授权，也不得把本地 browser session 或拥有全部权限的 Host session 直接升级为设备身份。

进入 E4 前必须针对当时固定的 DSH 基线完成授权可行性 prototype，证明 principal 可以从 carrier 传播到 Host，并在每个目标方法执行前强制检查 scope、审计和撤销。如果上游没有足够扩展点，E4 必须停在设计阶段，先实现或向上游贡献授权中间层；不能把检查下沉为 bridge allowlist 或 UI 隐藏。

更新控制面必须能在普通 Host 和 `desktop-updater` 插件都无法启动时工作。launcher 只实现更新状态机、可信元数据/签名校验、下载、停止 Host、替换和 relaunch；兼容性解释、channel 策略和正常应用内 UI 仍属于插件。

插件提出的 channel 或 feed 策略必须由 launcher 校验并保存为 last-effective policy。应用内同时固化不可由 Host 插件替换的签名信任根与 emergency stable source；Host 无法启动时，launcher 只使用 last-effective policy，校验失败或缺失时退回 emergency stable source。默认流程是先提示、用户同意后下载、再次明确选择后安装；跳过一个版本不能永久屏蔽后续版本。

Host-control v1 的精确 envelope、消息与协商规则由 [`docs/protocols/host-control.md`](protocols/host-control.md) 固定。市场 provider、generation 持久化布局、远程 relay、设备凭据格式和 updater channel 在各自进入实现前分别建立 ADR 与契约文档。

## 5. 启动与关停状态机

### 5.1 启动

```text
配置 Electron 身份/userData
  → 获取应用单实例锁
  → app.whenReady()
  → resolveDshHome()
  → 获取 home lease
  → 恢复可重建的超大 projection cache
  → 快照并 reconcile 桌面 profile
  → prepareProfile()
  → 创建私有控制通道与中性 launch-root
  → launcher 启动独立 Host runner 子进程
  → Host runner 调用 boot() 并注入 desktopSurface proxy/cmdline
  → DSH Loader 加载 desktop-plugin
  → desktop-plugin 发布 loopback surface
  → launcher 校验握手、capability、lease generation 与稳定性窗口
  → launcher 挂载 BrowserWindow
  → 挂载 Tray/快捷键
  → 标记 profile healthy
  → ready
```

每一步使用显式阶段名写日志。错误处理根据失败阶段决定是否允许 profile 恢复，不靠宽泛的错误字符串猜测。

lease 失败使用独立诊断，不折叠成普通 boot 错误。活跃 owner 冲突显示入口、profile 和进程信息；身份不明时显示 `dsh-native doctor --unlock`，并在任何 profile 写入前退出。

Host 在 ready 前失败时，launcher 保持运行并显示结构化失败阶段；Host 在 ready 后异常退出时，销毁失效的 renderer surface，但保留恢复窗口。自动重启有明确上限，不能形成 crash loop。

### 5.2 关停

```text
进入 quitting 状态并阻止新窗口/新任务
  → 通过控制通道请求 Host 停止接收新任务并 dispose
  → 等待 dispose ack 与 Host 子进程退出（均带超时）
  → 必要时 terminate，最后才 force kill
  → 注销快捷键与托盘
  → 销毁 BrowserWindow/恢复窗口
  → 释放 profile resolver
  → 释放 home lease
  → app.exit(code)
```

关窗默认隐藏到托盘；只有菜单“退出”、系统退出事件或明确的失败路径才进入关停状态机。关停必须幂等。

## 6. 安全约束

1. Web Server host 固定为 `127.0.0.1`，端口由本项目设置 namespace 解析。
2. BrowserWindow 必须启用 `contextIsolation`、`sandbox`、`webSecurity`，并禁用 `nodeIntegration`。
3. Electron Main 不加载 DSH Host 或第三方插件代码；需要 Node internals 的启动参数只授予 Host 子进程。进程隔离不等于权限沙箱，Host 仍按当前用户权限运行。
4. Host 控制通道必须验证 capability、protocol version、lease generation、消息 schema 与发送进程身份；不接受任意方法名、任意 Electron 调用或 stdout 文案协议。
5. 所有 privileged preload/Electron IPC 都必须校验发送 BrowserWindow、main frame、当前可信 origin 和参数 schema；仅判断 URL 为 loopback 不足以授权。
6. 主 frame 只允许 authenticated URL 的同源导航和重定向。
7. 新窗口一律拒绝；仅把 `https:`、`http:`、`mailto:` 交给系统浏览器。
8. profile resolver、home lease 与恢复路径都必须验证绝对路径和预期父目录，不能跟随用户可植入的目标符号链接进行覆盖。
9. Host 使用 launcher-owned 中性 cwd；环境变量按显式规则解析和过滤，不能意外继承会改变 Node/Electron 执行模式的控制变量。
10. 不把控制通道 capability、进程令牌、凭据内容、完整 home 路径或会话内容写入普通日志。
11. 所有本地状态目录使用 owner-only 权限；锁文件和诊断文件不包含秘密。
12. v1 不监听非 loopback 地址，也不创建可从其他设备使用的启动 URL。
13. 未来远程连接必须获得独立 principal；本地 browser cookie 不得直接升级为远程设备身份。
14. 远程授权必须在 Host 方法执行前强制检查，不能依赖 bridge allowlist、客户端隐藏按钮或 `isLoopback` 分支。
15. 远程传输必须使用 TLS 或具有等价机密性与服务端认证的可信中继，并支持逐设备撤销和审计。
16. 远程 principal 默认无权安装插件、写入凭据、切换 profile 或更新 Desktop；开放这些能力需要单独策略和本地确认。
17. Host 控制通道只能认证 Host 进程，不能认证 Host 内的调用插件；敏感原生操作必须执行能力级策略，并在 launcher-owned UI 中取得本地用户确认。
18. `desktopSecureStore` 不向 Host 返回原始私钥或可长期复用的主秘密，只提供用途受限的密码学操作。

## 7. DSH 依赖与升级

### 7.1 初始基线

初始化版本直接使用当时最新的上游 DSH 发布 tag，不先落到旧版本再升级。

初始基线为 `dsh-v0.1.2-alpha.3`（commit `dd6322d604e00eec1ba5e0c8541159906a21094a`，M1–M4 交付于其上）。

2026-09-08 经独立资格验证升级为 [`dsh-v0.1.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1)（commit [`a66e4702047846cdaa10c66c9d3df3951f5ea70d`](https://github.com/deepseek-ai/deepseek-harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d)，见 [验收记录](validation/dsh-0.1.2-rc.1-acceptance.md)）。

正式开始实现前再次查询上游 tag；如果已有更新，则同步更新本节记录和依赖锁。

DSH 包逐包精确 pin。若最新 alpha 未发布到 npm，则从本项目维护的打包流程生成 Release 制品和 SHA-256 清单。

catalog、overrides 和 lock 文件由脚本生成与校验，禁止手工维护数百条 URL。

历史本地补丁不自动继承。只有在最新基线上仍能复现问题且带有本项目回归测试时才保留。

### 7.2 初始化参考记录

外部桌面项目只作为实现参考。初始化时固定记录所阅读的版本，避免以后把变化后的代码误当成当初依据：

| 项目                               | 初始化参考点                                                                                                                                                                                                                                              | 参考范围                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| anywhere-labs/dsh-desktop          | commit [`e71a9ef0b168763d422042835a8c3b7d6d809800`](https://github.com/anywhere-labs/dsh-desktop/commit/e71a9ef0b168763d422042835a8c3b7d6d809800)（2026-08-30 master HEAD，晚于 v2.0.4 tag `d29bf7a`）                                                    | Desktop 插件/launcher 边界、profile 修复、Electron 生命周期、打包与平台适配           |
| anywhere-labs vendored DSH runtime | [`0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)，upstream commit [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc) | 只用于理解其当时兼容性处理，不作为本项目 DSH 基线                                     |
| dataelement/dsh-desktop            | commit [`07fd40a2a9301fd34672931faeb37d1ddbe67538`](https://github.com/dataelement/dsh-desktop/commit/07fd40a2a9301fd34672931faeb37d1ddbe67538)（2026-08-31 main HEAD）                                                                                   | 独立 Host 进程监督、Safe Mode、插件 generation、配对 bridge、更新状态机与目标平台打包 |
| dataelement vendored DSH runtime   | [`0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)                                                                                                                                                                | 只用于理解其协议适配与 generation 实现，不作为本项目 DSH 基线                         |

后续只有在实际查阅新的外部代码并采用了其中思路时，才更新这张记录。外部项目的 PR、release 节奏和测试结果都不是本项目的升级信号或放行条件。

本方案采用的是架构模式，不复制外部项目实现。若以后直接移植 dataelement 的代码，必须按其 [MIT License](https://github.com/dataelement/dsh-desktop/blob/07fd40a2a9301fd34672931faeb37d1ddbe67538/LICENSE) 保留版权和许可声明，并在本项目依赖/NOTICE 记录中注明来源。

### 7.3 升级信号

本项目只根据以下信号决定是否评估升级：

1. 上游发布新的 DSH tag；
2. 当前基线存在影响本项目的上游 bug、安全问题或格式变化；
3. 本项目真实使用暴露出需要新版本解决的问题。

是否放行只取决于本项目的依赖闭包、补丁对账、测试和打包产物，不由任何其他桌面或产品项目代替判断。

### 7.4 版本所有权与兼容性清单

M0 已建立 [`compatibility.json`](compatibility.json) 作为首份机器可读清单。M3 起清单状态为 `packaged-candidate-local`，并新增安装制品记录（releaseId、darwin-arm64、制品 SHA-256 与闭包摘要见 `release/artifacts.json` 与内嵌清单）；平台矩阵只包含实际构建并运行过的架构。

Desktop 发行版同时涉及四条独立版本轴：

| 版本轴                        | 所有者                 | 升级风险                              |
| ----------------------------- | ---------------------- | ------------------------------------- |
| Desktop/Electron 应用         | 本项目发行版           | 原生代码、签名、安装和 relaunch       |
| 内置 DSH runtime              | 本项目依赖闭包         | Host/API 行为和 profile bundle 兼容性 |
| `desktop` profile 插件        | 用户与 profile manager | 第三方代码、依赖解析和组合启动失败    |
| session/storage/settings 格式 | 对应 DSH provider      | 新版本写入后，旧版本可能无法读取      |

每个发行制品必须携带机器可读兼容性清单，至少记录：Desktop 版本、DSH tag/commit、支持的 plugin API/DSH 范围、profile schema、已知持久化格式版本、平台/架构和制品 SHA-256。

README、关于页和诊断输出中的 DSH 版本必须从兼容性清单或依赖锁生成，不能手工维护相互独立的版本文案。

未来更新服务先读取清单并执行迁移预检，再允许下载后的制品进入安装阶段。

涉及不可逆数据迁移时，必须在 Host 停止写入后创建可验证备份，并明确禁止自动降级到无法读取现有数据的版本。

插件升级与 Desktop 升级是两个事务。更新 Desktop 不得顺带静默升级用户插件；市场也不得替换内置 DSH runtime。

### 7.5 每次升级流程

1. 建立候选分支并更新上游 commit/tag。
2. 重建 fork Release 制品和 SHA-256 清单。
3. 生成 catalog/overrides/lock，验证所有 DSH 包来自同一基线。
4. 对每个本地补丁执行“上游是否已包含、能否干净应用、对应回归测试是否仍失败”的三项检查。
5. 对比兼容性清单，检查 profile、插件 API 和持久化格式变化。
6. 若需要迁移，使用复制的真实数据 fixture 执行升级、重启和禁止降级测试。
7. 运行单元测试、共享 home 集成测试和全部桌面冒烟。
8. 构建 DMG，对打包产物而不是源码 dev 入口执行冒烟。
9. 保留上一版 DMG 作为二进制回退候选；只有兼容性清单允许时才用它打开升级后的 home。
10. 人工使用一个观察周期后再把候选标记为当前版。

## 8. 验收测试

### 8.1 单元测试

- home lease：首次获取、活 owner 拒绝、陈旧 owner 恢复、身份不明时拒绝、generation 不匹配时拒绝释放、幂等释放。
- home lease 进程树：supervisor/Host 身份记录、Host 重启期间持续持有、launcher 异常退出后的存活 Host 拒绝解锁。
- lease 诊断：身份不明错误包含可复制的 `dsh-native doctor --unlock`，并在 profile 写入前退出。
- desktop-plugin：bundle patch 可组合、无 `desktopSurface` 时降级、非 loopback 拒绝、connection 就绪后只 schedule 一次。
- desktop-contracts：surface 描述严格校验，major 不匹配、未知 kind、错误 capability 或 lease generation 被拒绝；minor 只允许 additive 演进；每个 subpath 有独立版本和双向 fixture；契约包不依赖 Electron，也不存在通用原生调用入口。
- host-supervisor：独立 PID、握手超时、稳定性窗口、启动失败、异常退出、dispose ack、terminate/force-kill 升级和幂等停止。
- profile reconcile：缺失 profile 初始化、官方 bundle 前缀修复、第三方 bundle 保序、无关 profile 不变。
- profile 恢复：只恢复白名单、SHA 不匹配拒绝、缺失文件恢复、一次性 relaunch。
- profile manager 边界：不依赖 Electron，只在调用方持有 home lease 时写入；未来受管 profile 的外部修改识别为 drift，不自动覆盖。
- 关停：并发请求合并、dispose 超时、资源只释放一次。
- 窗口状态：离屏回退、最大化、崩溃重载上限。
- 设置：坏 YAML 可读报错，不覆盖用户文件。
- profile 参数：底层准备、恢复与未来 mutation API 接收 `ProfileRef`；只有 launcher 默认传入 `desktop`。
- Electron IPC：错误窗口、非 main frame、非可信 origin 与畸形参数全部拒绝。

### 8.2 共享 home 集成测试

这些测试是 v1 的核心放行门：

1. 配套 CLI 创建会话并退出，桌面端能够列出和继续该会话。
2. 桌面端创建会话并完全退出，配套 CLI 能够继续该会话。
3. 桌面端持有 lease 时，配套 CLI 在 boot 前拒绝；反向亦然。
4. 两个入口使用同一凭据和 settings 文档，但不会复制或迁移它们。
5. CLI 修改 `settings.yaml` 后模拟桌面启动失败，设置内容保持不变。
6. 修改 home `cordis.patch.yml` 后模拟失败，桌面端不回滚它。
7. 用户修改桌面 profile 后，旧 checkpoint 因 SHA 不匹配而拒绝覆盖。
8. 超大 projection cache 只在持有 lease 时隔离，原文件以备份形式保留。
9. Desktop Host 与 Electron Main 使用不同 PID；Host 重启期间 lease 不释放，配套 CLI 始终不能趁窗口进入共享 home。

### 8.3 桌面冒烟

- `smoke:dsh-ui`：官方侧栏、会话区、设置页加载完成。
- `smoke:conversation`：创建会话、发送一轮、重启后恢复。
- `smoke:auth`：无令牌请求被拒绝，authenticated URL 可加载并形成持久 cookie。
- `smoke:navigation`：主 frame 跨源被阻止，允许协议交给系统浏览器。
- `smoke:lifecycle`：关窗隐藏、托盘唤出、重复启动聚焦、退出后无残留 Host。
- `smoke:host-crash`：终止 Host 子进程后 Electron 壳保持存活、失效 surface 被销毁、恢复面可重试，且不会形成 crash loop。
- `smoke:profile-recovery`：本次自动 profile 修改失败时仅恢复 profile。
- `smoke:package`：安装后的 `.app`/DMG 能独立启动，不依赖仓库 `node_modules`。

## 9. 打包与发布

使用 electron-builder 生成 macOS DMG，应用 bundle id、产品名、图标、Electron userData 和 renderer partition 均使用本项目专属值。

v1 是本机自用构建，不实现自动更新。构建输出包含：

- DMG；
- 应用版本、DSH tag/commit、fork release tag；
- SHA-256；
- 本地补丁清单；
- 测试结果摘要。

如果以后公开分发，必须另立决策补充 Developer ID 签名、hardened runtime、notarization、隐私说明和升级通道；不能把本机可运行的 DMG 当成公众发行完成。

## 10. 实施里程碑

M1–M4 已拆成可交给 zcode 的逐任务文档，见 [执行路线与交接](superpowers/plans/2026-09-02-m1-m4-execution-roadmap.md)。这些计划以 M0 验收提交 `2f84e04` 为起点；M1、M2 已实施验收并合并 `main`；M3 已实施、通过 codex 复审与制品级验收并合并 `main`；M4 已实施并通过制品级演练验收（`codex/m4-release-compatibility`，见 [M4 验收记录](validation/m4-acceptance.md)）。

### M0：独立最小闭环（2026-09-02 完成源码级验收）

- 建立 workspace、`apps/desktop-launcher`、`packages/desktop-plugin`、`packages/desktop-contracts`、`packages/host-supervisor`、`packages/profile-manager` 与 `packages/shell-core`。`desktop-recovery-bridge` 是 E3 前置交付，不在 M0 实现。
- 实现独立 Host runner、私有控制通道、结构化握手、稳定性窗口与有界关停；Electron Main 不直接调用 DSH `boot()`。
- 在 `profile-manager` 实现并测试 `reconcileDesktopProfile()`：初始化缺失 profile，修复本项目拥有的 bundle 前缀，并保留第三方 bundle。
- 以本项目为唯一 source of truth 实现 Desktop 插件、Electron 自举和通用 shell 机制，不引入其他产品的领域行为或运行时依赖。
- 仍使用 Electron `userData/m0-dsh-home` 隔离 home，跑通 `smoke:dsh-ui` 与 `smoke:host-crash`；不读写 `~/.dsh`。

验收：新建与已有 `desktop` profile 都通过 Electron-independent `profile-manager` 的 reconcile 测试；独立 Host 子进程加载 `desktop-plugin`，插件经窄化且 publisher-neutral 的 `desktopSurface` 控制契约调度官方 DSH UI；终止 Host 不会同时终止 Electron 壳。

完成证据：63 项单元测试、7 项依赖边界测试、6 项真实 DSH 集成测试，以及官方 UI 与 Host crash 两条 Electron smoke 全部通过；Standards 与 Spec 审查阻塞已关闭。详细记录见 [M0 实施计划](superpowers/plans/2026-09-01-m0-independent-minimal-loop.md#验收记录2026-09-02)。M0 未包含 home lease、Safe Mode、安装包或发布能力。

### M1：共享 home 与单 Host（已完成源码级验收，见 [M1 验收记录](validation/m1-acceptance.md)）

执行文档：[M1 Implementation Plan](superpowers/plans/2026-09-02-m1-shared-home-single-host.md)。

- 实现独立的长生命周期 home lease，使用原子 `mkdir` 取得所有权，并用 `writeFileAtomic` 写 owner 元数据。
- owner 元数据记录 supervisor 与 Host 子进程身份，Desktop 内部 Host 重启不释放 lease。
- 实现 `dsh-native` CLI 启动器。
- 实现 `dsh-native doctor --unlock` 和 Desktop 可操作的 lease 失败提示。
- 默认绑定 `~/.dsh`，使用专属 profile/settings namespace。
- 完成前四项共享 home 集成测试。

验收：数据可顺序互通，受支持入口不能并发 boot。

### M2：非破坏性恢复（已完成源码级验收，见 [M2 验收记录](validation/m2-acceptance.md)）

执行文档：[M2 Implementation Plan](superpowers/plans/2026-09-02-m2-nondestructive-recovery.md)。

- 在 M0 现有 reconcile 上增加逐文件白名单、持久修订事务与 SHA 校验；当前仓库没有五件套 checkpoint 需要迁移。
- 按失败阶段分类，不回滚 home 数据。
- 把 projection cache 隔离放到 lease 之后。
- 增加不依赖 Host 的最小恢复面，展示结构化失败阶段、重试、退出和安全解锁指引。
- 交付独立 `desktop-safe-mode` profile 与最小 `desktop-recovery-bridge`，不实现插件市场或 generation ledger。

验收：模拟所有启动失败时，`settings.yaml`、home patch、会话和 storages 均不会被旧快照覆盖；Host 失败不退出 Electron 壳，恢复面可以安全重试。

### M3：打包与完整冒烟（已完成制品级验收，见 [M3 验收记录](validation/m3-acceptance.md)）

执行文档：[M3 Implementation Plan](superpowers/plans/2026-09-02-m3-packaged-desktop.md)。

- 补齐托盘、Dock、菜单、关窗隐藏、窗口状态和受控外链行为。
- 补 electron-builder 配置和素材。
- 打包完整 Host 运行时、配套 CLI Node/pnpm 与 lease helper；先植入最小 home 兼容性拒绝门，为 M4 保留可验证的旧候选制品。
- 对打包产物执行 lifecycle/host-crash/auth/navigation/conversation 冒烟。
- 生成 DMG 和校验清单。

验收：全新本机目录安装后可独立启动、退出和再次恢复会话。

### M4：版本闭包与升级演练

执行文档：[M4 Implementation Plan](superpowers/plans/2026-09-02-m4-release-compatibility.md)。

- 生成并校验 Desktop、DSH、profile/plugin API 与持久化格式的兼容性清单。
- 若实现期间出现新的上游 tag，则在独立候选分支演练升级；没有新 tag 时不制造无意义的版本跳转。
- 使用复制的数据 fixture 验证升级后重启，以及不兼容时拒绝降级。
- 对账所有本地补丁和 fork 制品，重跑全部测试并保留上一版 DMG。

验收：发行制品可追溯到单一 DSH 基线，升级差异不混入壳结构重构；旧 DMG 只在兼容性清单允许时打开升级后的 home。

原方案的阶段天数是粗略估计，不作为执行承诺。按 M1 → M2 → M3 → M4 的验收门槛推进；获得可运行版本不等于通过进程监督、共享 home、恢复安全和版本闭包验收的日用版本。

## 11. v1 完成定义

只有同时满足以下条件，v1 才算完成：

- 默认 home 为 `~/.dsh`，`desktop` profile 不覆盖其他 profile。
- Desktop 以声明 `dsh.bundle.patch` 的独立插件存在，Electron launcher 中不重复实现 DSH 集成逻辑。
- DSH Host 在独立子进程运行；Electron Main 与 renderer 不加载 Host 或第三方插件代码，Host 崩溃时壳仍可恢复。
- 缺少 `desktopSurface` 时插件可读降级，普通 DSH 组合仍能继续启动。
- Host 与 launcher 之间不存在通用 `desktopRuntime`；v1 只暴露经 schema、capability 和 generation 校验的窄 surface 控制能力。
- `profile-manager` 独立于 Electron，`shell-core` 不直接拥有 profile 状态或 generation 权威。
- `desktop-contracts` 按能力分入口和版本；Host-process capability 不被当作插件身份。
- 桌面端和配套 CLI 的会话能够双向、顺序继续。
- 受支持入口遵守同 home 单 Host 规则。
- 任意桌面启动失败都不会自动覆盖 home 级设置、patch、会话或 storage。
- 全部单元、共享 home 集成和打包产物冒烟通过。
- DSH 基线、fork 制品、本地补丁和兼容性清单可复现。
- 上一版 DMG 保留为二进制回退候选；不承诺它能读取新格式数据。
- README 明确记录并发限制、受支持 CLI 入口和手动升级流程。

## 12. v1 后扩展路线

后续功能仍由真实需求触发，但实现顺序受安全和兼容性依赖约束。

### E1：单 Host 多客户端基础

- 为长期 Host 定义本地 attach/discovery 协议和进程所有权。
- 让配套 CLI 作为客户端连接 Desktop Host，逐步替代整份 home 排他互斥。
- 保留 home lease 作为 Host 所有权锁，而不是每个客户端的使用锁。
- 优先复用上游 typed Remote、事件流、SDK 或 ACP 中适合的正式能力。

### E2：升级基础设施

- 增加 Developer ID 签名、hardened runtime、notarization 和可信发布通道。
- 发布机器可读兼容性清单，建立升级前备份、迁移预检和禁止不安全降级规则。
- launcher 提供 Host 无法启动时仍可用的最小更新状态机，`desktop-updater` 提供正常应用内 UI、兼容性解释与 channel 策略。
- launcher 持久化通过校验的 last-effective policy，并内置不可由 Host 替换的签名信任根与 emergency stable source。
- 先实现手动检查、下载确认和安装确认，再评估后台下载；不默认退出时自动安装。
- 支持跳过单个版本，后续新版本仍应提示；系统长时间休眠恢复后按节流策略重新检查。
- 更新请求默认不发送持久 installation id；需要灰度时另行评估最小标识。

### E3：受信插件市场

- 先发布只读 catalog 和兼容性检查，再开放安装。
- 建立 `MarketProvider`、`PluginPackageManager` 与 `PluginTrustPolicy` 三个独立边界。
- 开放安装前先交付由 `dsh-base`、`dsh-web-app`、`desktop-recovery-bridge` 组成的 `desktop-safe-mode`，以及可追溯的故障归因/定点禁用流程。
- 安装使用 staging、精确版本、校验和、发行者信息、不可变 generation、事务记录和失败回滚。
- 每个 `ProfileRef` 维护 `desired`、`active`、`lastKnownGood`；停止 Host 后才切换，至少保留上一组健康 generation。
- generation 事务 journal 使用 `staging`、`verified`、`prepared`、`activating`、`health-checking`、`committed`、`rolled-back` 状态，并能在任一 launcher 崩溃点幂等恢复。
- 受管 profile 的外部修改作为 drift 处理，只能显式导入为新 generation 或恢复 active 投影。
- 使用兼容性清单验证 Host singleton 和 peer resolution，不能让插件私带第二份 React、Cordis 或不兼容的 `@deepseek-ai/*` runtime。
- 解决第三方 client bundle 的公开构建契约，不能要求开发者复制仓库私有 preset。
- 把可执行插件与 preset/配置包定义为不同制品类型，后者采用预览、冲突处理和原子导入，不继承代码安装授权。
- 首版只允许受信来源；更开放的市场必须另行设计代码隔离和供应链响应。

### E4：配对式远程访问

- 先在固定 DSH 基线上验证 principal 传播、逐方法 scope 强制、审计和撤销扩展点；验证失败时不进入远程实现。
- 第一阶段只做显式启用的 LAN/可信网络访问，第二阶段才评估互联网 relay。
- Harness 始终只绑定 loopback；独立 bridge 暴露受限 surface，公网 tunnel/relay 只能指向 bridge。
- 每台设备单独配对、授权和撤销，Host 记录 principal、scope 与审计事件。
- 按能力区分只读、会话控制、任务提交和管理操作；默认拒绝远程安装、凭据写入和升级。
- 所有远程请求在 Host 端授权，不能复用本地 browser session 作为设备身份，也不能依据远端 IP 自动恢复授权。
- remote client 复用正式 typed Remote、事件流和版本协商，避免维护一套手写 Host RPC 名称转译表。

### E5：其他产品化能力

- 按需要加入 setup wizard、桌面终端和多 profile UI。
- 所有 profile 相关 API 继续接收 `ProfileRef`，`desktop` 只是默认选择。
- 向上游贡献可复用的 session ownership、storage revision、客户端 attach 和插件构建能力。
