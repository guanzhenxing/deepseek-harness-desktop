# Home Lease 协议

- 状态：M1 实现中（`packages/home-lease`）
- 决策记录：[ADR-0005](../adr/0005-home-lease-process-identity.md)
- 数据布局：[数据布局 §3](../data-layout.md)

## 1. 目标

Desktop 与 `dsh-native` 在共享 DSH home 上顺序互斥：任何 Host boot、profile 写入、缓存清理之前，调用方必须先取得整 home lease。不同 profile 不构成并发例外。

## 2. 磁盘布局

```text
<home>/run/                 0700 目录
├── host-lease.guard        0600 永久 owner-only advisory lock 文件
└── host.lock/              0700 目录，原子 mkdir 获取
    └── owner.json          0600 closed-schema owner 记录
```

`owner.json` 字段（schemaVersion 固定 1）：

| 字段                       | 含义                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `generation`               | 本轮 lease 的随机标识；旧 handle 的 generation 不匹配时拒绝操作 |
| `supervisor`               | 持有者（launcher/CLI 包装进程）的 `{pid, startIdentity}`        |
| `host`                     | 受监督 Host 子进程身份；未登记时为 `null`                       |
| `pendingSpawn`             | 已持久化"即将创建 Host"但尚未登记身份时为 `true`                |
| `entrypoint`               | `desktop` 或 `bundled-cli`                                      |
| `profile`                  | 已解析的目标 profile 名                                         |
| `createdAt` / `appVersion` | 诊断信息                                                        |

owner 文件不含凭据、capability、authenticated URL 或完整命令行。

## 3. 进程身份与原生 helper

`ProcessIdentity = { pid, startIdentity }`。`startIdentity` 是 macOS `proc_pidinfo` 记录的进程启动秒/微秒（内核在 fork 时一次性写入、此后不可变）。它曾是"启动时间 + 系统 boottime"的复合串；boottime 分量在 2026-09-06 被实测移除——`KERN_BOOTTIME` 是"当前墙钟 − 开机时长"的推导值，NTP 对时会使其在进程存续期间整体平移（实测同一 pid 记录 boot `…451.434515` vs 自身 boot `…451.538858`），把健康的会话在释放时误判为 `different` 并留锁。pid 固定时启动时间本身已唯一（pid 复用不可能复现同一微秒级启动时间），boottime 对判别无贡献；旧格式遗留锁会被判 stale，由 doctor 清理。它是操作系统进程身份，不是 M0 私有握手 nonce。

`packages/home-lease/native/lease-helper.c`（`pnpm build:native` 编译到被忽略的 `.build/` 目录）：

- `identity <pid>` / `probe <pid> <start>` / `scan <excludes> <entries>`（可执行文件匹配）/ `scanargv <excludes> <needles>`（argv 针脚内存匹配，`` 分隔，绝不输出 argv）/ `lock <guard> <parentDir> <dev> <ino> <retryMs>`；
- guard 打开使用 `openat(父目录 fd, …, O_NOFOLLOW)`——父目录先以 fd 钉住并用 `fstat` 校验 dev/ino，杜绝"先检查再按路径打开"的置换窗口；已存在 guard 先以纯 `O_NOFOLLOW` 打开、不存在才 `O_CREAT|O_EXCL` 独占创建（macOS 对 O_CREAT|O_NOFOLLOW 命中并发新文件会误报 ENOENT）；`flock(LOCK_EX|LOCK_NB)`，持锁 helper 在 stdin 关闭或收到 `release` 后退出；锁失败错误带细分（`refused-parent`/`refused-openat`）与 errno；
- 权限不足一律返回 `unknown` 状态；只输出结构化 JSON 行，不输出 argv/env；
- 非 macOS 平台报告 unsupported；这些平台只允许注入 probe 的单测。

## 4. 状态机

