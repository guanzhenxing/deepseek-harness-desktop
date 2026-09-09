# ADR-0010：插件引入（Plugin Intake）信任边界与持久记录 schema

- 状态：已接受（2026-09-08）
- 关联：[plugin-intake 工作流](../plugin-intake.md)、[ADR-0009 home 兼容准入](0009-home-compatibility-admission.md)

## 背景

本项目为第三方 bundle 进入产品信任边界定义了正式流程：声明式 intake 记录（`schemaVersion: 1`）+ 纯校验器（`scripts/plugin-intake.mjs`）+ 制品级隔离演练（`pnpm verify:plugin-intake`）。这是一个新的信任边界与持久化 schema，按仓库规范需 ADR 记录决策。

## 决策

1. **引入是审查，不是安装**。intake 记录描述一个 bundle 的身份（npm 名/版本）、出处（repository + 40-hex commit）、逐字节摘要（`sha256-<base64url>` 目录摘要算法：排序相对路径 + NUL + 文件 SHA-256 hex + LF，排除顶层 `*.intake.json`）、SPDX 声明、能力清单与已验证平台。记录通过校验不改变任何用户 profile。
2. **硬性拒绝项**：出处非 repository；身份/版本漂移；摘要漂移；bundle 自带 singleton 依赖（react/cordis/dsh）；安装期生命周期脚本；无当前平台打包证据；bundle 内 symlink/特殊文件。全部 fail-closed。
3. **持久 schema**：`schemaVersion: 1`，封闭字段集；演进只做 additive，`schemaVersion` 2+ 的记录被现版本拒绝（与 home marker 同一纪律）。
4. **打包级演练验证 staged 字节、加载器输入与 profile 可启动性**：经候选制品自己的 `plugin add` 流程装入全新临时 profile 后，对 staged 目录复验摘要，断言加载器将导入的 bundle 模块（`main: index.js` + 惰性 `apply()`，无副作用以保摘要确定）与 profile 补丁层存在且引用该 bundle，并**在该 intake profile 上完成一个真实回合**——这是 fail-closed 必经门：回合失败（含超时）即整条命令失败。启动轮被两层缺陷阻断，独立命令保持红色直到解决：(a) rc.1 基线上游缺陷——全新非模板 profile 无插件也崩溃 exit 1、装入 bundle 后挂起；(b) 嵌入式运行时的 cordis-plugin-loader **按包名从自身位置向上解析**（上游设计假设 CLI/loader 位于 profile 树内），app bundle 内的 loader 永远走不到 `<home>/profiles/<name>/node_modules`——第三方 bundle 报 `ERR_MODULE_NOT_FOUND`。这不是临时缺陷而是布局设计题：需要投影进 loader 可达的解析根、或上游补丁支持按 profile 目录解析，须另立设计。当前版本因此**不声明第三方 bundle 可启动**：发版链以 `--launch-round=excluded` 演练实际交付的引入能力（校验/装入/字节复验/隔离），启动轮保留在独立命令 `verify:plugin-intake` 的 fail-closed 默认模式中。Host 图上的加载行为由 host-runner 集成测试独立覆盖。
5. **信任来源**是记录中的出处 commit 与逐字节摘要 + 人工审查；本产品不引入远程注册表、市场或签名链（v1 范围外）。

## 后果

- 引入一个真实第三方 bundle 的流程：建记录（`bundleDigest()` 计算）→ 人工审查 → 隔离校验 → 制品级演练 → 入册；四步任何一步失败都不得装进用户 profile。
- 校验器永远只读；演练只用临时 home/profile/安装副本。
- 摘要算法与 `release-evidence` 的目录摘要共用同一确定性定义；两处修改必须同步。

## 拒绝的替代方案

- **自动安装/启用**：拒绝——引入的产出是"具备被安装资格"，安装动作属于用户。
- **以 lockfile/integrity 代替目录摘要**：拒绝——bundle 以目录形态进入 profile，逐字节目录摘要才是被校验物。
- **远程信誉系统**：拒绝——v1 无远程面。
