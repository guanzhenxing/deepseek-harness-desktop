# Home Compatibility Marker 协议

- 状态：M4 已实现（格式预检 + 写入预约；M3 只读 admission 是其子集）
- 相关决策：[ADR-0009](../adr/0009-home-compatibility-admission.md)
- 适用入口：Desktop launcher（含 Safe Mode 会话）与 `dsh-native` CLI 的全部会写 home 的路径

## 1. 目标与非目标

本协议定义受支持入口在启动会写路径前的兼容性 admission：

- **M3 交付**：只读 marker reader + fail-closed admission。marker 缺失允许进入（现存 home 早于本机制）；未知 schema、损坏内容、不受支持的 dataEpoch 一律拒绝，且不产生任何 home 写入。
- **M4 交付**：只读 home 格式勘察（`inspectHomeFormats`）、纯预检判定（`preflightHome`）与写入预约（`reserveHomeWrite`）。受支持入口在写入前将 schema 1 marker 原子落盘；未知格式、不可读格式、更高 epoch、需要迁移的数据在写入前拒绝。
- **非目标**：自动数据迁移（preflight 返回 `MIGRATION_REQUIRED`，需独立 ADR）；阻止不受支持入口（裸 CLI、无 guard 旧二进制）写入。

## 2. Marker 布局与格式

路径固定为 `<home>/run/compatibility.json`：

```json
{
  "schemaVersion": 1,
  "dataEpoch": 1,
  "lastWriterReleaseId": "m4-0.0.0-darwin-arm64-98af342",
  "formats": {
    "credentials": "dsh-credentials-file-1",
    "settings": "dsh-settings-file-0.1.2-alpha.3",
    "sessions": "dsh-session-jsonl-0"
  }
}
```

| 字段                  | 类型                             | 语义                                                                      |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `schemaVersion`       | `1`                              | marker 自身 schema；非 1 一律按未知处理                                   |
| `dataEpoch`           | 安全整数                         | 本项目自定义的兼容性分组（见 §4）                                         |
| `lastWriterReleaseId` | 非空字符串                       | 最后一个预约写入此 home 的发行版标识（诊断用，不构成信任）                |
| `formats`             | 槽位名 → formatId 的 map（可空） | 首个预约写入者观察到的持久化格式证据；M4 预检用它做 marker/磁盘一致性比对 |

读取规则（实现：`packages/release-compatibility/src/home-admission.ts`）：

1. `ENOENT` 视为 marker 缺失，返回 null；
2. marker 是 symlink、非普通文件、不可读、或内容不是 JSON object，一律 fail closed（抛 `HomeAdmissionError`，调用方必须按拒绝处理）；
3. 字段缺失或类型不符按损坏内容处理，同样 fail closed。

写入规则（实现：`home-marker.ts` 的 `reserveHomeWrite`）：

1. 仅在持有该 home 的 lease 时执行（lease.home 必须一致）；无 lease 的透传路径从不预约；
2. fsync 临时文件 + 原子 rename + 目录 fsync（与 journals/safe-profile 同一落盘纪律）；
3. 预约发生在任何潜在新格式写入之前；预约后启动失败**不回滚 epoch**——崩溃窗口后的新格式数据必须被怀疑，而不是被当成旧数据。

## 3. Admission 判定

入口共享固定顺序（实现：`runHomeCompatibilityChain`）：

```
parse marker → inspectHomeFormats（只读） → preflightHome（纯判定） → reserveHomeWrite
```

`preflightHome({ release, marker, observed })` 的判定顺序：

1. marker 可解析但字段非法 → `UNKNOWN_FORMAT`；
2. `marker.dataEpoch ∉ release.supportedDataEpochs` → `UNSUPPORTED_EPOCH`（更高版本写入的数据，禁止降级打开）；
3. `marker.dataEpoch < release.dataEpoch` → `MIGRATION_REQUIRED`（旧 epoch 数据不自动迁移）；
4. `observed.unknownPaths` 非空（存在无法归类的落盘形态）→ `UNKNOWN_FORMAT`；
5. 观察到的 formatId 不在任何可读清单 → `UNREADABLE_FORMAT`；
6. marker 记录的槽位与磁盘观察不一致 → `UNKNOWN_FORMAT`（保守拒绝）；
7. 其余 → allow（携带本 release 将写入的 epoch 与格式证据）。

