# M4 验收记录：发行兼容性、依赖闭包与升级演练

- **状态：candidate-verified（§5.15 轮全部处置——lease watchdog、完整记录信封、skippable 帧长核对、预算输出上界、信号重试排空、全量植入位置测试、独立 zstd admission 步骤——后于制品 HEAD `6fe04f5` 全链重验通过，2026-09-07，13/13 步 + 演练 16/16 + 冒烟 15/15；`current` 状态等待 jesen 至少一个正常工作日的人工使用观察，见 §8）**
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

## 5.10 codex 复审第三轮（2026-09-06，基线 `84b154a`）与 lease `different` 根因判定

codex 三审 5 项（Standards 2 + Spec 3）逐条核实**全部属实**，处置如下；随后全链重验时 **lease `different` 根因在真实故障中被三重身份诊断当场判定**（§5.9 的 C 项由此闭合）。

| #   | 级别 | 发现                                                                                                                                            | 处置                                                                                                                                                                                                                               |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | P1   | 勘察上限静默截断 fail-open：第 65 个 storage 单元（及同族的第 33 个 session project / 会话 / profile）内的 planted symlink 不被检查，兼容链放行 | 勘察纪律重构为**containment 全量、分类采样**：目录走查 lstat 每一层的每一个条目（任何位置的外形异常必进 `unknownPaths`），昂贵的内容读取按导出的分类上限采样；内层 512 功能上限改为 65,536 防御性上限。7 个新上限边界测试（47→53） |
| S2  | P2   | `proc_pidinfo` 只判 `<=0`，短填充可产出"pid 正确 + 启动时间为零/垃圾"的假 `different`                                                           | 要求返回值恰为 `sizeof(info)`，否则不可识别（`0d1a53d` 之前已提交，本轮并入验证）                                                                                                                                                  |
| Sp1 | P1   | `emergencyCleanup` 对同步 cleanup 调 `.catch` → TypeError，首次清理即崩、排水中断                                                               | 每项 cleanup 独立 try/catch 排空（混合同步/抛错/拒绝的行为测试通过）；`installFromDmg` 先 detach 后注销；注册函数导出为 `registerEmergencyCleanup`                                                                                 |
| Sp2 | P2   | `verify:release` 子进程可解析到另一个 Node；`rehearse:upgrade`/`smoke:package` 断言位于静态 import 之后（重型模块先行加载）                     | 子步骤 PATH 前置验证过的 runtime；两个入口改为断言先行 + 动态 import（smoke:package 拆为薄入口 + package-main.mjs）                                                                                                                |
| Sp3 | P2   | 内层 512 上限把表目录也计数，512 条合法 projcache 记录被拒（正常大数据 home 无法启动）                                                          | 随 S1 重构消解：512 记录合法放行（回归测试在案）。**后核修正（§5.11 St4）**：本行"走查 lstat-only 无功能上限"说过头——65,536 防御性上限真实存在且溢出即拒绝（§5.11 起为统一的枚举上限，fail-closed）                                |

**lease `different` 根因判定（C 项闭合，`ead506d`）**：第三轮全链的 smoke `installed-lifecycle` 场景中，三重身份诊断在真实故障里输出——同 pid 88282，记录身份 `1788322451.434515-1788659221.434966` vs 自身/观测身份 `1788322451.538858-1788659221.434966`：**启动时间分量逐位一致，仅 boottime 分量漂移 0.104s**。`KERN_BOOTTIME` 是"当前墙钟 − 开机时长"的推导值，NTP 对时会使其在进程存续期间整体平移；acquire 记录的身份在 release 时读出不同 boottime → `different` → 拒绝释放留锁 → 后续启动 HOME_STALE（同一日志可见 "home lock owner is no longer running"）。修复：身份改为**纯进程启动时间**（内核 fork 时一次性写入、不可变；pid 固定时已唯一，boottime 无判别贡献），ADR-0005 与 home-lease 协议文档同步修订；修复后全链 `probe: different` 与留锁均零出现。历史归因修正：§5.8 的"高负载下对活进程读到一次 different"实为同一 boottime 漂移机制，与负载无关。**本段"旧格式遗留锁判 stale 走 doctor"一句被 §5.11 Sp2 推翻并修正**：旧格式 owner 的活持有者必须判 `same`（否则 doctor 会删除活锁、破坏单写者），probe 现按启动时间后缀兼容旧格式。

