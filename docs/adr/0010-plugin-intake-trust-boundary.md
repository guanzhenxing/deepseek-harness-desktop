# ADR-0010：插件引入（Plugin Intake）信任边界与持久记录 schema

- 状态：已接受（2026-09-08，M5 Task 5 交付；codex 复审后补记本 ADR）
- 关联：[plugin-intake 工作流](../plugin-intake.md)、[M5 验收记录](../validation/m5-acceptance.md)、[ADR-0009 home 兼容准入](0009-home-compatibility-admission.md)

## 背景

M5 引入了第三方 bundle 进入产品信任边界的正式流程：声明式 intake 记录（`schemaVersion: 1`）+ 纯校验器（`scripts/plugin-intake.mjs`）+ 制品级隔离演练（`pnpm verify:plugin-intake`）。这是一个新的信任边界与持久化 schema，按仓库规范需 ADR 记录决策。

## 决策

1. **引入是审查，不是安装**。intake 记录描述一个 bundle 的身份（npm 名/版本）、出处（repository + 40-hex commit）、逐字节摘要（`sha256-<base64url>` 目录摘要算法：排序相对路径 + NUL + 文件 SHA-256 hex + LF，排除顶层 `*.intake.json`）、SPDX 声明、能力清单与已验证平台。记录通过校验不改变任何用户 profile。
2. **硬性拒绝项**：出处非 repository；身份/版本漂移；摘要漂移；bundle 自带 singleton 依赖（react/cordis/dsh）；安装期生命周期脚本；无当前平台打包证据；bundle 内 symlink/特殊文件。全部 fail-closed。
3. **持久 schema**：`schemaVersion: 1`，封闭字段集；演进只做 additive，`schemaVersion` 2+ 的记录被现版本拒绝（与 home marker 同一纪律）。
4. **打包级演练验证 staged 字节、加载器输入与 profile 可启动性**：经候选制品自己的 `plugin add` 流程装入全新临时 profile 后，对 staged 目录复验摘要，断言加载器将导入的 bundle 模块（`main: index.js` + 惰性 `apply()`，无副作用以保摘要确定）与 profile 补丁层存在且引用该 bundle，并**在该 intake profile 上经候选 CLI 完成一个真实回合**——这是 fail-closed 必经门：回合失败（含超时）即整条命令失败。rc.1 基线上游缺陷（全新非模板 profile 无插件也崩溃 exit 1；装入 bundle 后挂起）使该门当前保持失败（已在候选 `29cee57` 复现）；上游修复后该门自动生效为"插件可启动"的最终证明。Host 图上的加载行为由 host-runner 集成测试独立覆盖。
5. **信任来源**是记录中的出处 commit 与逐字节摘要 + 人工审查；本产品不引入远程注册表、市场或签名链（v1 范围外）。

## 后果

- 引入一个真实第三方 bundle 的流程：建记录（`bundleDigest()` 计算）→ 人工审查 → 隔离校验 → 制品级演练 → 入册；四步任何一步失败都不得装进用户 profile。
- 校验器永远只读；演练只用临时 home/profile/安装副本。
- 摘要算法与 `release-evidence` 的目录摘要共用同一确定性定义；两处修改必须同步。

## 拒绝的替代方案

- **自动安装/启用**：拒绝——引入的产出是"具备被安装资格"，安装动作属于用户。
- **以 lockfile/integrity 代替目录摘要**：拒绝——bundle 以目录形态进入 profile，逐字节目录摘要才是被校验物。
- **远程信誉系统**：拒绝——v1 无远程面。
