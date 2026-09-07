# DSH 0.1.2-rc.1 升级资格验收记录

- **状态：accepted（go）——`dsh-v0.1.2-rc.1` 取代 `dsh-v0.1.2-alpha.3` 成为运行时基线；M5/M6 以本记录的候选制品为输入**
- 日期：2026-09-08（通宵自主执行，授权范围：路线图全部任务）
- 分支：`feat/upgrade-dsh-0.1.2-rc.1`（提交 `e371127` → `61c4b8c`；计划原命名 `codex/upgrade-dsh-0.1.2-rc.1` 因不符合 AGENTS.md 分支命名规范改为 `feat/` 前缀）
- 执行计划：[DSH 0.1.2-rc.1 Upgrade Qualification](../superpowers/plans/2026-09-07-dsh-0.1.2-rc.1-upgrade.md)
- 上游设计：[Post-M4 Delivery Design](../superpowers/specs/2026-09-07-post-m4-delivery-design.md)

## 1. 执行环境

- macOS 26（darwin 25.6.0，arm64）、Node 24.11.1 / pnpm 11.7.0（Corepack）、Electron 44.1.0
- 上游事实（全部从发布源码/npm registry 逐项核实，非转抄计划）：
  - tag `dsh-v0.1.2-rc.1` @ `a66e4702047846cdaa10c66c9d3df3951f5ea70d`（本地克隆 `git rev-parse` 复核）
  - npm `0.1.2-rc.1`；`@deepseek-ai/dsh` tarball integrity `sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA==`
  - 演练时 `git ls-remote` 观察到 `dsh-v0.1.3-alpha.1`、`dsh-v0.1.3-alpha.2` 等更高 tag——按设计不属本交付列车（0.1.3 改 Session 持久化所有权并写 Session v2）

## 2. 持久格式事实（alpha.3 与 rc.1 双侧源码对照）

| 格式             | alpha.3                                                                 | rc.1                                                                                                       | 结论       |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| credentials      | `DOCUMENT_VERSION = 1`（dsh-credentials-local）                          | `DOCUMENT_VERSION = 1`                                                                                     | 不变       |
| Session JSONL    | `SESSION_FORMAT_VERSION` = 0                                             | = 0                                                                                                        | 不变       |
| workspace 域    | `defineDomain({version: 2})`                                            | `version: 2`                                                                                               | 不变       |
| 投影缓存         | `version: 4`，无 `compatibleVersions`                                   | `version: 5`，`compatibleVersions: [3, 4]`                                                                 | 写 4→5     |
| settings/storage/profile | provider-build 身份（无上游数字 schema）                        | 同左，文档形状不变                                                                                          | 身份随构建 |

- **data epoch 保持 1**（投影缓存是派生可重建数据；所有持久格式无迁移需求）。
- 本仓库 policy：投影缓存 readable `[v4, v5]`、writable `v5`（上游另可读 v3；M4 从未写过 v3 记录，本策略保守不声明）；settings/storage/profile 三条 provider-build 规则 **同时声明 alpha.3 与 rc.1 两个 ID 可读**（writable rc.1）——无此项时 M4 marker 与 rc.1 观察值会跨规则失配，所有升级家被拒（见 §5.3）。
- marker 一致性新规则：不等 ID 仅当**同一条规则**的 readable 集合同时含两者才兼容；跨规则或不被本 release 可读的组合仍然拒绝。

## 3. 门禁结果（最终轮 `verify:release`，HEAD `61c4b8c`，一条链 13/13，退出码 0）

| 步骤                                        | 结果                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| check（format/lint/types/unit/docs）         | 单测 391/391（32 文件）；docs 44 文件通过                              |
| generate:compatibility + verify:dsh-closure + verify:patches | 清单再生成；闭包 923 条记录零漂移；补丁账本空                    |
| test:integration                             | 98/98（9 文件，含 rc.1 Host 窄契约回归）                               |
| test:shared-home                             | 4/4（真实 rc.1 图，CLI↔Desktop 会话接力）                              |
| package:dir + verify:compatibility           | runtime-tree 4 host + 5 cli native ABI 验证；staged 清单一致           |
| package:dmg + verify:artifacts               | DMG 构建并摘要绑定                                                     |
| smoke:package                                | 16/16 制品级场景                                                       |
| archive candidate + rehearse:upgrade         | **18/18 步跨版本演练**（详见 §4）                                      |
| git diff --check                             | 通过                                                                  |

## 4. 跨版本演练（previous = M4 `caa5c51` 冻结件，candidate = `61c4b8c`）

previous：`m4-0.0.0-darwin-arm64-caa5c51`，DMG SHA `4f2db31b…`（冻结副本 `release/baselines/m4-caa5c51/`，装前摘要复核逐字节一致）。
candidate：`m4-0.0.0-darwin-arm64-61c4b8c`，DMG SHA `a7326ccbc8b12bcace0a8065ad545da3d2f253766a8e35e55f605e530c44bca9`，内嵌兼容清单 SHA `332ae0a858376ba7f5d0604a4a579aaff4d1aeb2af7b46ca1504a4921814d3c7`。

18 步全过，关键强化断言（本次新增）：

1. **标题跨版本保留**：M4 轮经 `session/rename` 钉死标题 `rehearsal-cross-version-title`；rc.1 升级轮与重启轮的 `session/list`（`projections.values.title`）必须原样供出——这是 rc.1 读取 M4 缓存 v4 投影的 API 级证明。
2. **升级家格式事实**：epoch 1 保持；投影缓存戳记 `[4,5]` 混存（域身份=最新在场戳记）；**M4 拒收 rc.1 写过的家**（副本上 previous CLI exit 5，逐文件摘要证明未触碰）。
3. `upgrade-type-recorded` 如实记录为 **cross-version-upgrade**（非同基线重装）。