## 5.11 codex 复审第四轮（2026-09-06，基线 `8060c6f`）

codex 四审 4 项 Spec（3 项涉数据安全/互斥）+ 2 项 Standards + 2 项措辞，逐条核实**全部属实**，处置如下。

| #   | 级别 | 发现                                                                                                                                                       | 处置                                                                                                                                                                                                                                     |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sp1 | P1   | 分类上限后只查形态不读正文：损坏的第 65 个 storage、`version:99` 的第 33 个会话、损坏的第 33 个 profile 均被当作已知格式放行——违反"无法分类的数据必须拒绝" | 分类上限**废除**：枚举出的每个条目在任何位置都做外形检查**且**头部分类（§5.10 的"分类采样"语义整体作废，以本节为准）；`ENUMERATION_CEILING`（65,536）成为唯一的 fail-closed 上限。位置无关的正文负例测试 ×3，release-compatibility 53/53 |
| Sp2 | P1   | 新身份（纯启动时间）对旧格式 owner（`boottime-启动时间`）稳定判 `different`：M3 运行中会被报 stale，doctor 随即删除**活锁**，两版本同时进入同一 home       | `probe` 对 `<boot>-<start>` 串取 `-` 后的启动时间后缀比较：升级共存窗口内旧版本**活**持有者判 `same`（busy），已退出者照常 `absent`/`different`；真 helper 集成测试在案（集成 68/68）。ADR-0005 与 home-lease 协议同步补充               |
| Sp3 | P1   | `profiles/` 跳过一切点号条目，但 `createProfileRef` 允许 `.prod` 等点号名——`profiles/.prod` symlink 完全不可见（勘察甚至返回 fresh）                       | 豁免收窄为**且仅限** `.dsh-desktop-run-*` **实目录**（运行时启动根；同名 symlink 照常拒绝）；点号 profile 名一律检查；散落普通文件（`.DS_Store` 等，非 profile、运行时不加载）跳过。4 个新测试                                           |
| Sp4 | P1   | `installFromDmg` 在挂载后先 `await mkdtemp` 才登记 detach cleanup（窗口内信号/失败泄漏 mount）；detach 失败被吞后仍注销，瞬态失败留下无清理路径的 mount    | 解析出 mountPoint 后**立即**登记（先于任何 await）；detach 失败**保留**登记供后续应急排空重试，成功才注销                                                                                                                                |
| St1 | P1   | "枚举有界"不成立：sessions/storages/profiles 都是 readdir 全量物化后逐项处理，65,536 上限只覆盖 storage 内层                                               | 全部列表位改用 `boundedEntries`（`opendir` 增量迭代 + 统一 fail-closed 上限，上限机制有专属测试）；协议文档"枚举有界（≤32×32/≤64/≤32）"同步改写为新纪律                                                                                  |
| St2 | P2   | 越界测试用排序后的 readdir 结果选择植入位，实现用原始顺序——植入项未必真的落在实现的分类上限之外                                                            | 随分类上限废除而消解：新测试全部位置无关（负例创建于列表末尾，断言不依赖 readdir 顺序）                                                                                                                                                  |
| St3 | P2   | "最终 HEAD 完整重跑"措辞：链实际运行于制品 HEAD `ead506d`，`8060c6f` 及之后是文档提交                                                                      | §6 已改为精确表述：链运行于制品 HEAD；其后的 docs 提交不改代码/制品                                                                                                                                                                      |
| St4 | P2   | "内层走查无功能上限"说过头（65,536 上限真实存在）                                                                                                          | 代码注释与 §5.10 Sp3 行原处修正（见上）                                                                                                                                                                                                  |

## 5.12 codex 复审第五轮（2026-09-06，基线 `3911527`）

codex 五审 4 项 Spec + 2 项 Standards，逐条核实**全部属实**，处置如下。

