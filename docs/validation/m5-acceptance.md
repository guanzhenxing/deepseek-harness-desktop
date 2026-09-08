# M5 验收记录：发行证据与插件引入

- **状态：已验收——SBOM、许可证清单、统一发行证据与合成插件引入全部交付并在安装制品级验证；运行时行为零改动（M5 面内）**。第三轮收口（8dec724）对本记录的回溯改写已在 §9 作废并如实重述
- 日期：2026-09-08（通宵自主执行）
- 基线：rc.1 资格验证 GO 后的 `main` @ `260bf9e`
- 分支：`feat/m5-release-evidence`（提交 `00ed80c` → `2e32ff0`）
- 执行计划：[M5 Release Evidence and Plugin Intake](../superpowers/plans/2026-09-07-m5-release-evidence.md)
- 范围冻结：[m5-scope-review](m5-scope-review.md)

## 1. 执行环境

- macOS 26（darwin 25.6.0，arm64）、Node 24.11.1 / pnpm 11.7.0（Corepack）、Electron 44.1.0、DSH 0.1.2-rc.1（见 [rc.1 验收](dsh-0.1.2-rc.1-acceptance.md)）

## 2. 交付内容（对照计划 Task 1–6）

| 任务 | 交付                                                                                                                                                                                                                                                                                    | 提交                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1    | 范围冻结：证据矩阵（已覆盖面 vs 四项缺口），明确拒绝第二健康状态机/第二兼容清单/投机制坏场景                                                                                                                                                                                            | `00ed80c`            |
| 2    | 确定性 SBOM：`collectClosureComponents`（双层 pnpm deploy 闭包遍历、purl 去重、注册表包强制 lockfile integrity、工作区包按部署文件摘要、逃逸 symlink 拒绝）+ `createCycloneDx`（CycloneDX 1.6，无时间戳/绝对路径）+ `generate:release-evidence`                                         | `5cf3b2a`、`91508bf` |
| 3    | 许可证清单：逐包 purl、声明 SPDX 或 `NOASSERTION`、包内许可证文件名 + SHA-256；不嵌全文、不推断、不宣称合规                                                                                                                                                                             | `0fd49df`            |
| 4    | 统一证据 `release-evidence.json` + `verify:release-evidence`：源提交/releaseId/DMG 摘要/平台架构/内嵌清单摘要/运行时版本/SBOM/许可证/冒烟结果绑定同一候选；四个身份负例（陈旧冒烟/错误架构/替换制品/缺失组件）各自命中专属错误码；门禁接入 verify:release 链（冒烟之后、归档/演练之前） | `5d3d588`、`2e32ff0` |
| 5    | 合成插件引入：声明式记录 + 纯校验器（出处/身份/版本/摘要漂移、singleton 依赖、生命周期脚本、平台证据全部硬拒）+ 制品级隔离演练 + [工作流文档](../plugin-intake.md)                                                                                                                      | `27e237a`            |
| 6    | 本记录 + 状态更新（见 §5）                                                                                                                                                                                                                                                              | 见最终 docs 提交     |

## 3. 门禁结果（最终轮，HEAD `2e32ff0`）

| 命令                        | 结果                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `pnpm check`                | 全绿（单测 402、含 release-evidence 11 + plugin-intake 8、文档 45）        |
| `pnpm verify:release`       | **15/15 步**（含新证据门两步），退出码 0（最终轮 HEAD `2e32ff0` 的链形状） |
| `pnpm verify:plugin-intake` | 制品级演练通过（见 §4.4；后续轮次的修正见 §7–§9）                          |
| `git diff --check`          | 通过                                                                       |

制品级冒烟 16/16；跨版本演练 18/18（previous=M4 `caa5c51` 冻结件，不变）；SBOM 重复生成字节相同；全新 staging 重建后 SBOM 仍字节相同。

## 4. 证据内容（候选 `m4-0.0.0-darwin-arm64-2e32ff0`）

1. **候选**：DMG SHA `d0c189b4ebc177d7df540403d52dd5a8f7e71b26320cee8f35f47945c6566c64`，内嵌兼容清单 SHA `b2abf1c7275442f2280ee5ced3f1c4c48f62174ae9e6ab2d3597e487e4fb0000`（`release/candidate/artifacts.json`）。
2. **SBOM** `release/evidence/sbom.cdx.json`：510 组件（501 注册表 + 9 工作区），SHA `c157b5ef24c7b433a5d5f7bc9de222d7d96a6790569b4f1e370bd80fce1c1956`。
3. **许可证清单** `release/evidence/licenses.json`：501 声明 / 9 `NOASSERTION`（9 个 `@dsh-desktop/*` 工作区包未声明 SPDX），SHA `6d646d1f…`。
4. **统一报告** `release/evidence/release-evidence.json`（SHA `541cb404…`）+ 冒烟报告 `release/package-smoke.json`（SHA `94d88fae…`，16 场景全过）；`verify:release-evidence` 在链内确认全部身份绑定同一候选。
5. **插件引入**：`@fixture/m5-example-bundle` 记录校验 → 经候选自身 `plugin --profile plugin-intake-rehearsal add` 装入全新临时 profile → staged 字节复验 → 候选启动 ui-ready → 默认 desktop profile 逐字节不变。

