# M5 范围冻结：从既有证据推导的交付面

- 日期：2026-09-07
- 状态：范围冻结（rc.1 资格验证已 GO——运行时基线 `dsh-v0.1.2-rc.1`，输入候选 `m4-0.0.0-darwin-arm64-61c4b8c`，见 [rc.1 验收记录](dsh-0.1.2-rc.1-acceptance.md)）
- 执行计划：[M5 Release Evidence and Plugin Intake](../superpowers/plans/2026-09-07-m5-release-evidence.md)
- 上游设计：[Post-M4 Delivery Design](../superpowers/specs/2026-09-07-post-m4-delivery-design.md)

## 1. 证据矩阵（已覆盖面 vs M5 增量）

| 主题                     | 既有证据                                                                                                                                                                                                                         | 状态     | M5 增量 | 验收命令                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- | ---------------------------------------------------- |
| Host/CLI/Web/helper 必备文件 | `verify:runtime-tree`（staging 树必备文件清单 + symlink 逃逸拒绝，`scripts/verify-runtime-tree.mjs`），在 `package:dir` 与 `verify:release` 链内强制执行                                                                              | 已覆盖   | 无      | `corepack pnpm@11.7.0 verify:runtime-tree`           |
| native ABI 双运行时加载   | `verify:runtime-tree`（Electron Host 闭包与捆绑 Node CLI 闭包分别做 ABI 加载验证）                                                                                                                                                  | 已覆盖   | 无      | 同上                                                  |
| singleton/peer 闭包       | `verify:dsh-closure`（lockfile 侧：baseline 漂移、浮动 specifier、singleton 唯一性、Cordis/React 独立轴、override 精确性、清单闭包摘要绑定）+ `verify:runtime-tree`（staged 侧双锚点解析）                                       | 已覆盖   | 无      | `corepack pnpm@11.7.0 verify:dsh-closure`            |
| 已安装 DMG 的启动/会话/恢复/导航/关停/共享家 | `smoke:package` 16 场景（dsh-ui、loading-page、host-crash、navigation、lifecycle、auth、conversation、shared-home、cli-version、cli-busy、cli-doctor、cli-plugin、recovery、controller-recovery/admission/safemode），M3/M4 验收记录归档 | 已覆盖   | 无      | `corepack pnpm@11.7.0 smoke:package`                 |
| DMG 与内嵌清单摘要绑定     | `rehearse:upgrade` 的 `artifact-digests`/`embedded-manifests` 步（索引钉 SHA + 安装后内嵌清单摘要/releaseId 复核 + 损坏 DMG 负例）；`verify:artifacts`                                                                                       | 已覆盖   | 无      | `corepack pnpm@11.7.0 rehearse:upgrade -- --previous <冻结基线> --candidate release/candidate/artifacts.json` |
| 升级/重启/第三方 bundle 保留/降级拒绝 | rc.1 资格验证的强化演练（标题跨版本保留、epoch 1 + projcache v4/v5 混存断言、M4 拒收 rc.1 写过的家、4 类拒绝负例 + 桌面端拒绝）                                                                                                                | 已覆盖（rc.1 轮） | 无 | 同上                                                  |
| 依赖清单（SBOM）          | 无——lockfile/staging 各自可查，但没有单一可验证的 CycloneDX 投影                                                                                                                                                        | **缺口** | 任务 2  | `corepack pnpm@11.7.0 generate:release-evidence` + `verify:release-evidence` |
| 许可证清单               | 无——上游包自带 LICENSE 但无逐包盘点与摘要                                                                                                                                                                            | **缺口** | 任务 3  | 同上                                                  |
| 统一发行证据身份          | 部分——artifacts.json/package-smoke.json/compatibility.json 分散存在，互相之间的身份一致性靠链顺序隐式维持，没有一个把源提交/DMG/内嵌清单/SBOM/许可证/冒烟结果绑到同一候选的反向验证器                                                                       | **缺口** | 任务 4  | `corepack pnpm@11.7.0 verify:release-evidence`（含 4 个负例） |
| 插件引入流程             | 无——第三方 bundle 只有"用户手工放置后不被破坏"的负向保证，没有正向的引入审查记录与隔离演练                                                                                                                                                 | **缺口** | 任务 5  | `corepack pnpm@11.7.0 verify:plugin-intake`          |

## 2. 保留的 M5 增量（仅此四项）

1. **SBOM 生成**（任务 2）：从 staged Host/CLI 闭包生成确定性 CycloneDX 1.6 JSON（无时间戳、无绝对路径、重复生成字节相同）。
2. **许可证清单生成**（任务 3）：逐包记录 purl、声明 SPDX 或 `NOASSERTION`、包内许可证文件名与 SHA-256；不嵌入全文、不宣称合规。
3. **统一证据身份验证**（任务 4）：`release-evidence.json` 把源提交、releaseId、DMG 摘要、内嵌兼容清单摘要、平台/架构、运行时版本、SBOM/许可证/冒烟摘要绑到同一候选；`verify:release-evidence` 拒绝陈旧冒烟、错误架构、被替换制品、缺失证据组件（四个负例各自命中专属错误码）。
4. **合成插件引入记录与隔离演练**（任务 5）：声明式 intake 记录 + 纯校验器 + 独立 profile 的打包制品级演练；引入不等于安装或启用。

## 3. 明确拒绝的范围扩张

- **第二套健康状态机**：拒绝。进程/恢复/健康语义已由 M1-M2 控制器与恢复链拥有；证据层只投影事实，不产生第二套状态判断。
- **第二份兼容性清单**：拒绝。`docs/compatibility.json`、`build/compatibility-policy.json`、`build/upstream-artifacts.json`、lockfile 与内嵌清单是唯一的版本/格式权威；`release-evidence.json` 是投影，不是权威。
- **投机制坏场景**：拒绝。损坏 marker、外来 storage 格式、epoch 越界等 fail-closed 行为已有门禁与演练负例覆盖；证据层不为未定义的损坏形态发明新场景。

## 4. 基线决定

rc.1 资格验证已 GO（2026-09-08，`260bf9e` 合入 main）：M5 输入为候选 `m4-0.0.0-darwin-arm64-61c4b8c`（`release/candidate/artifacts.json`，DMG SHA `a7326ccb…`，内嵌清单 SHA `332ae0a8…`）。回退基线 M4 `caa5c51` 冻结于 `release/baselines/m4-caa5c51/`。