| #   | 级别 | 发现                                                                                                                                                              | 处置                                                                                                                                                                                                       |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sp1 | P1   | storage 记录正文仍未分类：`auditUnitInterior` 只 lstat 不读，损坏 `{bad json` 与非抽样位置 `version:99` 的 projcache 记录均放行（§5.11 的"全量分类"在表内未兑现） | 每条记录文档都经 `readRecordStamp` 分类（无法解析/无戳记即 unknown）；`session_projcache` 域内钉住 v4——非 v4 戳记即 foreign 并翻转 projcache 槽位（不再出现"内部被 flag 但槽位仍声明 v4"）                 |
| Sp2 | P1   | 任意文件伪装压缩会话：`.zstd` 仅凭扩展名认定，纯文本 `definitely not zstd` 预检 allow                                                                             | `.zstd` 必须以真实 zstd 帧魔数开头（标准 `0xFD2FB528` 或 skippable `0x184D2A50-5F`）才归为已知格式；负例（纯文本拒绝）+ 正例（真实魔数接受）测试在案                                                       |
| Sp3 | P1   | 保留前缀未在命名层收口：`createProfileRef` 接受 `.dsh-desktop-run-user`，合法 profile 可借豁免前缀绕过 manifest 分类                                              | `createProfileRef` 拒绝 `RESERVED_PROFILE_NAME_PREFIX`（`.dsh-desktop-run-`）并给出专错；点号名（`.prod`）仍合法。profile-ref 测试 ×2（拒绝保留前缀、放行普通点号名）                                      |
| Sp4 | P1   | detach 失败得不到重试：`emergencyCleanup` 先清空集合，瞬态失败即丢失；正常结束不排空残留                                                                          | 失败的 cleanup **保留登记**（成功才移除），下次排空重试（行为测试：瞬态失败 cleanup 两次排空调用两次）；新增有界 `beforeExit` 兜底（事件循环安静时至多 3 轮）冲刷残留                                      |
| St1 | P2   | 65,536 是单目录上限不是端到端预算：sessions 可 65,536×65,536 层嵌套放大，unknownPaths 与读字节无共享上界                                                          | 一次勘察共享 `createInspectionBudget`（条目 262,144 / 字节 128MiB / unknown 8,192，可注入测试），任一耗尽把正在走的槽位判 unknown（fail-closed）；预算共享跨槽位有测试。协议文档"端到端有界"措辞与实现对齐 |
| St2 | P2   | 三个"位置无关"测试不能证明旧采样会失败（APFS readdir 不按创建序，损坏项可能落在索引 0，旧实现也会读到）                                                           | 三个测试改为读**原始 readdir 顺序**、改写恰位于旧采样上限（64/32/32）之外的条目——采样一旦复活这些测试必红；另补 projcache v99（原 512 上限之外）与普通域损坏记录两个记录级负例                             |

## 5.13 codex 复审第六轮（2026-09-06，基线 `c9c0e17`）

codex 六审 4 项 Spec + 4 项 Standards，逐条核实**全部属实**，处置如下。

