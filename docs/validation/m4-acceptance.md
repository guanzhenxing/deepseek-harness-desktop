# M4 验收记录：发行兼容性、依赖闭包与升级演练

- **状态：candidate-verified（自动门禁与 15/15 演练步骤全部通过；`current` 状态等待 jesen 至少一个正常工作日的人工使用观察，见 §8）**
- 日期：2026-09-05
- 基线：`main` @ `98af342`（M3 合并后）
- 结果分支：`codex/m4-release-compatibility`
- 执行计划：[M4 Implementation Plan](../superpowers/plans/2026-09-02-m4-release-compatibility.md)
- 决策记录：[ADR-0009 实现补充](../adr/0009-home-compatibility-admission.md)、[home-compatibility 协议](../protocols/home-compatibility.md)、[upstream-baseline](../upstream-baseline.md)、[升级指南](../upgrade-guide.md)

## 1. 执行环境

- macOS 26（darwin 25.6.0，arm64）、Node 24.11.1 / pnpm 11.7.0（Corepack）
- DSH 0.1.2-alpha.3（tag `dsh-v0.1.2-alpha.3` @ `dd6322d6…`，官方 npm 发布包）、Electron 44.1.0
- 全部演练/冒烟使用临时 home/userData/安装目录；真实 `~/.dsh` 仅被**只读**勘察命中一次（shim 门禁隔离修复前，见 §5），无任何写入

## 2. 交付内容（对照计划 Task 1–5）

| 任务       | 交付                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 提交                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Task 1     | schema-2 发行清单：严格解析器（`packages/release-compatibility/src/manifest.ts`）、生成器（`scripts/generate-compatibility.mjs`，锁定 docs/compatibility.json + policy + upstream-artifacts + lockfile 闭包 + 补丁账本，输入分歧即拒绝）、字节级再校验（`verify-compatibility.mjs`）；`build/compatibility-policy.json` 六类持久化格式逐条机检证据（npm 包内文件存在性 + fixture SHA-256 + upstream commit 绑定）；About 面板与 CLI doctor 版本事实从清单/基线文档读取 | `cc88336`            |
| Task 2     | DSH 依赖闭包对账（`verify:dsh-closure`：921 条 lockfile 记录逐条 baseline 校验、浮动 specifier 拒绝、singleton 唯一性、Cordis/React 独立版本分类、override 范围拒绝、清单闭包摘要绑定）；补丁账本（`patches/manifest.json` 显式空数组 + `verify:patches`）；`docs/upstream-baseline.md`；runtime-tree 校验器扩展（web asset 必备文件、双锚点 singleton 解析、schema-2 清单一致性）                                                                                     | `8ec0bbc`            |
| Task 3     | home 兼容链：`inspectHomeFormats`（只读勘察，已知文件头/布局，枚举有界，symlink 计未知）→ `preflightHome`（纯判定，七步决策序）→ `reserveHomeWrite`（持 lease、fsync temp+rename+目录 fsync）；Desktop（含 Safe Mode）与 CLI（含无 profile 透传）全部入口接线；拒绝码 `HOME_FORMAT_UNKNOWN`/`HOME_FORMAT_UNREADABLE`/`HOME_MIGRATION_REQUIRED` 入恢复页/CLI exit 5                                                                                                     | `cf1514c`            |
| Task 3 fix | 第三方 bundle manifest（无 `dsh` 段）与迁移域（v3 遗留单文件 + v4 per-record 并存）归类修正；shim 门禁用隔离 home（不再读开发机真实 `~/.dsh`）                                                                                                                                                                                                                                                                                                                         | `dc09a43`、`7001f64` |
| Task 4     | 升级演练（`rehearse:upgrade`）：显式 previous/candidate 制品索引 + 摘要先行校验 + 损坏 DMG 负例 + 内嵌清单摘要/releaseId 绑定；M3 制品播种 → 逐字节校验副本 → **原位升级**（同 userData 同 home 路径，符合真实升级语义）→ 历史保留/第三方 bundle 不变/防虚 marker 断言 → CLI 续写 → 重启 → 4 项拒绝负例（更高 epoch/schema 2/损坏 marker/外来 storage 格式）+ 桌面端降级拒绝 + `same-baseline-reinstall` 如实记录                                                      | `dd4799f`、`92f08e2` |
| Task 5     | `verify:release` 聚合门禁（12 步）、本文档、README/主方案/路线图/协议/ADR 状态更新                                                                                                                                                                                                                                                                                                                                                                                     | 见最终 docs 提交     |

