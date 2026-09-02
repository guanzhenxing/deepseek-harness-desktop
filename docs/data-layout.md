# 数据布局与所有权

- 状态：M0 已完成源码级验收
- 日期：2026-09-02
- 关联架构：[架构](architecture.md)

## 1. 路径变量

本文使用以下逻辑路径：

| 变量            | 解析规则                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `<home>`        | `resolveDesktopHome()`（`packages/home-lease`）：`$DSH_HOME` trim 后非空时生效（支持 `~` 展开，相对路径相对进程 cwd），否则为 `~/.dsh`；解析结果不得为 filesystem root。语义与固定版上游 `resolveDshHome` 在隔离进程中对照测试 |
| `<m0Home>`      | `<userData>/m0-dsh-home`；M0 launcher 单实例私有，不是共享 `<home>`                                                        |
| `<profile>`     | v1 为 `<home>/profiles/desktop`                                                                                            |
| `<safeProfile>` | M2 计划交付的恢复能力使用 `<home>/profiles/desktop-safe-mode`，同时作为 E3 前置                                         |
| `<userData>`    | Electron 设置产品身份后返回的 `app.getPath('userData')`；macOS 预期位于 Application Support 下的 DeepSeek Harness 专属目录 |
| `<launchRoot>`  | M0 为 `<m0Home>/profiles/.dsh-desktop-run-*` 临时目录；M1 起可迁移到 `<userData>/runtime/launch-root`                      |
| `<testHome>`    | 测试通过系统临时目录 API 单独创建的 DSH home，绝不能指向真实 `<home>`                                                      |

所有可写路径先解析为绝对路径并验证预期父目录。写入逻辑不得跟随用户可植入的目标 symlink 覆盖其他位置。

产品身份（产品名 `DeepSeek Harness Desktop`、CLI 名 `dsh-native`、设置 namespace `dsh-native-shell`、renderer partition、默认 profile 名）集中维护在 `packages/product-config`，该包不允许依赖 Electron 或任何 `@deepseek-ai/*` 包。

## 2. DSH home

| 路径                                 | 权威/所有者                  | Desktop 写入规则                                        | 备份与迁移                                       |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `<home>/.credentials.yaml`           | 用户/DSH credential provider | Desktop 不复制、不回滚内容                              | 由 DSH/用户负责；日志不得包含内容                |
| `<home>/settings.yaml`               | 用户与所有 profile           | 只由正式 DSH 设置能力修改；启动恢复不覆盖               | 格式迁移由对应 DSH provider 定义                 |
| `<home>/cordis.patch.yml`            | 用户                         | Desktop 启动恢复不修改                                  | 用户负责；错误只诊断                             |
| `<home>/sessions/**`                 | DSH session provider         | 仅活跃 Host 写入                                        | 升级测试使用副本，不能在真实数据上演练           |
| `<home>/storages/**`                 | DSH storage providers        | 仅活跃 Host 写入                                        | 迁移和降级范围进入兼容性清单                     |
| `<profile>/**`                       | `profile-manager` 与用户     | v1 只修改白名单文件并做修订校验                         | 修改前保存存在性、内容和 SHA-256                 |
| `<safeProfile>/**`                   | `profile-manager`            | 只创建 Safe Mode 自身投影，不自动修改正常 profile       | 可重建；不得包含第三方 bundle 或正常 patch layer |
| `<home>/run/host.lock/`              | `home-lease`                 | launcher 或 bundled CLI 在整个 Host writer 生命周期持有 | 不是数据备份；只可按 owner 身份受控恢复          |
| `<home>/run/profile-transactions/**` | future `profile-manager`     | M2 起持有 home lease 时原子写入                         | 用于崩溃恢复，终态经保留策略清理；M0 不创建      |

“Desktop 与 CLI 共享 home”表示它们在不同时间读写同一批数据，不表示两个 Host 可以并发写入。

## 3. Home lease

M0 的 `<m0Home>` 由 Electron 单实例独占，不与 CLI 或其他 DSH Host 共享，因此尚不创建 lease。以下布局从 M1 切换到共享 `<home>` 时生效；这不是对共享 home 规则的放宽。

正常启动不接受任意 userData 覆盖。只有 `ui`/`host-crash` smoke 可使用系统临时目录下通过 symlink/实际路径检查的专用目录。profile-manager 的隔离 authority 必须绑定调用方指定 userData 的 `m0-dsh-home` 子目录；该 authority 是受信调用方的写入前提，不是对同用户任意代码的安全沙箱。

lease 目录固定为：

```text
<home>/run/host.lock/
└── owner.json
```

`owner.json` 至少记录：

- schema version；
- lease generation；
- supervisor PID 与 start identity；
- Host PID 与 start identity；
- entrypoint、profile、创建时间与应用版本。

owner 文件不包含凭据、authenticated URL、控制通道 capability 或完整命令行。

lease 目录通过原子 `mkdir` 创建。任何清理都必须重新验证 generation、supervisor 和 Host 身份；不能按目录年龄自动解锁。身份不明时由 `dsh-native doctor --unlock` 在确认没有活跃 owner 后显式处理。

## 4. Profile 修改事务