| #   | 级别 | 发现                                                                                                                                        | 处置                                                                                                                                                                                                                                                                                   |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sp1 | P1   | 普通 unit 的记录版本未绑定：`workspace` global v1 + `records/future.json` v99 仍放行——上游 storage 会把版本不符的记录静默当不存在           | unit 的 global 戳记作为锚传入 interior 走查，每条记录必须与之一致；无 global 的 unit 以首条记录锚定、全部记录须一致（混版即拒）。锚定语义有正反测试（global 锚定 + 无锚混版）                                                                                                          |
| Sp2 | P1   | plain 与 zstd 并存时 else-if 跳过 zstd：合法 `session.jsonl` + 损坏 `.zstd` 同目录放行；上游 backend 拒绝双编码                             | 并存即拒绝（flag plain 路径）；测试在案                                                                                                                                                                                                                                                |
| Sp3 | P1   | 保留前缀可从 `dsh-native` 绕过：`createProfileRef` 拒绝但 lease 的 `validateProfile` 不拒，CLI 规划得 `{"profile":".dsh-desktop-run-user"}` | 保留规则上移共享命名契约 `@dsh-desktop/desktop-contracts/profile-name`（新 capability 子路径），`createProfileRef` 与 lease `validateProfile`（CLI 一切 profile 入口的闸门，含无 profile 透传）一并强制；lease 侧新增拒绝测试。lockfile 由 pnpm 生成两条 workspace link（frozen 复核） |
| Sp4 | P1   | detach 吞错使重试失效：注册的 cleanup 捕获 hdiutil 失败正常返回，排空当成功移除；`beforeExit` 注册被已有 listener 整体跳过                  | 注册的 cleanup 改为**报错式**（抛出→排空重新登记重试）；正常路径 quiet-probe 仅成功才注销；`beforeExit` 无条件注册。行为测试入库为回归门禁（`tests/helpers/emergency-cleanup.test.mjs`，vitest include 扩展到 `tests/helpers/*.test.mjs`）                                             |
| St1 | P2   | unknown 预算没限制输出：`unknowns:1` + 20 条坏记录返回 20 条、预算 -19                                                                      | sessions 与 records 内循环每项前查预算，耗尽即以槽位/单元级 unknown 收束遍历                                                                                                                                                                                                           |
| St2 | P2   | 字节预算是读取后记账：剩 1 字节仍按整文件 cap 分配读取                                                                                      | 读取长度改为 `min(fileCap+1, remainingBudget+1)`（readBoundedText/isKnownSessionHeader/帧头验证三处）                                                                                                                                                                                  |
| St3 | P2   | zstd 只验四字节魔数（正例测试本身就是魔数+垃圾）                                                                                            | 升级为 RFC 8878 帧头验证：魔数 + 帧头描述符（保留位为零）+ 描述符声明的 window/dictionary/content-size 字段齐全；截断（FHD 声明 14 字节头只给 10）与保留位非法两负例 + 最小合法帧头正例（`28 B5 2F FD 20 00`）                                                                         |
| St4 | P2   | "行为测试"未提交仓库，验收所称无法作为回归门禁                                                                                              | 入库为 `emergency-cleanup.test.mjs` 三个用例：失败重试/排空不中断/子进程验证 beforeExit 有界退出                                                                                                                                                                                       |
| St5 | P2   | 位置测试用 `readdir()`、实现用 `opendir()`，两次顺序无 API 契约保证（较低风险）                                                             | 三个位置测试改用与实现相同的 `boundedEntries()` 取序                                                                                                                                                                                                                                   |

## 5.14 zcode 五轮独立自查（2026-09-07，基线 `92f41fe`，交 codex 七审前）

按对抗审查协议执行五轮（每轮独立攻击者模型、优先攻击第六轮最新修复），1 项真缺陷 + 4 项加固：

| 轮  | 攻击者模型                                  | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 数据布局：上游真实序列化形态 vs 勘察假定    | **对齐**。`dsh-storage-json` 源码核实：`serializeRecord` 写 `{version,record}`、单文件 unit 写 `{unit:{name,version}}`、`SESSION_FORMAT_VERSION=0`；真实 `zstdCompressSync` 输出（单帧+多帧）实测过闸（真实帧头 `28b52ffd20…` 与实现假定吻合）。加固：真实压缩输出的回归测试入 preflight 套件（手构字节可能漂移于真实 writer）。另核实锚定逻辑与真实形态不冲突（global 由上游恒以 descriptor.version 写、与记录恒一致；undeclared-table 残留内部一致不误拒）                                          |
| R2  | lease/进程：冻结旧制品反向共存 + 身份链入口 | **评估+文档化**。镜像风险确认：M3 冻结 DMG 的旧 helper 整串比较会把 M4 新格式活 owner 判 `different`，其 doctor 可能删 M4 活锁——但 M4 每次写在 guard 内校验 generation/身份，锁被删后下一次写即 `LEASE_CHANGED` 拒绝，**不会双写**；最坏=M4 会话报错退出。限制已记入 upgrade-guide §6（升级窗口勿以旧制品 doctor 指向新 home；M3 从未公开分发，限制随其淘汰消失）。另：`switchProfile` 确认走 `validateProfile`（保留前缀覆盖）；`runtime-root` 的 mkdtemp 前缀字面量改用共享常量（防与命名契约漂移） |
| R3  | 测试真实性：断言力与 TS-vs-runtime          | **发现并修复 1 项真缺陷**。把六审补的 beforeExit 行为测试加强为标记文件证明后，暴露出 flush 的失败重试链根本不工作：Node 在 beforeExit handler 只排微任务时**不会再次触发** beforeExit（最小实验证实），失败重登记的 cleanup 永远等不到第二轮。修复：flush 单次激活内自驱动有界重试（50ms timer 保活，至多 3 轮），标记文件测试转绿——失败→重试→成功现在有机器证明。次要：FakeProbe 不模拟旧格式后缀兼容（native 行为由集成测试覆盖），记录不改                                                        |
| R4  | 升级/状态机：演练盲区                       | **发现盲区并补端到端**。演练 fixture 强制 `compression: none`——16/16 全链从未让真实压缩会话过 admission，帧头验证若有 false positive 只有真实 `~/.dsh` 升级才会暴露。现在演练播种一个真实 `zstdCompressSync` 多帧会话（`zstd-seeded-session`），断言升级全程字节不变且 candidate admission 接受它（连同 R1 的单测，字节点与端到端双覆盖）。决策序其余面（marker/disk mismatch 保守拒绝等）核对已有测试覆盖                                                                                            |
| R5  | 证据/验收记录                               | 本节；六轮措辞与实现复核无新偏差，§6 数字以本轮重跑为准                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 5.15 codex 复审第七轮（2026-09-07，基线 `84c45ed`）

