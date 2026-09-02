# 启动恢复分类协议

- 状态：M2 实现中（`packages/shell-core/src/failure-policy.ts`、`packages/host-supervisor` 阶段化 boot）
- 决策记录：[ADR-0006](../adr/0006-profile-revision-recovery.md)

## 1. 分类模型

启动失败在**捕获位置**结构化为 `StartupFailure = { stage, code, category, summary, retryable }`；归因不足的一律 `unknown`，绝不从错误消息包含的词推断责任插件。

Host 侧命名阶段（host-runner，随 fatal 信封透传，不压平为 BOOT_FAILED）：

| stage             | code                      | category            | retryable |
| ----------------- | ------------------------- | ------------------- | --------- |
| `resolve-runtime` | `RUNTIME_UNAVAILABLE`     | runtime             | true      |
| `resolve-profile` | `PROFILE_INVALID`         | profile-composition | false     |
| `load-home-patch` | `HOME_PATCH_INVALID`      | home-config         | false     |
| `boot`            | `BOOT_FAILED`（未识别码） | unknown             | true      |
| `boot`            | `MISSING_CREDENTIAL`      | credentials         | false     |
| `boot`            | `PORT_IN_USE`             | network             | false     |
| `publish-surface` | `SURFACE_MISSING`         | runtime             | false     |

launcher 侧阶段：`lease`（M1 lease 错误码）、`reconcile-profile`（profile-write）、`load-surface`（renderer）、`native-ui`。

## 2. 摘要脱敏

`toStartupFailure` 对 summary 做：home 路径替换为占位提示、`token=…` 打码、控制字符替换为空格、长度上限 1024、空结果回退为 `<stage> failed (<code>)`。credentials 类附"通过官方 DSH 设置配置凭据，桌面不创建或复制凭据"指引。

## 3. 自动回滚资格

`shouldRollbackProfile(failure, changed, healthy)` 仅当三者同时成立：

1. 本次启动从未达到 healthy；
2. 本次 reconcile 确实修改了 profile；
3. 失败 category ∈ { profile-write, profile-composition }。

其余一切失败（lease、home-config、credentials、network、runtime、renderer、native-ui、unknown）保持用户数据原样，进入恢复窗口（ADR-0007）由用户选择重试、Safe Mode 或退出。重试预算：滚动 60 秒窗口内手动重试至多 3 次；post-ready 崩溃不自动重启；恢复窗口存活期间不持 lease（失败链已按协议 stop→确认→释放）。lease 获取失败不进恢复窗口——保持入口生命周期行为（Desktop 对话框+退出 1，CLI 退出码 3）。Safe Mode 在 Task 5 前不可选（`safeModeAllowed=false`）。