M0 reconcile 只在私有 `<m0Home>` 中修改白名单文件，拒绝 home、profiles、profile 目录及三个受管文件的 symlink，原子替换 manifest，并返回修改前后 SHA-256 与 changed-files；它不承诺崩溃回滚，也不创建持久 transaction journal。

M2 引入恢复时，reconcile/recovery 事务放在：

```text
<home>/run/profile-transactions/<transaction-id>/
├── transaction.json
└── before/
    └── <whitelisted-profile-relative-path>
```

`transaction.json` 记录 schema、transaction id、`ProfileRef`、操作类型、状态、修改前存在性/摘要、候选摘要和应用版本。`before/` 只保存白名单 profile 文件，不复制 settings、home patch、sessions、storages 或 credentials。

写入顺序是：

1. 持有 home lease；
2. 验证 profile 路径和 symlink 约束；
3. 原子写 transaction 意图与 before snapshot；
4. 原子替换白名单文件；
5. Host、surface 和 BrowserWindow 通过稳定性窗口后标记 committed；
6. 失败时仅在当前摘要仍等于本次候选摘要时恢复 before；
7. committed/rolled-back 记录按有界保留策略清理。

E3 的 generation ledger 会继续由 `profile-manager` 拥有，但本项目在 E3 ADR 确定 schema、迁移和清理策略前不创建 generation 存储目录。transaction journal 与 generation ledger 的延后不改变 profile-manager 的唯一权威。

## 5. Electron userData

| 路径                                       | 所有者                             | 用途                                                          | 恢复规则                                          |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `<userData>/window-state.json`             | `shell-core`                       | 窗口位置、大小和最大化状态                                    | 可重建；离屏时回退默认值                          |
| `<userData>/logs/**`                       | launcher/Host 结构化日志           | 本地诊断                                                      | 有界轮换；必须脱敏                                |
| `<m0Home>/profiles/.dsh-desktop-run-*`     | Host runner                        | M0 中性启动根；包含 `cordis.yml` 与选中 bundle 的局部模块投影 | 关停前复核实际路径与目录身份；身份变化拒绝删除    |
| `<m0Home>/profiles/node_modules/**`        | Host runner / 上游 fallback helper | 安装依赖闭包的可重建投影，不是 named profile                  | 上游锁下维护，不修改 profile manifest 或 patch    |
| `<userData>/runtime/launch-root/**`        | future launcher                    | M1+ 中性 Host cwd 与非秘密 bootstrap 文件                     | Host 停止后可重建                                 |
| `<userData>/recovery/**`                   | launcher                           | crash-loop marker、最近失败阶段                               | 只恢复 launcher-owned 状态                        |
| `<userData>/updates/effective-policy.json` | future `desktopUpdater` adapter    | 校验后的 last-effective policy                                | E2 前不创建；损坏时退回 embedded emergency source |
| `<userData>/updates/cache/**`              | future updater                     | 已校验的下载制品                                              | E2 前不创建；可删除并重新下载                     |

Chromium 的 `persist:dsh-desktop-renderer` partition 也位于 Electron 管理的数据范围。清理 renderer cache 不得被描述为清理 DSH session 或 storage。

DSH credential、settings、sessions 和 storages 不复制到 `<userData>`。

## 6. 应用只读资源

打包应用内包含：

- Desktop 版本和 machine-readable compatibility manifest；
- DSH tag、commit、依赖闭包和 SHA-256 清单；
- 第一方 bundle 与 bundle patch；
- Host-control schema fixtures；
- E2 引入后的更新签名信任根和 emergency stable source。

运行时不能原地修改应用 bundle。更新通过新制品校验、停止 Host、替换应用和 relaunch 完成。

## 7. Secret storage

未来远程设备私钥放入 macOS Keychain 或等价系统 secure storage，不放入 DSH settings、profile、日志或普通 userData 文件。

`desktopSecureStore` 只暴露用途受限的生成、签名、解密、封装和删除操作。Host 和 renderer 不能取得原始私钥或长期主秘密。

## 8. 测试数据

所有涉及 profile、lease、恢复或迁移的自动化测试必须使用 `<testHome>`：

- 测试开始时由 `tests/helpers/isolated-home.ts` 的 `createIsolatedHomeFixture()` 在系统临时目录下创建；创建时拒绝环境 `DSH_HOME` 已设置、仓库目录、filesystem root 与真实 `~/.dsh`，清理前复核 realpath 与 dev/ino 身份；
- fixture 可以从脱敏数据复制，不能链接到真实 home；
- 失败时保留路径供诊断，清理命令只能针对已记录且验证过的临时目录；
- 打包冒烟使用独立临时 macOS userData。

## 9. 数据迁移原则

1. 每个持久化文件都有 schema version 或由其 DSH provider 明确拥有格式；
2. 写入使用临时文件、fsync/等价持久化和原子替换；
3. 不可逆迁移在 Host 停止后创建可验证备份；
4. compatibility manifest 不允许旧应用读取新格式时，launcher 明确禁止降级；
5. 删除只针对可重建数据或超过保留策略且未被引用的 generation；
6. 任何无法确定所有权或版本的数据保持不动并给出诊断。
