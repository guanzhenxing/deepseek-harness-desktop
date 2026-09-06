# M4 验收记录：发行兼容性、依赖闭包与升级演练

- **状态：candidate-verified（§5.9 轮残留全部处置后全链重验通过，2026-09-06，13/13 步 + 演练 16/16；`current` 状态等待 jesen 至少一个正常工作日的人工使用观察，见 §8）**
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

## 5.7 五轮独立代码审查（2026-09-05，jesen 指定，交付后）

按对抗审查协议执行五轮（每轮独立攻击者模型、优先攻击最新修复），共 8 项发现全部修复并过门禁：

| 轮  | 攻击面                        | 发现                                                                                                                                                                                                  | 修复                                                                                   |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | 最新修复（0abc7cf/3d55e69）   | sessions 槽位在 `sawAny=false` 时丢弃已记录的 unknown 路径（chmod 000 子目录 → 放行）；演练桌面拒绝断言把 throw 路径的真拒绝误判为失败                                                                | `ef0c21b`（含 chmod 000 回归测试）                                                     |
| 2   | I/O 失败 + corrupt-vs-unknown | marker/credentials/storage/记录戳/profile 五处全文无界读取（植入巨型文件 → 启动路径内存 DoS）；writeAtomicDurable rename 失败泄漏 temp                                                                | 有界读取（64KiB marker/1MiB 凭据与记录/16MiB 单元，超出即 fail-closed）+ temp 失败清理 |
| 3   | TS-vs-runtime + 生命周期      | controller 三个新拒绝码映射零测试（打错字直进恢复页）；reserveHomeWrite 只比对 lease.home 不验证仍持有                                                                                                | 三个码的映射测试（28/28）+ `lease.assertHeld()`                                        |
| 4   | 证据真实性                    | manifest 解析器两分支（空 singletons/epochs 非升序）与 policy 证据 4 个失败分支（npm 缺失/upstream 不符/repo 缺失/未知 scheme）无测试——删除对应检查测试仍绿；foreign-storage 负例描述声称未证明的对比 | 补 6 个测试；描述改为结构性论证的如实表述                                              |
| 5   | 计划严格对照                  | verify:release 缺计划门禁清单里的 `git diff --check`；协议文档 credentials 描述漏 `records:` 段                                                                                                       | 链补第 13 步；协议更新                                                                 |

审查过程中链式重跑另暴露一项**主线产品 bug**（非 M4 引入）：lease 释放把探测 helper 的瞬态 `unknown` 当 `LEASE_CHANGED` 拒绝 → 退出偶发留 stale lock 需 doctor（M3/M4 应用均复现，4 轮链中 3 轮出现）。修复：`inspectWithRetry`（`unknown` 有界重试 3 次×100ms，确定性 `absent`/`different` 仍立即拒绝；21/21 单测含两个新语义测试）`e487138`。M3 previous 制品已冻结无法修复，演练对其 stale lock 走它自带的 `doctor --unlock` 容差（candidate 保持严格）`dc0e2b8`。

## 5.8 codex 复审轮（2026-09-05，范围 fc54de8..dc0e2b8，5 项全部处置）

| #   | 级别 | 发现                                                                                                                                                                                                                   | 处置                                                                                                                                                                      |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P1   | 格式勘察可被 FIFO 挂死（open 读端阻塞）；profile/session/storage 各级 symlink 被跟随或静默跳过，违反协议 symlink 拒绝规则                                                                                              | `readBoundedText` 开前 lstat 守卫（仅真普通文件可开）；新增 `directoryKind` 下钻纪律（symlink/异形 → unknownPaths）；回归测试覆盖 FIFO + 目录/文件 symlink + 外指 symlink |
| 2   | P2   | window-state 临时文件用可预测 PID 名 + `'w'`，预置 symlink 可截断目标文件                                                                                                                                              | `randomUUID` + `'wx'` 排他创建（19/19）                                                                                                                                   |
| 3   | P1   | 损坏 DMG 负例未执行摘要验证（把 DMG 当 JSON 索引，任何异常即通过）。**本轮额外查明：五轮自查曾记录此项"已修复"，但当时的补丁脚本中途断言失败退出、从未写盘——记录不实，本文件 §5.7 该行的"已修复"结论作废，以此处为准** | 真负例索引：合法 JSON 钉**原始 SHA** 指向损坏 DMG，断言必须命中 `digest mismatch`，其他异常重新抛出                                                                       |
| 4   | P1   | 归档索引指向 `release/dist`（后续构建会覆盖），演练实际验证的是 dist 而非归档副本                                                                                                                                      | 归档步骤改写 `file` 为归档内相对路径 + 复制后重算副本摘要与构建记录比对后才写索引；当前 `release/candidate/artifacts.json` 由修复后的链重新生成                           |
| 5   | P2   | "历史续写与重启再读"只有文件计数证据                                                                                                                                                                                   | 捕获播种会话 ID：升级启动后经真实 API `session/list` 断言旧会话在列并**续写同一会话**；旧会话文件须含两轮 turn 与两条原文标记；重启后 API 级再断言（旧 ID 在列且 ≥3 项）  |

