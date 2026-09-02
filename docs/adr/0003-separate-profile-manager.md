# ADR-0003：以独立 profile-manager 统一拥有 profile 状态

- 日期：2026-09-01
- 状态：已接受
- 决策人：Jesen（guanzhenxing）

## 1. 问题

初始方案把 `reconcileDesktopProfile()`、profile 快照与恢复放在 `shell-core`。`shell-core` 同时负责编排 Electron 生命周期、窗口、托盘、Host supervisor 和日志。

插件市场、多 profile、Safe Mode、升级预检和 bundled CLI 都会继续增加 profile 读取、验证和事务需求。如果这些状态仍由 Electron 编排包拥有，市场插件、launcher 和 CLI 容易形成多套互相竞争的 profile 权威。

## 2. 决策

建立不依赖 Electron 的 `packages/profile-manager`。它统一拥有：

- `ProfileRef` 的解析和校验；
- `reconcileDesktopProfile(ProfileRef)`；
- 白名单、修改前后 SHA-256 和修订校验恢复；
- Safe Mode profile 投影；
- E3 引入后的不可变 generation ledger；
- 持久化事务 journal、故障恢复、定点禁用和回滚；
- 受管 profile 的 drift 检测与显式导入/修复。

调用方必须先取得目标 DSH home 的写入 authority。共享/用户 home 使用 home lease；M0 的 launcher 私有 `<userData>/m0-dsh-home` 使用显式隔离 authority。profile-manager 自己不创建第二套锁语义，也不启动或停止 Host。

`shell-core` 只编排 `home-lease`、`profile-manager`、`host-supervisor` 与 Electron 资源。`desktop-plugin`、市场 UI 和 launcher 都不能直接把 profile 文件当作第二权威来源。

M0 只实现 `ProfileRef`、reconcile 和所需的修订快照边界。generation ledger、Safe Mode 投影和事务 journal 在相应路线进入实施时添加，但必须留在同一包和同一数据权威内。

## 3. Generation 事务约束

未来事务 journal 使用以下持久化状态：

```text
staging
→ verified
→ prepared
→ activating
→ health-checking
→ committed | rolled-back
```

`desired`、`active` 和 `lastKnownGood` 是 generation 引用，不是事务 journal。每次状态转移先原子记录意图和前后 generation，再执行外部副作用。launcher 重启后，profile-manager 根据 journal、当前投影和健康记录幂等继续或回退。

某个 `ProfileRef` 进入 generation 管理后，外部 `dsh plugin` 或手工文件修改产生的差异一律标记为 drift。用户只能明确选择导入为新 generation，或者恢复当前 active 投影；系统不得静默覆盖或把未知组合标记为 healthy。

## 4. 结果与代价

正面结果：

- Electron 生命周期和 profile 数据规则不再耦合；
- launcher、bundled CLI、Safe Mode 和市场共用相同写入规则；
- generation ledger 与物化 profile 不会形成多个实现；
- profile-manager 可以独立执行单元、故障注入和 fixture 测试。

需要承担：

- M0 多一个 workspace package 和明确接口；
- 调用方必须证明所需 authority 已持有（M0 为专属 userData 子目录；共享 home 为 lease），并处理 profile-manager 的结构化错误；
- 后期市场不能绕开 profile-manager 直接调用 pnpm 修改活跃 profile。

## 5. 被否决的备选

| 备选                                    | 未选择原因                                                |
| --------------------------------------- | --------------------------------------------------------- |
| profile 逻辑继续留在 `shell-core`       | Electron 编排包会随市场、Safe Mode 和多 profile 快速膨胀  |
| 市场插件直接拥有 profile 文件           | Host 失败时市场插件不可用，无法完成 boot-independent 恢复 |
| launcher 和 CLI 各实现一套 profile 管理 | 会产生不同的排序、恢复和 generation 语义                  |
