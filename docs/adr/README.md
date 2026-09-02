# Architecture Decision Records

ADR 记录本项目难以无成本撤销、会约束后续实现的架构决策。当前实现必须遵守状态为“已接受”的 ADR；如果新决策替代旧决策，应新增 ADR，并把旧记录标记为“已取代”及链接替代者，而不是重写历史理由。

## 索引

| ADR                                                                                                      | 状态   | 范围                                                        |
| -------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| [ADR-0001：自建独立的 DSH Desktop 插件与 Electron launcher](0001-build-own-native-dsh-shell.md)          | 已接受 | 产品形态、进程边界、共享 home 与长期扩展方向                |
| [ADR-0002：使用最小第一方 recovery bridge 发布 Safe Mode surface](0002-use-a-minimal-recovery-bridge.md) | 已接受 | 解决 Safe Mode 不加载正常 Desktop 插件时的 surface handoff  |
| [ADR-0003：以独立 profile-manager 统一拥有 profile 状态](0003-separate-profile-manager.md)               | 已接受 | profile reconcile、恢复、Safe Mode 与 generation 的唯一权威 |
| [ADR-0004：按原生能力独立定义和版本化跨进程契约](0004-version-native-capabilities-independently.md)      | 已接受 | capability subpath、协议演进和敏感操作确认                  |

## 状态

- 拟议：正在讨论，不能作为实现依据；
- 已接受：当前实现必须遵守；
- 已取代：历史决定仍保留，由另一个 ADR 替代；
- 已拒绝：经过评估但未采用。

## 何时建立 ADR

以下变化必须新建 ADR：

- 进程、信任或权限边界；
- 状态唯一权威或持久化 schema；
- 新 privileged native capability；
- 公共协议 major version；
- market provider、remote relay、设备凭据格式或 updater channel；
- 不可逆数据迁移、公开分发或许可证策略。

内部重构、局部实现和 bug 修复如果不改变这些边界，记录在对应 issue/spec 和测试中即可。

## 格式

每份 ADR 包含日期、状态、问题、决策、结果与代价，以及实际评估过的备选。ADR 只固定决策，不复制完整实施里程碑；实施范围见[纯 DSH 桌面壳实施方案](../native-dsh-desktop-plan.md)。
