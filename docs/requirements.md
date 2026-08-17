# 需求文档：DSH 浏览器控制插件（browser-control）

- 版本：v1.0（已定稿）
- 状态：需求定稿（阶段 1 完成，待阶段 2 协议定稿）
- 关联：docs/outline.md（大纲 v0.1 已确认）

## 1. 背景与目标

DSH（DeepSeek Harness）运行在本机。用户希望在 DSH 会话中让 Agent 直接操控用户自己
浏览器（Chrome/Edge）里已打开的页面（带登录态），类似 OpenClaw 的 Chrome 扩展。
本项目交付两件产物：

1. 一个 Chrome/Edge MV3 扩展（用户浏览器侧）
2. 一个 DSH 动态 Cordis 插件（Host 半：WebSocket 桥 + browser_* 动态工具）

端到端目标：用户在 DSH 中说"打开 xxx 并完成 yyy"，Agent 通过工具驱动扩展操作浏览器。

## 2. 范围

### 2.1 范围内（MVP，已确认）

- 配对与连接：WebSocket + 令牌 + 心跳 + 自动重连
- 页面感知：截图（PNG base64）、可交互元素树（文本化）
- 页面操作：导航 / 点击 / 输入 / 按键 / 滚动 / 切标签 / 列标签 / 执行 JS
- DSH 侧：WS 服务端、命令路由、browser_* 工具、会话管理、敏感站点授权门、截图附件化、日志
- 兼容：Chrome ≥ 114 与 Edge ≥ 114（MV3，无浏览器专属分支）

### 2.2 范围外（后续阶段）

- 下载文件管理、表单自动填充、页面状态监听（waitFor）
- DSH GUI 控制面板（插件 Client 半）
- 多 DSH 实例 / 多用户
- 实时媒体（会议、直播）控制

## 3. 术语

| 术语 | 含义 |
|---|---|
| DSH | DeepSeek Harness，本机 Agent 运行框架（GUI 于 http://127.0.0.1:3080） |
| 扩展 | 本项目的 Chrome/Edge MV3 扩展 |
| 桥 | DSH 插件中的 WebSocket 服务端与命令路由 |
| 元素树 | 页面可交互元素的文本化描述（见附录 B） |

## 4. 用户场景

- US-1 安装配对：装扩展 → popup 粘贴配对码 → 显示"已连接"；DSH 侧日志同步可见。
- US-2 页面问答："当前页面是什么？" → Agent 调 browser_read_page / browser_screenshot 回答。
- US-3 表单操作：导航 → 点击 → 输入 → 提交（完整链路）。
- US-4 多标签：Agent 列出标签页并切换。
- US-5 截图存档：截图以附件形式出现在 DSH GUI 会话中。

## 5. 功能需求

编号规则：C=连接配对，P=页面感知，O=页面操作，D=DSH 插件，S=安全，U=扩展 UI。

### 5.1 连接与配对（C）

- C-1 连接地址：扩展默认连 `ws://127.0.0.1:3080/dsh/browser?token=<pairing-token>`；
  地址可在 popup 中修改。
- C-2 配对：配对令牌不硬编码在源码；插件启动时从令牌文件（`TOKEN_FILE`，默认 `.dsh-browser-token`）
  读取，不存在则随机生成并持久化；`browser_pairing_code` 工具可随时查询；
  跨 DSH 重启稳定（令牌文件持久化）；popup 粘贴令牌 → 握手 → 建立会话。
- C-3 心跳：双向 ping/pong，15s 间隔；连续 3 次失败判为断线。
- C-4 重连：扩展指数退避自动重连（1s→2s→4s→…上限 30s，成功后复位）。
- C-5 单会话：同一时间仅一个活动扩展连接；新连接顶替旧连接（旧连接收到 replaced 后关闭）。

### 5.2 页面感知（P）

- P-1 browser_screenshot：截取当前活动标签页可见区域 → PNG base64 → DSH 保存为会话附件，
  返回附件引用与尺寸；宽度上限 2048px（超出降采样）；base64 后 ≤ 3MB。
