# Home Compatibility Marker 协议

- 状态：M3 已实现（最小只读 admission）
- 相关决策：[ADR-0009](../adr/0009-home-compatibility-admission.md)
- 适用入口：Desktop launcher（含 Safe Mode 会话）与 `dsh-native` CLI 的全部会写 home 的路径

## 1. 目标与非目标

本协议定义受支持入口在启动会写路径前的最小兼容性 admission：

- **M3 交付**：只读 marker reader + fail-closed admission。marker 缺失允许进入（现存 home 早于本机制）；未知 schema、损坏内容、不受支持的 dataEpoch 一律拒绝，且不产生任何 home 写入。
- **非目标（M4+）**：marker writer、完整格式证据清单、升级预检与降级演练。本协议为它们预留 schema 空间，但 M3 不实现。

## 2. Marker 布局与格式

路径固定为 `<home>/run/compatibility.json`：

```json
{
  "schemaVersion": 1,
  "dataEpoch": 1,
  "lastWriterReleaseId": "m3-candidate",
  "formats": { "session-jsonl": "1" }
}
```

| 字段                  | 类型                         | 语义                                                       |
| --------------------- | ---------------------------- | ---------------------------------------------------------- |
| `schemaVersion`       | `1`                          | marker 自身 schema；非 1 一律按未知处理                    |
| `dataEpoch`           | 安全整数                     | 本项目自定义的兼容性分组（见 §4）                          |
| `lastWriterReleaseId` | 非空字符串                   | 最后一个声明写入此 home 的发行版标识（诊断用，不构成信任） |
| `formats`             | 字符串到字符串的 map（可空） | M3 只读不解释；M4 记录上游持久化格式证据                   |

读取规则（实现：`packages/release-compatibility/src/home-admission.ts`）：

1. `ENOENT` 视为 marker 缺失，返回 null；
2. marker 是 symlink、非普通文件、不可读、或内容不是 JSON object，一律 fail closed（抛 `HomeAdmissionError`，调用方必须按拒绝处理）；
3. 字段缺失或类型不符按损坏内容处理，同样 fail closed。

## 3. Admission 判定

```
checkHomeAdmission({ marker, supportedDataEpochs }) →
  'allow' | 'unknown-schema' | 'unsupported-data'
```

- marker 缺失 → `'allow'`（M3 现存 home 无 marker）；
- schema 非 1 或内容损坏 → `'unknown-schema'`；
- `dataEpoch ∉ supportedDataEpochs` → `'unsupported-data'`；
- 其余 → `'allow'`。

M3 内嵌 `supportedDataEpochs = [1]`。

## 4. 调用时机与边界

- **Desktop**：`RecoverySessionController` 在取得 home lease 之后、任何 profile/cache/Host 写入之前调用一次（实现于 `#admitHomeBeforeAnyWrite`）。拒绝产生非重试的 `home-config` 失败（code `HOME_MARKER_UNKNOWN` / `HOME_DATA_UNSUPPORTED` / `HOME_MARKER_UNREADABLE`），进入本地恢复页，同时撤下 Safe Mode 入口（Safe Mode 也要写 home，不得绕过）；lease 保持持有供诊断，由用户退出时释放。
- **CLI**：`dsh-native` 在取得 lease 之后、spawn 官方 CLI 子进程之前判定；拒绝打印原因并以退出码 5 结束，不产生任何子进程与写入。
- **doctor**：`dsh-native doctor --unlock` 是只读诊断/清理路径，不做 admission。
- 无 profile 的透传路径（帮助、版本）不取 lease 也不写 home，不做 admission。

## 5. 安全与诚实边界

- dataEpoch 是**本项目**的兼容性分组，不是 DSH 官方 schema；上游具体格式证据由 M4 的清单补齐。
- 该 marker 只保证"受支持入口之间"的协作：它不能阻止其他裸 CLI、旧无 guard 二进制或用户直接写入 home。
- marker 本身不含秘密；路径校验与 lease 协议（[home-lease](home-lease.md)）仍然独立生效。

## 6. 演进

- M4：增加 marker writer（首个受支持写入者落盘）、格式证据清单与升级/降级预检；schema 1 保持可读。
- 新增字段只做 additive；`schemaVersion` 提升（2+）的 marker 对本版本按 `unknown-schema` 拒绝。