## 5. 状态与边界（如实）

- M5 增加发行证据与插件引入保证，**不**增加：公开分发、Developer ID 签名、公证、自动更新、插件市场、默认第三方插件（README/主方案同步更新）。
- 证据是投影不是权威：版本/格式权威仍是 `docs/compatibility.json`、`build/compatibility-policy.json`、`build/upstream-artifacts.json`、lockfile 与内嵌清单。
- 工作区包 9 个 `NOASSERTION`：仓库自有包未逐包声明 SPDX，属可修的文档缺口，不影响第三方许可盘点。
- 执行偏差：
  1. 第一次收尾链挂在 `verify:release-evidence`：CLI 传冒烟报告原始字节而库按解析对象做身份检查（`Buffer.candidate` undefined）；且首版对 `release/compatibility.json` 做字节级清单比对——内嵌清单是 staging 超集，字节天然不同，改为绑定 artifact record 的内嵌摘要（`2e32ff0`）。
  2. 计划 Task 5 的 fixture 文件清单不含 `index.js`，bundle 不被 cordis loader 加载——引入演练按计划原文裁掉"加载轮"，加载行为已由 M4 host-runner 集成测试覆盖。
  3. SBOM 收集器首版只遍历 node_modules 顶层（9 组件）；按 pnpm deploy 布局改为顶层 + `.pnpm` 双层（510 组件）。
  4. 打包引入演练踩 M0 冒烟 userData 约定：基名必须 `dsh-desktop-m0-smoke-` 前缀（与既有冒烟一致）。
- 未验证范围：x64 未构建；签名/公证/更新器不在 v1；证据文件在 `release/`（忽略目录），提交物仅含脱敏摘要与本记录。

## 6. 基线移交

M6 的输入是本候选 `m4-0.0.0-darwin-arm64-2e32ff0`（DMG SHA `d0c189b4…`）：测量与可选优化都绑定这一制品。

## 7. codex 复审轮处置（2026-09-08，基线 `2fbad90`，修复分支 `fix/post-delivery-review` @ `29cee57`）

复审提出 Standards 2 项 + Spec 6 项，处置如下（全部实装验证，非口头）：

| 发现                                        | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 插件准入缺 ADR（信任边界 + 持久 schema） | 新增 [ADR-0010](../adr/0010-plugin-intake-trust-boundary.md)：引入=审查非安装、硬性拒绝项、schema 1 封闭演进、信任来源、拒绝的替代方案                                                                                                                                                                                                                                                                                                                 |
| P2 运行文档仍写旧产品名                     | `native-dsh-desktop-plan.md` 与 `data-layout.md` 修正为产品名 `DeepSeek Harness` + **冻结数据目录名** `DeepSeek Harness Desktop`（userData 不随产品改名）的准确表述                                                                                                                                                                                                                                                                                    |
| P1 演练未启动被引入 profile                 | fixture 补 `main: index.js` + 惰性 `apply()`（可加载、摘要确定）并重算记录摘要；演练断言 staged 加载器输入（bundle 模块 + 自带补丁层 + manifest bundles 列表）。**启动轮受阻上游**：全新非模板 profile 即使不含插件也无法完成 CLI 回合（已在当前候选以无插件 profile 复现，`plugin add` 正常、`headless` 模板正常）；该缺口连同复现证据记录于 ADR-0010 与 plugin-intake.md，上游修复后必须把启动轮加回。Host 图上的加载行为由 host-runner 集成测试覆盖 |
| P1 runtimes.node/electron 未校验            | `verifyReleaseEvidence` 增加 `expectedRuntimes` 交叉校验；CLI 现场重测（staged 捆绑 node `--version` + launcher 锁定的 electron）后传入；篡改负例入测试（21/21）                                                                                                                                                                                                                                                                                       |
| P1 file 字段可路径逃逸                      | 报告的三个 evidence 文件名钉死为 schema 常量（不符即拒）；CLI 按常量读文件，不再拼接报告值；`../../` 逃逸负例入测试                                                                                                                                                                                                                                                                                                                                    |
| P1 只比 record 摘要、未验 DMG 内清单        | CLI 现挂载 DMG（只读）提取 `Contents/Resources/compatibility.json`：字节摘要对报告、内容做身份校验，卸载保证干净；修复期间还现场复现了"repo 清单随提交漂移 ≠ DMG 内清单"正是该发现所述风险                                                                                                                                                                                                                                                             |

