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

`ProcessIdentity = { pid, startIdentity }`。`startIdentity` 由 macOS `proc_pidinfo` 启动秒/微秒加上系统 boottime 组成，跨重启唯一；它是操作系统进程身份，不是 M0 私有握手 nonce。

`packages/home-lease/native/lease-helper.c`（`pnpm build:native` 编译到被忽略的 `.build/` 目录）：

- `identity <pid>` / `probe <pid> <start>` / `scan <excludes> <entries>` / `lock <guard> <parentDir> <dev> <ino> <retryMs>`；
- guard 打开使用 `O_NOFOLLOW`，`flock(LOCK_EX|LOCK_NB)`，持锁 helper 在 stdin 关闭或收到 `release` 后退出；
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

## 5. 调用方义务

- launcher/CLI 在 lease 获取成功前不得写 home；启动失败也必须先 stop/确认 Host 退出再释放 lease，不在 `finally` 无条件清锁；
- 无法证明 Host 已死时保留 lease 并报告；
- doctor（`dsh-native doctor --unlock`，M1 Task 4）在 guard 内重读 owner 后按同样的身份规则清理；`--unlock` 本身就是用户明确的清理请求，不提供 `--force`；
- 其他裸 `dsh` CLI 不经过本协议，本项目不拦截；使用前必须完全退出受支持入口。