既有断言照常：损坏 DMG 摘要负例、内嵌清单 releaseId 绑定、原位升级历史保留、第三方 bundle 摘要不变、CLI 续写、重启再读、真实 zstd 会话逐字节过境、4 类 marker/storage 拒绝负例、桌面端 epoch 拒绝。

## 5. 执行偏差与处置（如实）

1. **家族统一需要 overrides**（`e371127`）：pnpm 11.7 对预发布版 peer 的自动装包解析，在声明 `^0.1.2-rc.1` 的上下文里解析到 `0.1.2-alpha.3`（干净 worktree 全新解析同样复现，排除 lockfile 残留）。处置：`pnpm-workspace.yaml` 增加 `overrides: '@deepseek-ai/dsh*': 0.1.2-rc.1`（闭包检查器本就预期 @deepseek-ai overrides 必须精确版本；`verify:dsh-closure` 923 条记录零漂移）。
2. **计划外文件进入 Task 1**：`build/compatibility-policy.json` 与 `scripts/verify-compatibility.test.mjs` 的出处指针（npm 证据路径、upstream commit）必须随基线换血，否则 `generate:compatibility` 拒绝生成。计划的 Task 1 文件清单未列二者，属计划疏漏而非范围扩张。
3. **provider-build marker 可读对缺口**（`b871bb9`，第二次链的 smoke 失败暴露）：M4 写的家 marker 记 alpha.3 ID，rc.1 检查器报 rc.1 ID，而三条 provider-build 规则只声明 rc.1 可读 → 一致性检查拒绝一切升级家。该缺口同时暴露 **`installed-cli-version` 场景自 M4 起一直在只读触碰真实 `~/.dsh`**（未传 home 时 DSH_HOME 缺省回退）；处置：三条规则 readable 补 alpha.3 ID（TDD：失败测试先行），场景改用隔离空 home。真实 home 在整个失败过程中只被读、从未被写（拒绝发生在任何写入前）。
4. **M4 冻结件的 app bundle 是旧名**：`caa5c51` 早于改名提交 `56c9c6e`，冻结 DMG 内是 `DeepSeek Harness Desktop.app`；候选是 `DeepSeek Harness.app`，DMG 文件名相应从 `DeepSeek Harness Desktop-…` 变为 `DeepSeek Harness-…`（继承自已合并的改名，非本次改动）。演练 `PREVIOUS_APP_NAME` 按此修正。
5. **演练脚手架自身的四处修正**（`61c4b8c`）：内嵌清单断言从"M3 schema 1"改为双侧 schema 2 + 各自钉住 alpha.3/rc.1；`session/rename` 参数须嵌 `request` 键（typert 网关形状）；标题须从 `projections.values.title` 读（两个版本都无顶层字段）；fixture 拆卸错误改为先记录再重抛（曾被 ENOTEMPTY 竞争掩盖真实步骤错误一整个调试周期）。
6. **陈旧构建产物清理**：`release/staging`（M4 残留，与再生成清单不一致）与 `release/dist` 内 M4 旧 DMG（与新 DMG 并存致 `verify:artifacts` 歧义拒绝）先后清除；M4 制品在 `release/baselines/m4-caa5c51/` 冻结保全（SHA 复核一致）。
7. **releaseId 前缀仍为 `m4-`**：`generate-compatibility.mjs:318` 硬编码前缀；候选以提交哈希区分（`…-61c4b8c`）。命名归 M5 发行工程决定，本阶段不扩权修改。
8. **既有 peer 警告（非 rc.1 引入，M4 lockfile 同样存在）**：`tsconfck` 要 typescript ^5（装 6.0.3，开发链）；`react-dom@19` 要 react ^19（装 18.3.1，开发链传递依赖）。运行时闭包 singleton 唯一性由 `verify:runtime-tree`/`verify:dsh-closure` 保证，不受影响。

## 6. 决策

**go**。判定依据（全部为实机命令 + 退出码）：

- 家族完整且统一：npm 全家族存在 rc.1；闭包 923 条记录零漂移（overrides 声明式强制）；
- 出处可证：tag/commit/integrity 三方核对；格式事实从双侧发布源码重推导，唯一变化是投影缓存写版本；
- 直接 API 兼容：typecheck 零错误、适配器与 Host 启动测试全过、零适配器源码改动；
- 全链 13/13 于最终候选 `61c4b8c` 单链通过；
- 真实跨版本升级演练 18/18（含标题保留、epoch/戳记、降级拒收、第三方 bundle 不变）；
- 清理证据：无进程、无挂载、无临时安装/fixture 残留（历史测试垃圾一并清除）。

## 7. 未验证范围（如实）

- darwin-x64 未构建（与 M4 相同）。
- 签名/公证/更新器不在 v1 范围。
- rc.1 候选的日常使用观察未执行（本记录是资格验证，不替代日用观察；M4 结项时负责人已接受同类残余风险）。
- 上游 0.1.3 线（Session v2 持久化所有权变更）未评估——将来升级须另立资格计划与迁移 ADR。

## 8. 基线移交

- 运行时基线：`dsh-v0.1.2-rc.1` @ `a66e470…`（npm `0.1.2-rc.1`）。
- M5 输入：本候选 `m4-0.0.0-darwin-arm64-61c4b8c`（`release/candidate/artifacts.json`，DMG SHA `a7326ccb…`，清单 SHA `332ae0a8…`）。
- M4 `caa5c51` 冻结保全于 `release/baselines/m4-caa5c51/`，作为回退基线不删除。