格式勘察（`inspectHomeFormats`）只解析已知文件头/布局，不加载 DSH 或用户插件、不启动 provider：credentials 的 `version:` 头（`refs:` 与 `records:` 两种段落均为本 baseline 已知形态，前者 API-key 引用、后者桌面 Host 写入的连接授权）、settings 的存在性（provider build 即格式身份）、session JSONL 首行 `{type:'session',version:0}`（`.zstd` 必须以真实 zstd 帧头开头——标准帧魔数 `0xFD2FB528` 或 skippable `0x184D2A50-5F`，且 RFC 8878 帧头描述符合法（保留位为零）并携带其声明的 window/dictionary/content-size 字段；仅凭扩展名或裸魔数不认定格式；同一 session 目录中 plain 与 `.zstd` 并存即拒绝（上游 backend 拒绝双编码）；有界条件下不做解压）、storage 单元信封（single：`{unit:{name,version}}`；per-record：`global.json` 与**每一条记录文档**均为 `{version,record}`，且每条记录的 version 必须与所在单元的 global 戳记一致（无 global 的单元以首条记录锚定、全部记录须一致）——上游 storage 后端会静默丢弃版本不符的记录，混版数据必须拒绝；域名取自目录名）、`session_projcache` 域固定 v4（域内任何非 v4 戳记的记录即为 foreign）、profile manifest 的 `dsh.profile` 形状。**枚举与分类纪律（2026-09-06 两轮修订，取代早期的 ≤32×32/≤64/≤32 采样上限）**：每一层目录用 `opendir` 增量枚举；枚举出的每个条目都做 lstat 外形检查（symlink/FIFO/异形一律计 unknown，绝不跟随）**并且**做头部分类——无法分类的正文在任何位置都拒绝，不存在"采样后放行"。**有界是端到端的**：单目录 65,536 枚举上限之外，一次勘察共享条目数/读取字节数/unknown 数三项预算（`createInspectionBudget`），任一耗尽即把正在走的槽位目录判 unknown（fail-closed），嵌套遍历与输出规模都有全局上界。`profiles/` 的豁免仅限真正的运行时启动根 `.dsh-desktop-run-*` **实目录**；该前缀在共享命名契约层保留（`@dsh-desktop/desktop-contracts/profile-name` 的 `RESERVED_PROFILE_NAME_PREFIX`），profile-manager 的 `createProfileRef` 与 home-lease 的 `validateProfile`（bundled CLI 一切 profile 入口的闸门）一并拒绝，用户 profile 不可能借道（点号名如 `.prod` 合法、照常检查）；同名 symlink 照常拒绝；散落的普通文件（如 `.DS_Store`）不是 profile、运行时也不加载，跳过。`storages` 槽位固定为信封身份（域内增长不翻转槽位值），`projcache` 是独立槽位（域内被 flag 即翻转 foreign）。

入口对拒绝的映射：

- **Desktop**：`RecoverySessionController#admitHomeBeforeAnyWrite` 把拒绝变成非重试 `home-config` 失败（`HOME_MARKER_UNKNOWN` / `HOME_DATA_UNSUPPORTED` / `HOME_FORMAT_UNKNOWN` / `HOME_FORMAT_UNREADABLE` / `HOME_MIGRATION_REQUIRED` / `HOME_MARKER_UNREADABLE`），进入本地恢复页，撤下 Safe Mode 入口（Safe Mode 也要写 home，不得绕过）；lease 保持持有供诊断。
- **CLI**：取得 lease 之后、spawn 子进程之前判定；拒绝打印原因并以退出码 5 结束，不 spawn 任何子进程。
- **doctor**：`dsh-native doctor --unlock` 是只读诊断/清理路径，不做 admission、不写 marker。
- 无 profile 的透传路径（帮助、版本）不取 lease，但同样过只读链（不预约）；拒绝即退出码 5，不 spawn——CLI 没有绕过面。

## 4. dataEpoch 语义

- dataEpoch 是**本项目**的兼容性分组，不是 DSH 官方 schema。当前 epoch = 1，`supportedDataEpochs = [1]`，由 policy（`build/compatibility-policy.json`）与生成清单共同声明。
- epoch 只在格式证据支持的升级里提升，且提升必须伴随升级演练证据；不为每个 Desktop 版本无故+1。
- `MIGRATION_REQUIRED` 是显式缺口：本版本不迁移；迁移需要独立 ADR、停写与可验证备份。

## 5. 安全与诚实边界

- 该 marker 只保证"受支持入口之间"的协作：它不能阻止其他裸 CLI、旧无 guard 二进制或用户直接写入 home。
- marker 本身不含秘密；`.credentials.yaml` 的检查只看 `version:` 头与 `refs:` 结构，不读字段值。
- 路径校验与 lease 协议（[home-lease](home-lease.md)）仍然独立生效。

## 6. 演进

- M4 已交付 marker writer（首个受支持写入者落盘）、格式证据清单与预检；schema 1 保持可读。
- 新增字段只做 additive；`schemaVersion` 提升（2+）的 marker 对本版本按 `unknown-schema` 拒绝。