修复期间链式重跑继续暴露 lease 探测的瞬态问题（同一主线 bug 的两面），追加两项加固：取锁侧 `inspectConfirmed`（非 `same` 判定需间隔 100ms 两次一致才信，活进程单次误读不再被判定 HOME_STALE——`7c9dae5`，22/22 单测。**后核修正（§5.9）：该提交实际仅复查 `absent`/`unknown`，`different` 仍立即采信，"两次一致"表述过头；确认语义于 §5.9 轮才补全，且 `unlockHome`/`assertHeld` 当时仍是单次探测**）；释放侧重试加强至 5×500ms 且错误信息内联探测判定值（`different`/`unknown` 可分辨——`5ccfd4f`）。遗留观察项：高负载下曾对活进程读到一次 `different`（出现在通过场景的日志中），根因未定，诊断信息已内联，留待复现。

## 5.9 codex 复审第二轮残留处置（2026-09-06，基线 `56f303e`）

codex 复核后认定原始 5 项中 2 项为部分修复（①⑤），并修正 A–D 四项表述；对照代码逐条核实**全部属实**后处置如下。本轮代码变更使 §6 的 candidate-verified 状态失效，须重跑全链后由新一轮记录恢复。

| 残留项                                    | 核实结论                                                                                                                                                                                    | 处置                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① storage 内层 symlink 漏检               | 属实：非 projcache 域目录内部完全不检查；`global.json` 为 symlink 时被静默跳过；projcache 采样把不可读记录当"无样本"处理；存量测试只覆盖顶层 symlink（codex 另行复现兼容链放行并写 marker） | `auditUnitInterior` 有界全走查（每单元 ≤512 条目，溢出即 flag 而非静默截断）：任何 symlink/FIFO/异形条目——含被换掉的 `global.json`、symlink 表目录、symlink 记录文件——进 `unknownPaths`；先写 5 个失败测试再实现（本包 47/47）；演练新增 `storage-inner-symlink` 负例（记录文件外指 `/etc/hostname`，断言 CLI exit 5）                                                                  |
| ⑤ 重启后只查列表与数量                    | 属实：第 6 步仅 `session/list` + 计数，无正文级证据                                                                                                                                         | 重启轮续写播种会话（驱动 API 无只读历史 RPC，续写即强制 Host 全量装载历史的最强可得证明）；退出后字节级断言三轮 turn 原文标记 + `waitForTurns(3)`                                                                                                                                                                                                                                       |
| B 取锁复查语义与代码不符；doctor 单次探测 | 属实：`inspectConfirmed` 当时对 `different` 立即返回；`unlockHome` 单次 `inspect`——单次 `different` 误读即可删活锁；另查出 `readOurs` 自检（`assertHeld` 路径）同为单读                     | 确认语义统一为"仅 `same` 立即信，其余判定一律复查后采用"，抽共享模块 `probe-confirm`；acquisition / `assertHeld` / release / doctor 四处接入；home-lease 33/33 单测（11 个新语义测试，含 doctor 单测从零建立）；§5.8 原处加注修正                                                                                                                                                       |
| C 诊断不足以分辨根因                      | 属实：`56f303e` 未打 owner 记录身份，也无当次观测身份；"秒判根因"说过头                                                                                                                     | 释放拒绝信息内联三重身份：self（当前进程）、owner pid 的**记录**身份、经 `identify()` 的当次**观测**身份。同 pid 下三者关系可分辨三类假设：释放时误读（self==记录、观测异常）/ 取锁时误读（self==观测、记录异常）/ 另一进程释放（pid 不同）。helper `proc_bsdinfo` 零初始化：部分填充落 pid=0 → fail-closed `unknown`，不再产生垃圾 `different`。**根因仍未判定，留待负载演练复现取证** |
| A/D 验收表述                              | `unknown` 重试是"有界容错"而非"退出留锁全部解决"（`different` 留锁仍可出现）；不同步骤偶发失败不能仅凭一次全绿排除共享路径竞态                                                              | 本文件措辞修正（§5.8 加注、本节如实记录）；竞态残余由 B 的"确认后拒绝"语义无害化（单次误读被吸收、确认后仍拒绝且证据完整），证明留待重验轮的负载演练                                                                                                                                                                                                                                    |

