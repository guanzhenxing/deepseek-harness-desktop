# Upstream Baseline

- 相关决策：[ADR-0001](adr/0001-build-own-native-dsh-shell.md)、[路线图](roadmap.md)、[兼容性清单](compatibility.json)
- 机器可读事实：[build/upstream-artifacts.json](../build/upstream-artifacts.json)、[build/compatibility-policy.json](../build/compatibility-policy.json)
- 校验门禁：`pnpm verify:dsh-closure`（lockfile/清单侧）、`pnpm verify:runtime-tree`（staged 闭包侧）、`pnpm verify:patches`（补丁账本）

## 1. DSH 基线

| 事实        | 值                                                         |
| ----------- | ---------------------------------------------------------- |
| 上游 tag    | `dsh-v0.1.2-rc.1`                                          |
| 上游 commit | `a66e4702047846cdaa10c66c9d3df3951f5ea70d`                 |
| npm 版本    | `0.1.2-rc.1`                                               |
| 消费方式    | 官方 npm 发布包，逐包精确 pin；零 fork release、零本地补丁 |

证据链接：

- Tag：<https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-rc.1>
- Commit：<https://github.com/deepseek-ai/deepseek-harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d>
- npm tarball：<https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.2-rc.1.tgz>（integrity 记录于 upstream-artifacts，lockfile 逐包 integrity 由 `verify:dsh-closure` 对照）

红线：DSH 包逐包精确 pin；catalog/overrides/lockfile 由脚本校验，禁止手工漂移；历史本地补丁不自动继承。

## 2. 独立版本包与 singleton

| 包                    | 版本           | 分类                                                                                |
| --------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `@deepseek-ai/cordis` | `4.0.2`        | 独立版本轴，**不是** DSH 版本；按本表声明值检查，绝不按 `@deepseek-ai/*` 前缀推断   |
| `react`               | `18.3.1`       | 第三方 UI singleton，版本随上游 peer 约束记录                                       |
| `@deepseek-ai/dsh`    | `0.1.2-rc.1`   | DSH runtime 本体                                                                    |

singleton 规则：整个闭包（lockfile 与每个 staged closure）中每个受监视包只允许一个版本；Host runner（host-supervisor）与 normal bundle（desktop-plugin）是解析锚点，实测必须解析到同一 store 实例。Safe Mode bundle（desktop-recovery-bridge）由 Host 的 cordis loader 加载、自身零 Node import——它的保证来自闭包级唯一性 + 必备文件清单（含 `cordis.patch.yml`），不做解析探测。Node CLI 与 Electron Host 允许各持一份依赖树，但 native ABI 分别以 bundled Node / Electron 验证（`verify-runtime-tree`），两闭包间禁止 symlink 逃逸。

## 3. 本地补丁账本（三问审查）

[patches/manifest.json](../patches/manifest.json) 是显式空数组：本项目当前**没有任何本地补丁**，运行时闭包是纯上游 npm 制品。因此三项审查（上游是否已修、能否干净应用、移除补丁是否复现失败）对每个条目空缺；`verify:patches` 校验账本 schema、字段完整性与 baseline commit 绑定。引入任何补丁前必须先补齐 `id/file/upstreamCommit/reason/testCommand/status` 并附回归测试证据。

## 4. 基线升级流程

上游升级只由真实信号触发（新 tag、影响本项目的 bug/安全问题/格式变化、真实使用需求），不由任何外部桌面项目的节奏代替判断。出现新 tag 时：

- 真实升级在独立候选分支 `upgrade-dsh-<实际标签>` 上更新 tag/commit/闭包并演练，与功能分支严格隔离；流程见[升级指南 §5](upgrade-guide.md)；
- 演练以已验证基线制品（冻结于 `release/baselines/`）→ 新候选完成：历史保留、第三方 bundle 不被触碰、降级/未知格式拒绝负例必须通过；
- 升级失败不阻塞其他交付，回退保留已验证基线；
- 涉及不可逆数据迁移的上游版本（例如改动 Session 持久化所有权并写入 Session v2 的版本线）属后续独立迁移资格计划，不并入常规升级。

## 5. 工具链出处

| 工具     | 版本    | 出处与校验                                            |
| -------- | ------- | ----------------------------------------------------- |
| Node     | 24.11.1 | nodejs.org 官方 SHASUMS256.txt 逐项核对（staging 时） |
| pnpm     | 11.7.0  | npm 官方 tarball + 固定 integrity（stage-runtime）    |
| Electron | 44.1.0  | launcher devDependency，经 pnpm-lock integrity 解析   |