- P-2 browser_read_page：返回当前页面可交互元素树（文本化）：类型、可见文本、role、
  输入框 placeholder/值、按钮/链接文本、坐标；按 DOM 顺序；条目上限 200。
- P-3 敏感信息过滤：密码框只返回占位符不返回值；runJs/read_page 结果中含疑似密钥串
  （`sk-`、`token=`、`password=` 等）截断。

### 5.3 页面操作（O）

- O-1 browser_navigate(url)：活动标签页导航；等待 load 或超时（默认 30s）；返回最终 URL 与 title。
- O-2 browser_click(target)：target 支持元素树 ref 或 CSS 选择器；点击前滚动到可见；
  返回操作后页面状态摘要。
- O-3 browser_type(target, text, clear?)：聚焦输入框输入；clear 先清空；密码框不回显值。
- O-4 browser_press(key)：按键（Enter/Escape/Tab/组合键）。
- O-5 browser_scroll(direction|delta)。
- O-6 browser_list_tabs() / browser_switch_tab(tabId)。
- O-7 browser_run_js(expression)：在活动页面执行 JS，仅返回 JSON 可序列化结果；受安全策略约束（S-2）。
- O-8 统一结果摘要：`{ ok, tabId, url, title, message }`。

### 5.4 DSH 插件（D）

- D-1 注册 WS 升级路由 `/dsh/browser`（webServer.registerUpgrade）；令牌不匹配立即关闭连接。
- D-2 注册动态工具 browser_*（harness.registerTool），名称与 schema 见附录 A。
- D-3 命令路由：请求/响应按 id 配对；命令超时（默认 60s）返回 timeout 错误。
- D-4 事件上行：扩展主动推送 connected/disconnected/tabChanged/pageLoaded，DSH 记录日志。
- D-5 日志：console 输出命令流水（时间、命令、耗时、结果摘要），用于调试与审计。
- D-6 截图附件：browser_screenshot 结果经 attachments.saveImages 保存，GUI 可查看。
- D-7 生命周期可逆：插件停止/更新时关闭全部连接、注销工具、释放路由。

### 5.5 安全（S）

- S-1 敏感站点授权门（consent gate）：银行/支付/政务类域名（源码常量类目 + 主机名后缀
  匹配，含裸域）上的操作不直接拒绝，而是触发授权：DSH 在命令中标记 consentRequired，
  扩展弹出系统通知（允许/拒绝按钮）；用户允许后该域名本连接内放行；拒绝或超时
  （默认 60s）则命令失败返回 ECONSENT。普通域名不触发授权门。
- S-2 高危命令：browser_run_js 默认拒绝（返回明确错误），除非后续版本加入确认通道。
- S-3 令牌安全：令牌为随机生成的明文（仅本机令牌文件）；只经 `browser_pairing_code` 工具或插件日志暴露。
- S-4 数据最小化：read_page 返回文本化描述而非原始 HTML；截图不进模型上下文
  （当前模型无视觉），仅作 GUI 附件。
- S-5 审批说明：本会话审批策略为 never，不使用 approval 服务做每步确认；
  v0.1 防护 = 敏感站点授权门（扩展内确认）+ 高危命令拒绝。
- S-6 授权持久性：扩展用 chrome.storage.local 记住已授权域名（默认记住），
  popup 可查看并清除授权（见 U-3）。

### 5.6 扩展 UI（U）

- U-1 popup：连接状态（未连接/已连接/配对失败）、配对码输入、地址编辑、重连按钮、版本号。
- U-2 徽标：连接成功时 toolbar badge 显示 "DSH"（绿底）。
- U-3 授权管理：popup 可查看已授权域名列表并清除授权（对应 S-6）。

## 6. 协议（✅ 已定稿 → docs/protocol.md v1.0；本节为需求期草案基线，冲突以 protocol.md 为准）

- 传输：WebSocket text frame，JSON 编码，UTF-8。
- 上行（扩展→DSH）：
  - `{ type: "hello", token, version, browser }` — 握手
  - `{ type: "result", id, ok, data }` — 命令结果
  - `{ type: "event", name, data }` — 主动事件
