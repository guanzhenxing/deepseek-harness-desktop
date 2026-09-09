# ADR-0006：以逐文件修订事务实现 profile 非破坏性恢复

- 日期：2026-09-02
- 状态：已接受

## 1. 问题

reconcile 会创建/修改 `profiles/desktop` 下最多三个文件（`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`）。当启动在 profile 写入之后失败时，桌面必须能安全地把本次自动变更恢复到写入前的状态，且绝不覆盖用户数据：

- 只回滚"本次启动自己写的字节"，用户在两次启动之间的手工修改必须原样保留；
- 不可归因于 profile 的失败（lease、端口、home patch、凭据、打包运行时、原生 UI、未知）一律不回滚；
- 崩溃可能发生在任意两个写步骤之间，恢复必须凭磁盘事实而不是内存标志判断进行到哪一步。

## 2. 决策

`profile-manager` 唯一拥有该机制，形态为**逐文件修订事务**：

1. reconcile 先计算纯写入计划（`planDesktopReconcile`），对每个将变更的白名单文件记录写入前存在性、字节与 SHA-256；
2. 持久化 journal（`<home>/run/profile-transactions/<id>/`）先于任何替换落盘，快照仅含三个白名单文件的相对路径；
3. 应用变更逐文件推进并持久化进度；断电恢复对照实际 SHA 与 before/candidate 判定每个文件所处状态，幂等续作；
4. rollback 前验证所有受影响文件只处于 before 或 candidate 两种内容，出现第三种内容即 `conflict`，停止而不覆盖；
5. `committed` 只在 Host ready 且窗口稳定后写入；明确不可回滚的失败以 `retained` 终态记录，防止下次启动偷偷回滚；
6. 自动回滚资格由 `shell-core` 的 `shouldRollbackProfile` 判定：未 healthy + 本次确有修改 + 失败归因为 profile-write/profile-composition 三者缺一不可。

与插件市场 generation ledger 的边界：generation 记录插件安装代际与定点禁用，服务插件市场；修订事务只服务"启动自愈不破坏用户数据"。两者都由 profile-manager 拥有，但 schema、生命周期与触发条件互不依赖，其 ADR 定案前不创建 generation 存储。

## 3. 结果与代价

- 代价：每次启动多一轮 journal 写入与目录（保留策略清理终态）；三个文件的最坏情况需要两倍磁盘（before 快照）。
- 备选否决：整目录快照/恢复覆盖面过大，会把用户的手工修改一并回滚；"重写模板初始化"会在用户已有 patch/workspace 时直接毁数据；把事务放 shell-core 会让 profile 状态出现第二权威（违反 ADR-0003）。

## 4. renderer 失败的默认归因

BrowserWindow 加载失败默认**不能**证明 profile 有错（渲染进程崩溃可能是 GPU、网络中断、系统资源等），因此 renderer 类失败不获得自动回滚资格，只进入恢复窗口供用户显式选择重试或 Safe Mode。
