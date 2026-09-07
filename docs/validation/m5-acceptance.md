# M5 验收记录：发行证据与插件引入

- **状态：已验收——SBOM、许可证清单、统一发行证据与合成插件引入全部交付并在安装制品级验证；运行时行为零改动**
- 日期：2026-09-08（通宵自主执行）
- 基线：rc.1 资格验证 GO 后的 `main` @ `260bf9e`
- 分支：`feat/m5-release-evidence`（提交 `00ed80c` → `2e32ff0`）
- 执行计划：[M5 Release Evidence and Plugin Intake](../superpowers/plans/2026-09-07-m5-release-evidence.md)
- 范围冻结：[m5-scope-review](m5-scope-review.md)

## 1. 执行环境

- macOS 26（darwin 25.6.0，arm64）、Node 24.11.1 / pnpm 11.7.0（Corepack）、Electron 44.1.0、DSH 0.1.2-rc.1（见 [rc.1 验收](dsh-0.1.2-rc.1-acceptance.md)）

## 2. 交付内容（对照计划 Task 1–6）

| 任务 | 交付                                                                                                       | 提交                |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------- |
| 1    | 范围冻结：证据矩阵（已覆盖面 vs 四项缺口），明确拒绝第二健康状态机/第二兼容清单/投机制坏场景                     | `00ed80c`           |
| 2    | 确定性 SBOM：`collectClosureComponents`（双层 pnpm deploy 闭包遍历、purl 去重、注册表包强制 lockfile integrity、工作区包按部署文件摘要、逃逸 symlink 拒绝）+ `createCycloneDx`（CycloneDX 1.6，无时间戳/绝对路径）+ `generate:release-evidence` | `5cf3b2a`、`91508bf` |
| 3    | 许可证清单：逐包 purl、声明 SPDX 或 `NOASSERTION`、包内许可证文件名 + SHA-256；不嵌全文、不推断、不宣称合规       | `0fd49df`           |
| 4    | 统一证据 `release-evidence.json` + `verify:release-evidence`：源提交/releaseId/DMG 摘要/平台架构/内嵌清单摘要/运行时版本/SBOM/许可证/冒烟结果绑定同一候选；四个身份负例（陈旧冒烟/错误架构/替换制品/缺失组件）各自命中专属错误码；门禁接入 verify:release 链（冒烟之后、归档/演练之前） | `5d3d588`、`2e32ff0` |
| 5    | 合成插件引入：声明式记录 + 纯校验器（出处/身份/版本/摘要漂移、singleton 依赖、生命周期脚本、平台证据全部硬拒）+ 制品级隔离演练 + [工作流文档](../plugin-intake.md) | `27e237a`           |
| 6    | 本记录 + 状态更新（见 §5）                                                                                  | 见最终 docs 提交    |

## 3. 门禁结果（最终轮，HEAD `2e32ff0`）

| 命令                                | 结果                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `pnpm check`                        | 全绿（单测 402、含 release-evidence 11 + plugin-intake 8、文档 45） |
| `pnpm verify:release`               | **15/15 步**（含新证据门两步），退出码 0                     |
| `pnpm verify:plugin-intake`         | 制品级演练通过（见 §4.4）                                    |
| `git diff --check`                  | 通过                                                        |

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