- 下行（DSH→扩展）：
  - `{ type: "command", id, name, args, consentRequired? }` — 命令（consentRequired 为 true 时扩展须先弹授权，见 S-1）
  - `{ type: "close", reason }` — 关闭通知
- 命令名 kebab-case；协议版本字段 `v: 1`，不匹配拒绝连接。
- 错误码：`EAUTH`（令牌错）、`ETIMEOUT`（超时）、`ENOTFOUND`（目标元素不存在）、
  `ECONSENT`（用户拒绝/超时未授权）、`EJS`（JS 执行错误）、`EBUSY`（已有命令执行中）、`EUNKNOWN`。

## 7. 非功能需求

- N-1 延迟：本机环境下命令往返（非截图）< 200ms。
- N-2 截图：base64 后 ≤ 3MB，超出降采样。
- N-3 兼容：Chrome ≥ 114、Edge ≥ 114（MV3）。
- N-4 零构建：扩展零构建依赖（unpacked 直接加载）；DSH 插件零 npm 依赖。
- N-5 恢复：扩展崩溃/浏览器重启后自动恢复连接；DSH 重启后重跑插件 + 令牌持久化即可重连。

## 8. 验收标准（AC）

- AC-1 安装扩展并粘贴配对码后，popup 显示"已连接"，DSH 侧日志显示连接建立。
- AC-2 会话中对 Agent 说"打开 https://example.com"，Agent 完成导航并返回页面标题。
- AC-3 基于元素树完成"点击页面上的 X"。
- AC-4 完成"在搜索框输入 xxx 并回车"（普通站点）。
- AC-5 browser_screenshot 截图作为附件出现在 DSH GUI 会话中。
- AC-6 敏感类目域名上的操作触发扩展授权通知；用户拒绝或超时则命令失败返回 ECONSENT，
  用户允许后操作继续。
- AC-7 DSH 重启后重跑插件，扩展自动重连（令牌持久化）。
- AC-8 在 Edge 中重复 AC-2..AC-5 通过。

## 9. 约束

- 动态插件运行于受限沙箱：无 require/import/fetch；只用 Builtin（ctx/harness/console/btoa/atob/
  TextEncoder/TextDecoder）与已查询的服务（webServer、attachments、fs、timer）。
- 扩展运行于 MV3：service worker 生命周期、content script 隔离、host_permissions。
- 令牌持久化用 fs 写 DSH 工作区文件（动态插件不写 settings 持久设置，按 Skill 指引）。

## 10. 决策记录（open questions 已定）

- Q-1 截图附件化：**开启**（每次截图自动存为 DSH GUI 会话附件）。
- Q-2 配对方式：**DSH 生成配对码 → popup 粘贴**。
- Q-3 runJs 策略：**默认拒绝**（后续版本可加开关/确认通道）。
- Q-4 敏感站点策略：**不做硬黑名单拦截**；敏感类目（银行/支付/政务）域名上的操作
  改为**授权门**——必须获得用户明确授权（扩展通知允许/拒绝）后才能执行（见 S-1/S-6）。

## 附录 A：工具清单（v0.1）

| 工具 | 参数 | 返回 |
|---|---|---|
| browser_navigate | url | {ok,url,title} |
| browser_click | ref \| selector | 摘要 |
| browser_type | ref \| selector, text, clear? | 摘要 |
| browser_press | key | 摘要 |
| browser_scroll | direction/delta | 摘要 |
| browser_list_tabs | — | tabs[] |
| browser_switch_tab | tabId | 摘要 |
| browser_screenshot | — | {ref,w,h} |
| browser_read_page | — | elements[] |
| browser_run_js | expression | 结果（默认拒绝） |

## 附录 B：可交互元素树条目格式（草案）

```
{ type, text, role, ref, value?, placeholder?, href?, x, y, w, h, disabled? }
```
- type: button | link | input | textbox | checkbox | select | nav | heading | text | img | other
- ref: 稳定索引，供 browser_click/browser_type 引用
- x/y/w/h: 相对视口坐标（供滚动与命中判断）
