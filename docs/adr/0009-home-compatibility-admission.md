# ADR-0009：以只读 home compatibility marker 实现最小准入

- 日期：2026-09-03
- 状态：已接受
- 决策人：Jesen（guanzhenxing）

## 1. 问题

M3 要产出可安装的候选包，M4 将在其上演练升级与降级。若旧候选打开新版本写入过的 home，可能把无法读取的数据当成可写数据破坏掉。需要一条在**任何写入发生之前**就能拒绝不安全进入的准入线，同时不谎称已经具备完整格式兼容性知识。

## 2. 决策

M3 起，`packages/release-compatibility` 提供固定于 `<home>/run/compatibility.json` 的只读 marker（schema 1）与 fail-closed 判定：

1. marker 缺失允许进入（现存 home 早于本机制）；
2. 未知 schema、损坏内容、symlink、不可读、`dataEpoch` 不受支持，一律拒绝且不产生任何写入；
3. Desktop（含 Safe Mode，经 `RecoverySessionController` 在 lease 后、任何 profile/cache/Host 写入前）与 `dsh-native`（lease 后、spawn 前）都必须过闸；拒绝分别进入本地恢复页（非重试、撤下 Safe Mode）与 CLI 退出码 5；
4. M3 内嵌 `supportedDataEpochs = [1]`。

协议细节见 [home-compatibility 协议](../protocols/home-compatibility.md)。

## 3. 结果与代价

- 结果：M4 的降级演练对象（M3 DMG）自带拒绝门；新版本一旦写入更高 epoch，旧候选包可安全拒绝而不是破坏数据。
- 代价：一次 marker 读取与校验进入每个会写会话的启动路径；marker 缺失时的兼容性完全依赖"M3 之前所有版本都写 epoch 1 数据"这一事实，无法由本机制证明。
- 备选否决：
  - 直接实现 M4 的完整格式预检——超出 M3 范围且需要上游格式证据，先落最小拒绝门；
  - 不做任何准入，靠人工记得不降级——与"保留旧 DMG 作为回退候选"的产品承诺矛盾；
  - 复用 home lease 携带版本信息——lease 是互斥协议，生命周期只在会话内，无法表达跨版本持久事实。

## 4. 诚实边界

- `dataEpoch` 是本项目的兼容性分组，**不冒充 DSH 官方 schema**；上游格式证据由 M4 清单补齐。
- 该 marker 只约束"受支持入口之间"的协作：不阻止其他裸 CLI、旧无 guard 二进制或用户直接写入 home。
- M3 不实现 marker writer：首个写入者与升级预检属于 M4。
