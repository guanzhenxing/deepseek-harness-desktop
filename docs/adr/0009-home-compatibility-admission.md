# ADR-0009：以只读 home compatibility marker 实现最小准入

- 日期：2026-09-03
- 状态：已接受

## 1. 问题

发行以可安装候选包为单位演进。旧版本应用打开新版本写入过的 home，可能把无法读取的数据当成可写数据破坏掉。需要一条在**任何写入发生之前**就能拒绝不安全进入的准入线，同时不谎称已经具备完整格式兼容性知识。

## 2. 决策

`packages/release-compatibility` 提供固定于 `<home>/run/compatibility.json` 的只读 marker（schema 1）与 fail-closed 判定：

1. marker 缺失允许进入（现存 home 早于本机制）；
2. 未知 schema、损坏内容、symlink、不可读、`dataEpoch` 不受支持，一律拒绝且不产生任何写入；
3. Desktop（含 Safe Mode，经 `RecoverySessionController` 在 lease 后、任何 profile/cache/Host 写入前）与 `dsh-native`（lease 后、spawn 前）都必须过闸；拒绝分别进入本地恢复页（非重试、撤下 Safe Mode）与 CLI 退出码 5；
4. 当前内嵌 `supportedDataEpochs = [1]`。

协议细节见 [home-compatibility 协议](../protocols/home-compatibility.md)。

## 3. 结果与代价

- 结果：旧发行制品自带拒绝门；新版本一旦写入更高 epoch，旧版本可安全拒绝而不是破坏数据。
- 代价：一次 marker 读取与校验进入每个会写会话的启动路径；marker 缺失时的兼容性完全依赖"marker 机制之前所有版本都写 epoch 1 数据"这一事实，无法由本机制证明。
- 备选否决：
  - 一步实现完整格式预检——需要上游格式证据，先落最小拒绝门；
  - 不做任何准入，靠人工记得不降级——与"保留旧 DMG 作为回退候选"的产品承诺矛盾；
  - 复用 home lease 携带版本信息——lease 是互斥协议，生命周期只在会话内，无法表达跨版本持久事实。

## 4. 诚实边界

- `dataEpoch` 是本项目的兼容性分组，**不冒充 DSH 官方 schema**；上游格式证据由发行清单携带。
- 该 marker 只约束"受支持入口之间"的协作：不阻止其他裸 CLI、旧无 guard 二进制或用户直接写入 home。
- 只读拒绝门先行；首个写入者与升级预检见 §5。

## 5. 实现补充（marker writer 与格式预检）

在"只读拒绝门"之上补齐的 writer 与预检实现细节记录如下（决策理由不变）：

- **固定链**：`parse marker → inspectHomeFormats（只读） → preflightHome（纯判定） → reserveHomeWrite`；Desktop/CLI/Safe Mode 共享该顺序，拒绝映射扩展为 `HOME_FORMAT_UNKNOWN` / `HOME_FORMAT_UNREADABLE` / `HOME_MIGRATION_REQUIRED`（仍为非重试、撤下 Safe Mode、CLI 退出码 5）。
- **格式勘察**：只解析已知文件头/布局（credentials version 头、session JSONL 首行、storage 单元信封、profile manifest），不加载任何 DSH/provider 代码；枚举有界；被植入的 symlink 计入未知。
- **写入预约**：仅在持 lease 时执行，fsync temp+rename+目录 fsync；预约在任何潜在新格式写入之前，预约后失败**不回滚 epoch**——这正是 §2 决策"拒绝不安全进入"在崩溃窗口上的延伸：宁可保守拒绝，不把半新数据当旧数据。
- **marker/磁盘一致性**：marker 记录的槽位与磁盘观察不一致时保守拒绝。槽位值使用稳定身份（storages 槽固定为信封 id，projcache 独立槽位），使同一 epoch 内的正常域增长不会触发误拒——这一粒度来自真实共享 home 集成测试（workspace 域在会话间从无到有）的教训。
- **MIGRATION_REQUIRED 是显式缺口**：本版本不迁移任何数据；引入迁移需要独立 ADR（停写、可验证备份、禁止自动降级）。