测试脚本两项前置加固（历史重复劳动与不可归因失败的来源，先于本轮全部修复落地）：

- **验收入口 pin 运行时**：`verify:release` / `rehearse:upgrade` / `smoke:package` 入口断言 Node `24.11.1`（`tests/helpers/acceptance-runtime.mjs`，错版本立即退出并指明 corepack 用法）。codex 失败轮的驱动实跑 Node 26 即从此缺口进入，事后只能"保留环境差异"。
- **演练中断清理**：`rehearse:upgrade` 接入 SIGINT/SIGTERM → `emergencyCleanup`（此前仅 `smoke:package` 接线）；`installFromDmg` 的 hdiutil mount 注册进应急注册表（此前中断即残留挂载）。中断残留的 detached 进程组/mock LLM 推高系统负载，是"不同步骤偶发失败、单独重跑通过"现象的候选机制之一（D 项）。
- `listSessions` 逐行裸 `JSON.parse` 容错化：仅容忍未闭合的 torn 尾行（写入中快照），行中损坏带文件与内容上下文抛出。

## 6. 门禁结果

**最终轮（§5.9 残留处置后，2026-09-06）**：`pnpm verify:release` 聚合链于 HEAD `fd9a23a` 实跑，**13 步全部退出码 0**（含收尾 `git diff --check`）：check（329 Vitest 单测 + 36 文档校验）→ generate:compatibility → verify:dsh-closure（921 条）→ verify:patches → test:integration（61 测试，9 文件，含新语义下的 doctor-race）→ test:shared-home（4 测试）→ package:dir → verify:compatibility（fresh staging 字节一致）→ package:dmg → verify:artifacts → smoke:package（15/15 场景）→ candidate 归档 + `rehearse:upgrade`（**16/16 步**：新增 `storage-inner-symlink` 负例命中 CLI exit 5；重启轮续写播种会话并字节级验证三轮原文标记）→ git diff --check。验收入口此时已 pin Node 24.11.1。

早期轮（2026-09-05，HEAD `e487138`/`5ccfd4f`）：13 步全过（311 单测/54 集成/演练 15/15），数字见 git 历史；被 §5.9 轮取代。

链语义：任一步失败即中止；`package:dir` 必须先于 `verify:compatibility`/`package:dmg`（staging 在当前 HEAD 重建后才可比对/封装，否则会把陈旧 staging 打进 DMG——该排序缺陷由链自身首跑暴露并修复，见 §5.6）。

## 7. 制品记录（最终 verify:release 轮）

| 项                             | 值                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| candidate releaseId            | `m4-0.0.0-darwin-arm64-fd9a23a`，DMG SHA `1f6d4e88c5edbfed362f28719c31abba28891c926ca3f31b7b152be71d95b9f7`（绑定 §5.9 轮全部提交，docs 提交前） |
| previous（保留的上一健康制品） | M3 `m3-0.0.0-darwin-arm64-f972354`，DMG SHA `f93873b0ef95b9b0c1c36218d40213fbd3a3dda5bd40f88247dc7dd929618ff9`，归档于 `release/previous/`       |
| 本地补丁                       | 零（`patches/manifest.json` 显式空账本；运行时闭包为纯官方上游 npm 制品）                                                                        |
| 架构                           | darwin-arm64（唯一实际构建并运行的架构；darwin-x64 未构建不进支持矩阵）                                                                          |

## 8. 交付状态与剩余条件

- 自动测试完成 → **`candidate-verified`**（§5.9 轮残留全部处置后于 `fd9a23a` 重验通过，2026-09-06）。
- **`current`（日用版）的最后放行条件：jesen 至少完成一个正常工作日的人工使用观察**（启动、退出、会话继续、托盘/恢复体验）。观察完成前不标记 current，不伪造。
- 未验证项/剩余风险：
  - 真实跨上游版本的升级演练未执行（上游 alpha.4+/rc.1 已发布；须独立 `codex/upgrade-dsh-<tag>` 分支）。
  - darwin-x64 未构建。
  - 公开发行（Developer ID 签名/notarization/自动更新）不在 v1 范围。
  - 人工观察周期未开始（见上）。