```text
acquire:   mkdir(host.lock) ──EEXIST→ 读 owner ── same → HOME_BUSY
                                        ├─ unknown → LEASE_UNKNOWN
                                        └─ absent/different → HOME_STALE（不自动回收）
           成功 → 写 owner（host=null, pendingSpawn=false）

beforeSpawn(profile): 校验 generation/身份/profile 一致 → pendingSpawn=true
attachHost(identity): 要求 pendingSpawn → host=identity, pendingSpawn=false
confirmHostExited():  host=null, pendingSpawn=false（幂等）
assertHeld():         重读 owner，generation 与 supervisor 身份必须仍是本进程

release:   generation 不匹配 → LEASE_CHANGED
           host 身份 same → HOST_ACTIVE；unknown → LEASE_UNKNOWN
           pendingSpawn → PENDING_SPAWN
           全部通过 → 删除 owner.json 并 rmdir(host.lock)；重复 release 幂等
```

所有 owner 读改写都发生在 guard 短临界区内，方法之间按进程内串行队列执行。`HOME_BUSY`/`HOME_STALE`/`LEASE_UNKNOWN` 的错误对象携带脱敏 ownerSummary（entrypoint、profile、PID、时间），供对话框与 stderr 使用。

## 5. `dsh-native` 包装进程与调用方义务

`dsh-native` 是唯一遵守本协议的受支持 CLI 入口；裸 `dsh` 不受本项目拦截，使用前必须完全退出受支持入口。

launcher/CLI 在 lease 获取成功前不得写 home；启动失败也必须先 stop/确认 Host 退出再释放 lease，不在 `finally` 无条件清锁；无法证明 Host 已死时保留 lease 并报告。

包装进程行为：

1. 只拦截精确的 `doctor --unlock`，其余 argv 原样转发给固定版官方 `@deepseek-ai/dsh` 入口（按 package `bin.dsh` 解析，不依赖内部 hash 文件名）；
2. 按上游语义解析目标 profile（根命令 `--profile` 必填、`web` 是别名、`plugin` 必须带 `--profile`），owner 记录已解析的 profile；解析不出 profile 的调用只可能是上游的帮助/版本/报错路径，不取 lease 直接转发；
3. 取得整 home lease（supervisor = 包装进程）→ `beforeSpawn` → fork 等待授权的子进程 → 在 lease 上登记子进程 OS 身份（`attachHost`）→ 才发送 boot 授权（子进程随即设置 `process.argv` 并 import 官方 bin）；
4. 交互 stdio 直通，SIGINT/SIGTERM/SIGHUP 转发，子进程退出码透传（信号按 128+signo 映射）；
5. 子进程在独立进程组中运行（detached fork）；直接子进程退出后，包装进程等待**整个进程组**（含写 home 后代）消失，超时按 TERM→KILL 对组升级；无法证明组消亡时保留 lease、退出码 4，`confirmHostExited` 仅在组可证明消亡后调用；

退出码：`0` 成功/unlocked/already-unlocked；官方 CLI 自身退出码透传；`2` doctor 拒绝（ACTIVE_OWNER / IDENTITY_UNKNOWN / LEASE_CHANGED）；`3` lease 获取被拒（HOME_BUSY / HOME_STALE / LEASE_UNKNOWN 等，stderr 给出 owner 摘要与 doctor 指引，不打印完整 home 路径）；`4` 未授权 CLI child 在 TERM→KILL 升级后仍无法证明退出，lease 保留给 doctor。

## 6. doctor（`doctor --unlock`）

doctor 在同一 guard 短临界区内完成"重读 owner → 探测身份 → 扫描受支持入口 → 删除"：

- owner 可读且 supervisor/Host 身份仍 `same` → ACTIVE_OWNER 拒绝；
- 任一身份 `unknown`，或 `pendingSpawn` 未确认 → IDENTITY_UNKNOWN 拒绝（可能存在从未收到 boot 授权的子进程）；
- owner 缺失/损坏 → 先 `scanSupported` 扫描受支持入口：可执行文件匹配（Electron 二进制）+ argv 针脚匹配（`dsh-native` 包装脚本、授权式 CLI child 模块、Electron Host 入口、官方 `dsh` bin——裸 `dsh` 也会被保守拒绝）；排除 doctor 自身与只读 helper，任一扫描无法判定即返回 unknown（fail closed）；argv 只在 helper 内存中匹配，绝不输出；
- 只有所有身份 `absent/different` 且无未确认 writer 才删除 owner 与 `host.lock/`；
- 删除前复核 lock 目录 dev/ino；`ENOTEMPTY` 视为 IDENTITY_UNKNOWN；
- `--unlock` 本身就是用户明确的清理请求，不提供 `--force` 绕过。
