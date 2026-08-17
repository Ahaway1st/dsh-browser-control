# 大纲：DSH 浏览器控制插件（类 OpenClaw Chrome 扩展）

版本：v0.1（已评审，2025 起）
状态：**已确认**（用户拍板：扩展直连 DSH / Chrome+Edge 双支持 / 按 MVP 清单）

## 0. 参照模式

OpenClaw 的 Chrome 扩展（[官方文档](https://docs.openclaw.ai/tools/chrome-extension)）是"浏览器中继"：
扩展装在用户真实的 Chrome 里，通过本机网关与 Agent 通信，让 AI 直接操作已登录的浏览器
（带着 cookie、登录态）。本插件照此模式，网关即 DSH 自身。

## 1. 总体架构

```
┌─ 用户的 Chrome/Edge ───────────┐        ┌─ DSH（本机 127.0.0.1:3080）──────────────────┐
│  DSH 扩展 (MV3)                │        │  动态 Cordis 插件（Host 半）                   │
│  ├─ content script: 页面感知/操作│ WebSocket│  ├─ webServer.registerUpgrade → WS 服务端   │
│  │   （点击/输入/读DOM/滚动）     │◄───────►│  ├─ 配对令牌、会话管理、心跳重连             │
│  ├─ background: 标签页/截图/连接 │ JSON 命令│  ├─ harness.registerTool → browser_* 工具   │
│  └─ popup: 连接状态、配对码      │  /事件  │  └─ 截图存为附件、操作日志                   │
└──────────────────────────────┘        └──────────────────────┬────────────────────┘
                                                               │ 注册动态工具
                                                       ┌───────▼────────┐
                                                       │  模型（Agent）    │
                                                       └────────────────┘
```

## 2. 两个组成部分

| 部分 | 技术 | 职责 |
|---|---|---|
| **Chrome 扩展** | Manifest V3，纯前端（零构建依赖） | 页面级操作（content script）+ 标签页/截图（background）+ 配对 UI（popup） |
| **DSH 动态插件** | Cordis Host 半（纯 JS，零 npm 依赖） | WebSocket 服务端、命令路由、browser_* 动态工具、安全策略 |

关键判断（已通过 Inspect 确认）：
- 动态插件 Host 代码**不能 require/import npm 包、无 fetch**；扩展方案恰好零 Node 依赖，
  所有页面操控逻辑在扩展里，DSH 只做 JSON 转发 → 优于 CDP/Playwright 方案。
- `webServer.registerUpgrade(route)` 可在现有 3080 端口挂 WebSocket 升级路由（exact-path，
  路径唯一），扩展连 `ws://127.0.0.1:3080/dsh/browser`，无需额外起服务。
- `harness.registerTool(ctx, tool)` 注册动态模型工具；现有工具名无 `browser_*` 冲突。

## 3. 通信协议（✅ 已定稿 → docs/protocol.md v1.0；本节为历史草案）

- WebSocket JSON：DSH→扩展命令（navigate/click/type/screenshot/readPage/getTabs/runJs…），
  扩展→DSH 结果/事件（result/tabChanged/pageLoaded…），自增 id 配对请求响应。
- 配对：DSH 生成一次性配对令牌，扩展 popup 粘贴后建立连接；令牌持久化，重启免重配。
- 心跳 + 断线重连（指数退避）。
- 授权门：敏感站点（银行/支付/政务）首次操作需用户通过扩展通知授权（允许/拒绝），
  超时或拒绝则命令失败（ECONSENT）。

## 4. 能力清单（分阶段）

**MVP（第一阶段，已确认范围）**
- 页面感知：截图（PNG base64）+ 可交互元素树（不依赖视觉模型也能操作）
- 操作：导航、点击、输入、按键、滚动、切标签、列标签、执行 JS
- 工具：browser_navigate / browser_click / browser_type / browser_press / browser_scroll /
  browser_list_tabs / browser_switch_tab / browser_screenshot / browser_read_page / browser_run_js
- 安全：仅接受已配对扩展；敏感站点授权门（扩展通知允许/拒绝，不做硬拦截）；runJs 默认拒绝

**增强（第二阶段，未排期）**
- 下载管理、表单自动填充、多标签批量管理、页面状态监听（waitFor）
- DSH GUI 侧控制面板（插件 Client 半：连接状态、实时截图预览）

**可选（第三阶段，未排期）**
- 与 Goal 系统集成：长任务自主执行 + 关键节点人工确认

## 5. 关键风险

1. **模型视觉**：当前模型可能不直接支持看图 → MVP 依赖文本化元素树；截图作会话附件展示。
2. **MV3 生命周期**：service worker 空闲被回收 → 靠 WebSocket 常连保活。
3. **动态插件进程内**：DSH 重启后插件需重跑；配对令牌持久化，扩展自动重连。
4. **安全边界**：浏览器控制属高危能力；本会话审批策略为 never → 防护靠插件自身
   （敏感站点授权门 + 高危命令拒绝），不依赖审批弹窗。

## 6. 开发阶段

- 阶段 0：大纲（✅ 已完成）
- 阶段 1：需求文档（✅ v1.0 定稿 → docs/requirements.md）
- 阶段 2：协议定稿（✅ v1.0 → docs/protocol.md）
- 阶段 3：Chrome 扩展实现（✅ 源码完成 + 语法校验 → extension/，待阶段 5 联调）
- 阶段 4：DSH 插件实现（✅ 已部署运行 → plugin/plugin.js + client.js 源码存档）
- 阶段 5：安装联调验证（🔄 进行中：AC-1~AC-4 ✅，AC-5 截图待排查 → docs/KNOWN_ISSUES.md）

## 7. 项目目录

```
dsh-browser-control/
  docs/          大纲 + 需求 + 协议
  extension/     Chrome/Edge MV3 扩展源码（零构建，unpacked 加载）
  plugin/        DSH 动态插件源码存档（与 cordis_define 的 Package 对应）
```