codex 七审 5 项 Standards + 3 项 Spec，逐条核实**全部属实**；其中 Sp2 推翻了 §5.14 自查 R2 的"锁被删后不会双写"判断（lease 把守准入而非 Host 运行期写——该判断错误）。处置如下。

| #   | 级别       | 发现                                                                                                                                                  | 处置                                                                                                                                                                                                                                                                                                                             |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sp1 | P1         | 记录正文信封不完整：`{"version":4}` 无 `record` 字段被当合法；无 global 的普通域首条记录自锚、一致的未来版本可自证                                    | `readRecordStamp` 要求完整 `{version, record}` 信封（`record` own key，null 合法——global 即 `record:null`）。自锚边界如实记录：域版本的可信来源是 global 戳记与 projcache 钉 v4；无 global 域内部一致即过是可达边界（域清单由 provider 动态决定，勘察器无法静态枚举 descriptor）                                                 |
| Sp2 | P1         | "M3 doctor 删 M4 锁后不会双写"不成立：`assertHeld` 只在启动链路调用，Host 授权后的数据写不查 lease；锁被删后旧 Host 继续写、新入口再进 → 真实双写窗口 | **lease watchdog**（`84f2503`）：supervisor 与 bundled CLI 在 Host/子进程运行期周期性 `assertHeld()`（默认 2s；guard 竞争不计、连续两次非竞争失败处决 Host/子进程并报 `LEASE_MISMATCH`），双写窗口压缩到至多一个监视周期。ADR-0005 修订、upgrade-guide 撤回错误宣称改为 watchdog 语义。supervisor 15/15 单测含两个 watchdog 用例 |
| Sp3 | P1         | 截断 skippable 帧放行：只查读到 8 字节，声明 `0xffffffff` payload 的 8 字节文件仍过                                                                   | 声明长度与 stat 实际大小核对（零读成本）；且会话流必须最终包含标准帧——纯 skippable 流拒绝。负例（8 字节声明巨量）、正例（诚实 skippable 前缀 + 真实标准帧）、纯 skippable 拒绝三测试在案                                                                                                                                         |
| Sp4 | P1（等价） | §5.14 的 zstd 端到端是空证明（§5.14 自查 R4 的实现缺陷被七审确认）                                                                                    | 见 St1——本轮重建为独立 admission 步骤后已真实过闸（首轮重建仍失败两次：上游 backend 拒绝在 none 配置 home 上 LIST .zstd artifact——最终形态是独立副本 + `--version` 透传探针：同一只读 admission 链、exit 5 拒/0 放、字节不变断言）                                                                                               |
| St1 | P1         | zstd 会话种在已存在 session 目录的**子目录**（admission 不下钻该层），"字节不变"只证明被忽略的文件未变                                                | 重建：独立副本 + 透传探针（见 Sp4 行）。教训入记忆：**证据必须证明被检查，而非仅仅存在**                                                                                                                                                                                                                                         |
| St2 | P1         | SIGINT/SIGTERM 单次排空后 `process.exit(130)`——显式退出不触发 beforeExit，瞬态失败仍泄漏                                                              | 所有持有退出的路径改为 `drainWithRetries()` **完成后**再 exit；SIGINT 行为测试（标记文件在 130 退出前写出的机器证明）在案                                                                                                                                                                                                        |
| St3 | P2         | unknown 输出预算仍超额：`unknowns:1` + 多坏记录返回 3 条、余额 -19                                                                                    | `flagUnknown` 预算守卫（耗尽即不再追加）；输出恰被预算上界的测试在案                                                                                                                                                                                                                                                             |
| St4 | P2         | "至多三轮"实际可达九次（外层 3 次 beforeExit × 内层 3 drain）                                                                                         | 轮次预算**进程级共享**（`drainRoundsUsed`，信号与 beforeExit 同池，总数 ≤3）                                                                                                                                                                                                                                                     |
| St5 | P2         | 位置测试用一次 opendir 选植入位、实现重新开目录——两次顺序无 API 契约，旧采样可假绿                                                                    | 三个测试改**全量植入**（72/40/40 条目全坏、断言全部被抓）——与顺序无关，采样复活必红                                                                                                                                                                                                                                              |