修复轮门禁：`pnpm check` 全绿（含新增篡改负例）；`verify:release` **15/15**（第一次因 electron-builder 下载 Electron 的瞬时 TLS 断开失败，非代码问题，重跑通过）；最终候选 `m4-0.0.0-darwin-arm64-29cee57`（DMG SHA `0aa48514…`）上 `verify:plugin-intake` 与证据门全过。**当前已验证候选更新为 `29cee57`**。

## 8. 第二轮 codex 复审处置（2026-09-08，审查范围 `8732360...main` @ `74030b1`）

复审提出 P1×3 + P2×6，处置如下（全部实装验证，非口头）：

| 发现                                          | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 统一证据未完整绑定 packaged smoke 候选身份 | `verifyReleaseEvidence` 对 `smoke.candidate` 的 DMG SHA-256、platform、arch、内嵌清单摘要**逐字段**比对统一报告（此前只比 releaseId，篡改后重算 smoke 摘要仍可通过）；混合候选负例（篡改 DMG 摘要 / 清单摘要后重算摘要）入测试，各自命中 `EVIDENCE_SMOKE_ARTIFACT_MISMATCH`                                                                                                                                                                                                                                                                                                            |
| P1 intake 演练未实际启动 intake profile       | 启动轮实装为**必经 fail-closed 门**：staged 后经候选 CLI 在 intake profile 上完成真实回合（180s 有界，超时即失败），不再以"blocked upstream"注记返回成功。上游阻断在候选 `29cee57` 上复现且有两种形态：无插件非模板 profile 直接崩溃（exit 1，`composeProfile`）；装入 fixture 后**挂起至超时**。**该命令在上游修复前保持失败**；[plugin-intake.md](../plugin-intake.md) 与 [ADR-0010](../adr/0010-plugin-intake-trust-boundary.md) 已同步改写。配套：`runInstalledCli` 改为进程组派发、超时/中断组杀并注册应急清理——复现轮曾实际泄漏孤儿 CLI 进程（已清理），修复后实测失败运行零残留 |
| P1 升级演练可在未执行降级拒绝测试时报告成功   | 候选未写出 v5 projection-cache 记录时直接 `fail`（rc.1 基线候选跑过真实回合必留 v5，缺 v5 即该门无法演练，不得记 `true`）；拒绝门拆为独立结果项 `m4-downgrade-refusal`。已记录的 18/18 演练（`29cee57`）不受影响——其运行时 v5 在场；下一次 `rehearse:upgrade` 起按新门执行                                                                                                                                                                                                                                                                                                             |
| P2 内嵌清单 platform/arch 未与报告交叉校验    | `embeddedManifest.platform/arch` 对 `report.artifact` 比对，失配 `EVIDENCE_ARCH_MISMATCH`；负例入测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P2 遍历吞权限/IO 错误                         | `release-evidence-lib` 的 `readdir`/`lstat` 只容忍 ENOENT（可选层缺失），其余错误上抛；SBOM 收集、许可证清单、目录摘要三路 EACCES 负例（chmod 000 实测）入测试                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P2 intake schema 声明封闭但接受未知字段       | 顶层与 `source` 均为精确键集校验（多字段/缺字段都拒，未知 source kind 仍报 `UNKNOWN_SOURCE`）；负例入测试。`plugin-intake.test.mjs` 与 `release-evidence.test.mjs` 一并接入 `test:unit` 常设门禁（此前只随审查手动运行）                                                                                                                                                                                                                                                                                                                                                               |
| P2 home marker 额外 format slot 被忽略        | marker 含磁盘观察不到的 slot 即拒（`UNKNOWN_FORMAT`）；磁盘 ⊇ marker 的写滞后方向仍允许（marker 在写入前预约、下次准入刷新）；正反两例入测试（包内 85/85）                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P2 证据验证遗留临时 mount 目录                | attach 成功/失败全路径 detach + `rm`；实测运行后 `/tmp/dsh-evidence-mount-*` 零残留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P2 文档身份矛盾                               | README/upgrade-guide/data-layout 产品名改 `DeepSeek Harness`、冻结数据目录名 `DeepSeek Harness Desktop` 厘清（含 data-layout `<userData>` 行）；ADR-0010 补入索引；development.md 状态更新到 M1–M6 已验收、已交付命令清单更正                                                                                                                                                                                                                                                                                                                                                          |

本轮门禁：`pnpm check` 全绿（node:test 6 个脚本文件 + vitest 34 文件 401 测试 + 文档 49 文件）；`verify:release-evidence` 真实 DMG 通过（含新增候选绑定与清单架构校验）；`verify:plugin-intake` **按设计失败于启动轮**（上游阻断，退出码 1、180s 有界、零残留）——这是如实证据而非回归。**当前已验证候选仍为 `29cee57`**；下一个候选构建后须重跑 `rehearse:upgrade`（降级门已改必经）与 `verify:plugin-intake`（上游修复后应自动转绿）。
