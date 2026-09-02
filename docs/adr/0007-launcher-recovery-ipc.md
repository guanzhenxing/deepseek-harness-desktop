# ADR-0007：launcher 恢复窗口使用窄 IPC

- 日期：2026-09-02
- 状态：已接受
- 决策人：Jesen（guanzhenxing）

## 1. 问题

M2 需要一个不依赖 DSH Host 的本地恢复面：Host 启动失败后用户要能重试、进入 Safe Mode 或退出。该窗口本质是 privileged launcher UI，任何 renderer 逃逸都会绕过 lease/profile 的安全边界。

## 2. 决策

恢复窗口是独立的 launcher-owned `BrowserWindow`：非持久 `partition`、`contextIsolation/sandbox/webSecurity=true`、`nodeIntegration=false`，只加载本地固定 HTML/JS（CSP 禁网络与 inline script，DOM 只用 `textContent`）。preload 用 CommonJS（`.cts`→`.cjs`，Electron ESM 限制），经 `contextBridge` 只暴露 `requestAction(action)` 与 `onView(listener)`。

IPC 仅一条动作通道 `recovery:action`，每条消息验证：发送者必须是恢复窗口自身的 webContents、主 frame、`file:` 协议且路径精确等于恢复文档（无 query/hash）、payload 为固定 schema、且会话当前确处 recovery 态。任何不匹配一律拒绝并记录原因；不匹配的 sender（子 frame、loopback 页面、导航后的页面）永远拿不到动作执行。视图单向推送（`recovery:view`），doctor 只显示命令文本，不接受任何 shell 字符串执行。

窗口懒创建：首次进入恢复态才创建。启动即建而从未加载的隐藏窗口会卡住 Electron 的 quit 序列（实测），懒创建同时避免健康路径的无谓开销。

## 3. 结果与代价

- 代价：恢复面与主窗口两套 surface 生命周期；退出链需销毁恢复窗口。
- 备选否决：复用官方 DSH Web renderer 换 URL（第三方代码同权运行，ADR-0002 已否决）；向 renderer 暴露通用 invoke（等价于放弃 IPC 边界）；常驻隐藏窗口（卡 quit，且无收益）。
