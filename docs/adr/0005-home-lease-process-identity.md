# ADR-0005：以进程启动身份与短临界区 guard 实现整 home lease

- 日期：2026-09-02
- 状态：已接受

## 1. 问题

Desktop 与 `dsh-native` 顺序共享同一 DSH home。任何 Host boot 或 profile 写入之前，必须证明整 home 的排他所有权，并且：

- 不同 profile 不构成并发例外；
- owner 记录只能由一个写入者产生，`kill(pid, 0)` 成功不能当作身份相同（PID 复用）；
- 重启后 doctor 能判断"记录的 owner 是否还是当时的进程"；
- 两个 doctor 不会竞态删除新 acquisition 的锁；
- 不引入 DSH Host 到 Electron Main，不依赖 DSH 的启动图。

## 2. 决策

新增 Electron-free 的 `packages/home-lease`，所有受支持的 launcher/CLI 包装进程在触碰 home 前持有它：

1. **获取**：`<home>/run/host.lock/` 目录用原子 `mkdir` 获取；成功者写入 closed-schema 的 `owner.json`（generation、supervisor/Host 的操作系统进程身份、entrypoint、profile、pendingSpawn、时间与版本）。
2. **身份**：操作系统级身份 = PID + 纯进程启动时间（macOS `proc_pidinfo` 的启动秒/微秒），由小型原生 C helper 提供。启动时间在内核 fork 时一次性写入、此后不可变；pid 复用无法复现同一微秒级启动时间，因此 pid 固定时启动时间已唯一，不混入 `KERN_BOOTTIME` 之类的墙钟推导值（boottime 会随 NTP 对时在进程存续期间漂移，导致健康会话被误判 `different` 而留锁）。它与 Host-control 私有握手用的随机 `startIdentity` nonce 是两回事，二者分开存储、互不替代。**旧格式兼容**：`probe` 对历史 `<boot>-<start>` 身份串取启动时间后缀比较——升级共存窗口内旧版本的**活**持有者判 `same`（doctor 绝不删除活锁，保住单写者），已退出者照常判 `absent`/`different`。
3. **短临界区**：新增永久 owner-only 文件 `<home>/run/host-lease.guard`。获取、owner 更新、释放与 doctor 清理都在 helper 持有的 `flock(LOCK_EX|LOCK_NB)` 短临界区内执行。guard 不代表长 lease、不按年龄删除；helper 退出由 OS 释放内核锁，避免两个 doctor 删除新 generation 的竞态。
4. **Host 登记**：子进程先等待私有 bootstrap；owner 先持久化 `pendingSpawn`，随后写入子进程 OS 身份并清除标记，之后才发出 boot 授权。
5. **释放**：确认所有 Host 子进程退出后才移除自己持有的 lock；owner 未知、Host 活跃或身份无法证明时拒绝释放。正常 acquire 遇已有 owner 只报 busy/stale/unknown，不自动回收旧锁；清理走显式 `dsh-native doctor --unlock`。lease 把守准入而非 Host 运行期的数据写——锁被第三方删除时 Host 不会自行察觉。supervisor 与 bundled CLI 以 watchdog 周期性 `assertHeld()`（guard 竞争不计、连续两次失败处决 Host/子进程），把“锁被删后仍双写”的窗口压缩到至多一个监视周期。watchdog 只是兜底——单写者保证的主承载是**锁目录布局 v2**（`host.lock/.dsh-writer-sentinel` 哨兵）：一切版本的 doctor/release 对非空锁目录 `rmdir` 均拒绝，冻结旧制品的 doctor 即便误读新身份格式也删不掉 v2 活锁目录（最多删 owner 文件），双写在协议层被阻止。
6. **写入持久化**：owner 文件用上游 `writeFileAtomic` 原子替换，并在其后补 owner 文件与父目录 fsync（上游函数不承诺 crash durability）。

helper 以结构化 JSON 行输出身份/状态，绝不输出其他进程的 argv/env。权限不足返回 `unknown`，调用方一律 fail closed。helper 由 Xcode Command Line Tools 编译，产物放忽略目录，随应用打包；Linux 等平台只有注入 probe 的单测，不宣称支持其 runtime。

## 3. 结果与代价

- 同一 home 在任一时刻最多一个受支持 writer；崩溃后锁残留以 stale/unknown 呈现，交给 doctor 而不是猜测回收。
- 代价：新增一个 ~300 行的原生 helper 及其构建步骤（`pnpm build:native`）；每次 lease 操作有两次短 helper 进程往返。
- 备选方案及否决理由：
  - **只用 `mkdir` 锁 + 时间戳年龄清理**：时间不能证明进程死亡，双 doctor 竞态无法避免；
  - **在 Node 内直接 `flock`**：Node 无标准 flock 绑定，引入第三方原生依赖比自维护 300 行 helper 更重；
  - **用私有握手随机 nonce 当身份**：重启后 nonce 与进程无对应关系，doctor 无法判定；
  - **把锁语义放进 DSH Host**：违反"Main 不加载 DSH boot graph"边界，CLI 无法在 Host 外持有。