## 3. 发行清单与格式证据（Task 1 要点）

- 内嵌清单 schema 2 字段：releaseId（绑定 desktopVersion/platform/arch/HEAD）、dsh tag/commit/npmVersion、hostControl、profileSchemaVersion、pluginApi（`verified-exact-baseline`，singleton 三包）、六类 formats（credentials v1 refs/records、settings provider-build 身份、session JSONL v0、storage unit envelope、projcache v4、profile manifest）、dataEpoch 1、supportedDataEpochs [1]、dependencyClosureSha256、patchManifestSha256。
- 未知格式不进清单；不杜撰上游未定义的 schema 版本号（settings 无官方版本 → formatId 以 provider build 命名并注明）。
- 生成器拒绝输入分歧（docs vs upstream-artifacts vs policy vs lockfile）；重复输入产出字节相同内容（无时间戳）。

## 4. 升级演练结果（`rehearse:upgrade`，15/15 步通过，退出码 0）

对真实 DMG 制品执行（previous = M3 候选 `m3-0.0.0-darwin-arm64-f972354`，SHA `f93873b0…`；candidate = M4 候选 `m4-0.0.0-darwin-arm64-dd4799f`）：

1. `artifact-digests`、`corrupt-candidate-refused`（字节翻转 DMG 在安装前拒绝）、`embedded-manifests`（previous schema 1 只读 reader / candidate schema 2）
2. `previous-desktop-boot`、`previous-cli-round`（M3 制品播种两轮合成会话 + 第三方 fixture bundle）
3. `home-copy-verified`（副本逐字节校验；negatives 只用副本）
4. `candidate-upgrade-boot`（**原位升级**：历史保留、candidate 亲写 marker 预约断言、第三方 bundle 摘要不变）
5. `candidate-continuation`（candidate CLI 读历史并追加）、`candidate-restart`（重启再读）
6. `refusal-epoch-2-marker`（更高 epoch 对旧版 CLI exit 5）、`refusal-schema-2-marker`、`refusal-corrupt-marker`（两者对双制品 exit 5）、`refusal-foreign-storage-domain`（M4 预检拒绝 M3 reader 放行的外来格式——格式勘察在真实安装制品上生效的证明）
7. `refusal-desktop-epoch-2`（M3 桌面端 admission 链在写入前拒绝更高 epoch home）
8. `upgrade-type-recorded`：**same-baseline-reinstall**（上游已出现 `dsh-v0.1.2-alpha.4/alpha.5/rc.1`、`dsh-v0.1.3-alpha.1`，真实跨版本升级须另立 `codex/upgrade-dsh-<tag>` 分支演练；本分支不制造版本跳转）

全部拒绝路径经逐文件摘要对比证明**未触碰任何数据文件**（lease 协调元数据除外）。

## 5. 执行偏差与处置（如实）

