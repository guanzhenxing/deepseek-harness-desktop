# ADR-0008：持 lease 隔离超大 projection cache

- 日期：2026-09-03
- 状态：已接受

## 1. 问题

DSH Host 的 session projection cache（`storages/session_projcache/sessions/`，逐 session 文件）是可重建的派生数据，但在长期使用中可能增长到影响启动或磁盘的程度。Desktop 需要在不破坏任何会话权威数据的前提下处置它：

- cache 是派生缓存而非权威数据，重建即恢复；
- 但它位于 `<home>/storages/**`，Desktop 对该目录没有一般写权（data-layout：仅活跃 Host 写入）；
- 布局可能随上游版本变化，未知布局绝不能移动。

## 2. 决策

`shell-core` 在**持有整 home lease 且无 Host 运行**时检查该缓存；超过阈值（默认 512 MiB）时：

1. 只识别**固定基线布局**（storage root 下恰好一个 `sessions` 目录，各级路径均为真实目录而非 symlink）；任何额外 sibling、symlink 分量或扫描与 rename 之间的 inode 漂移都返回 `unknown-layout`——不移动、只输出结构化诊断行；
2. 移动方式是**同文件系统 rename** 至 `storages/session_projcache.quarantine-<id>`，绝不复制后删除，`EXDEV` 不降级；
3. rename 前后写意图 journal（`<home>/run/projection-cache-quarantine.json`，`schemaVersion: 1`，只含相对路径与字节数），崩溃后凭 journal 判断 rename 是否已发生、永不二次移动备份；move 落定后 journal 自清理；
4. 备份**保留不自动删除**，由用户或后续 doctor 语义处置。

## 3. 结果与代价

- 代价：隔离窗口内多一次目录遍历（计算大小）与两次 journal fsync；未知布局永远不处置（保守）。
- 备选否决：删除而非备份会破坏"可重建但先保留证据"的调试诉求；复制后删除放大磁盘峰值且引入部分复制状态；在 Host 运行时移动会与活跃写竞争。
- 边界：该机制只拥有 `storages/session_projcache*` 这一组固定路径，不是对 `storages/**` 的一般写权；未知格式 journal 与越界 `backupRelative` 视为无 journal，绝不解析执行。