## 6. 门禁结果

**最终轮（§5.15 全部处置后，2026-09-07）**：`pnpm verify:release` 聚合链于**制品 HEAD `6fe04f5`** 实跑（`set -o pipefail` 下退出码 0），**13 步全部通过**（含收尾 `git diff --check`）：check（358 Vitest 单测 + 36 文档校验）→ generate:compatibility → verify:dsh-closure（921 条）→ verify:patches → test:integration（80 测试，9 文件，含旧格式身份兼容）→ test:shared-home（4 测试，真实原生 helper 身份链）→ package:dir → verify:compatibility（fresh staging 字节一致）→ package:dmg → verify:artifacts → smoke:package（**15/15 场景**）→ candidate 归档 + `rehearse:upgrade`（**16/16 步**：`storage-inner-symlink` 负例命中 CLI exit 5；重启轮续写播种会话并字节级验证三轮原文标记）→ git diff --check。全链日志中 `probe: different` 与留锁零出现。本文件随后的 docs 提交（如本节本身）不改代码与制品，制品绑定 `6fe04f5`。演练本轮起含独立的 zstd admission 步骤（17 步）。

前几轮（2026-09-06）：`fd9a23a` 13/13+16/16；`b595907` 轮 smoke 14/15 → 触发根因排查；`ead506d` 13/13+16/16+15/15；`5ae6db2`/`434d214`/`f782c02`/`e213fbf` 均 13/13。均被 §5.15 轮取代，记录保留于 git 历史。

链语义：任一步失败即中止；`package:dir` 必须先于 `verify:compatibility`/`package:dmg`（staging 在当前 HEAD 重建后才可比对/封装，否则会把陈旧 staging 打进 DMG——该排序缺陷由链自身首跑暴露并修复，见 §5.6）。

## 7. 制品记录（最终 verify:release 轮）

| 项                             | 值                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| candidate releaseId            | `m4-0.0.0-darwin-arm64-6fe04f5`，DMG SHA `697cb8828de9b88526d3989bbd62aa33e178fe5fd518fd47e09e742e3b5a843f`（绑定 §5.15 轮全部代码提交，docs 提交前） |
| previous（保留的上一健康制品） | M3 `m3-0.0.0-darwin-arm64-f972354`，DMG SHA `f93873b0ef95b9b0c1c36218d40213fbd3a3dda5bd40f88247dc7dd929618ff9`，归档于 `release/previous/`            |
| 本地补丁                       | 零（`patches/manifest.json` 显式空账本；运行时闭包为纯官方上游 npm 制品）                                                                             |
| 架构                           | darwin-arm64（唯一实际构建并运行的架构；darwin-x64 未构建不进支持矩阵）                                                                               |

## 8. 交付状态与剩余条件

- 自动测试完成 → **`candidate-verified`**（§5.15 轮全部处置后于制品 HEAD `6fe04f5` 重验通过，2026-09-07）。
- **`current`（日用版）的最后放行条件：jesen 至少完成一个正常工作日的人工使用观察**（启动、退出、会话继续、托盘/恢复体验）。观察完成前不标记 current，不伪造。
- 未验证项/剩余风险：
  - 真实跨上游版本的升级演练未执行（上游 alpha.4+/rc.1 已发布；须独立 `codex/upgrade-dsh-<tag>` 分支）。
  - darwin-x64 未构建。
  - 公开发行（Developer ID 签名/notarization/自动更新）不在 v1 范围。
  - 人工观察周期未开始（见上）。