1. **shim 门禁读真实 home（只读）**：verify-runtime-tree 的 shim 检查曾无 DSH_HOME 运行 `dsh-native --version`，M4 勘察链因此只读命中开发机真实 `~/.dsh`（发现真实 home 的 v3 遗留 projcache 单文件，促成迁移域归类修复）。处置：门禁改为指向空隔离临时 home（`7001f64`）；真实 home 无任何写入。
2. **演练首次设计为"搬家式升级"**：副本换路径后 M2 journal 的 ref 包含性校验（正确的 fail-closed 安全设计）判 journal corrupt → needs-review。真实升级从不搬 home。处置：演练改为原位升级（previous/candidate 共用同一 smoke userData——与真实升级共用 Application Support 语义一致），副本仅作 negatives 的 pristine 基线（`dd4799f`）。
3. **candidate 首轮"升级通过"是虚的**：smoke 模式下 Desktop home 解析为 `<userData>/home`（M0 遗产，`main.ts` resolveSmokeHome），忽略 DSH_HOME——candidate 实际在空 home 上自举。处置：home 放进 candidate 的 smoke userData，并加"candidate 亲写 marker 断言"防虚（`dd4799f`）。
4. **Host 写出的 credentials 被 inspector 误判**：desktop profile 的 Host 写 `.credentials.yaml` 的 `records:` 段（connection grants），inspector 只认 `refs:`。处置：两种段落都属 baseline 格式（fixture + 单测固化）。
5. **lease 释放竞态**：app 退出偶发释放失败（M1 语义：不阻塞退出，留 HOME_STALE）。处置：桌面轮与 CLI 轮之间加 `waitForLeaseGone`（与 M3 package smoke 同法）。
6. **自审第 1 轮发现（对抗协议，交付后、验收记录前）**：
   - **P1 闭包解析缺口**：pnpm v9 lockfile 有 277 个 peer 后缀 key（`name@ver(peer@ver)`，其中 218 个 `@deepseek-ai/dsh*`），原解析器对它们产出垃圾 name——这些 DSH 包完全绕过 baseline 漂移检查。修复：剥离后缀 + name@version 去重 + 真实 store 的 `+` 编码 relativePath（带回归测试；真实 lockfile 现覆盖 215 个 DSH 包、0 漂移）。
   - **P2 勘察 fail-open**：目录 `readdir` 的 EACCES 等失败曾被吞成"空目录"（权限异常的 sessions/ 会被当作无会话放行）；credentials 为 symlink/FIFO 时被当作缺失。修复：全部改为 fail-closed（unreadable → 槽位 unknown）。
   - **P1 演练虚证**：`corrupt-candidate-refused` 原实现把 DMG 文件当索引进 JSON.parse——只证明了"DMG 不是 JSON"。修复：负例索引钉住**原始 SHA** 指向损坏文件，断言必须命中 `digest mismatch`；桌面降级拒绝补 `ui-ready` 反证（恢复视图不得跟在成功启动后）。
   - **链排序缺陷**：verify:release 原来直接 `package:dmg`，会把陈旧 staging 打进 DMG（首跑被 verify:compatibility 抓住）。修复：`package:dir`（重建 staging）先行。教训：门禁链运行期间不得修改工作树（一次中途编辑导致同链两阶段解析器不一致，作废重跑）。

## 6. 门禁结果

`pnpm verify:release` 聚合链（`scripts/verify-release.mjs`）于最终 HEAD `0abc7cf` 实跑，**12 步全部退出码 0**（2026-09-05）：

1. `check`（prettier/eslint+boundaries/tsc/304 Vitest 单测/Node test 组/36 文档校验）
2. `generate:compatibility` → 3. `verify:dsh-closure`（921 条去重闭包记录）→ 4. `verify:patches`（显式空账本）
3. `test:integration`（54 测试，9 文件）→ 6. `test:shared-home`（真实 DSH 图双向会话）
4. `package:dir`（当前 HEAD 重建 staging + 内联门禁）→ 8. `verify:compatibility`（fresh staging 字节一致）
5. `package:dmg` → 10. `verify:artifacts` → 11. `smoke:package`（15 场景安装级冒烟）
6. candidate 归档 + `rehearse:upgrade`（15/15 步）

链语义：任一步失败即中止；`package:dir` 必须先于 `verify:compatibility`/`package:dmg`（staging 在当前 HEAD 重建后才可比对/封装，否则会把陈旧 staging 打进 DMG——该排序缺陷由链自身首跑暴露并修复，见 §5.6）。

最终轮数字（制品 SHA、releaseId、测试计数）见 §7；单测/集成确切计数以 `verify:release` 日志为准。

## 7. 制品记录（最终 verify:release 轮）

| 项                             | 值                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| candidate releaseId            | （见 `release/candidate/artifacts.json`，绑定最终 docs 提交前的 HEAD）                                                                     |
| previous（保留的上一健康制品） | M3 `m3-0.0.0-darwin-arm64-f972354`，DMG SHA `f93873b0ef95b9b0c1c36218d40213fbd3a3dda5bd40f88247dc7dd929618ff9`，归档于 `release/previous/` |
| 本地补丁                       | 零（`patches/manifest.json` 显式空账本；运行时闭包为纯官方上游 npm 制品）                                                                  |
| 架构                           | darwin-arm64（唯一实际构建并运行的架构；darwin-x64 未构建不进支持矩阵）                                                                    |

## 8. 交付状态与剩余条件

- 自动测试完成 → **`candidate-verified`**。
- **`current`（日用版）的最后放行条件：jesen 至少完成一个正常工作日的人工使用观察**（启动、退出、会话继续、托盘/恢复体验）。观察完成前不标记 current，不伪造。
- 未验证项/剩余风险：
  - 真实跨上游版本的升级演练未执行（上游 alpha.4+/rc.1 已发布；须独立 `codex/upgrade-dsh-<tag>` 分支）。
  - darwin-x64 未构建。
  - 公开发行（Developer ID 签名/notarization/自动更新）不在 v1 范围。
  - 人工观察周期未开始（见上）。
