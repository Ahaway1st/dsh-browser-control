# DSH Browser Control

[**English**](./README.en.md) | 中文

让 DeepSeek Harness（DSH）的 Agent 直接操控你**真实浏览器**的插件——类似 OpenClaw 的 Chrome 扩展。
扩展安装在 Chrome/Edge 里，通过本机 WebSocket 与 DSH 通信，Agent 可以导航、点击、输入、
截图、读页面，带着你的登录态完成真实任务。

```
┌─ 你的 Chrome/Edge ──────────────┐        ┌─ DSH（本机 127.0.0.1:3080）──────────────────┐
│  DSH Browser Control 扩展 (MV3)  │        │  browser-control 插件（动态 Cordis，Host 半）   │
│  ├─ content script: 页面感知/操作 │ WebSocket│  ├─ WebSocket 桥（/dsh/browser）             │
│  │   （点击/输入/读DOM/滚动）      │◄───────►│  ├─ 配对令牌（配置文件/随机生成）             │
│  ├─ background: 标签页/截图/多frame │ JSON 命令│  ├─ browser_* 动态工具（Agent 可调用）       │
│  └─ popup: 配对/连接/授权管理     │  /事件  │  ├─ 敏感站点授权门                          │
└───────────────────────────────┘        │  └─ 截图存为 DSH 会话附件                      │
                                         └──────────────────────┬─────────────────────┘
                                                                │ 注册动态工具
                                                        ┌───────▼────────┐
                                                        │  模型（Agent）    │
                                                        └────────────────┘
```

## ✨ 特性

- **操作真实浏览器**：带着你的登录态/cookie，执行导航、点击、输入、按键、滚动、切换标签页
- **文本化页面感知**：可交互元素树（ref 索引定位），不依赖视觉模型；支持**自绘 UI**
  （QQ 邮箱等 div+JS 无语义标签界面，cursor:pointer 启发）与 **iframe 应用**（多 frame 聚合）
- **自动截图存档**：captureVisibleTab 优先 + CDP 兜底，保存为 DSH 会话附件（GUI 可直接查看）
- **敏感站点授权门**：银行/支付/政务类域名操作需你在浏览器侧确认（系统通知 + popup 双通道），
  授权按域名记忆、可随时清除
- **GUI 常驻面板**：DSH 界面右下角显示配对码与连接状态（shell.overlay）
- **Chrome/Edge 双支持**：Manifest V3，零构建依赖，加载已解压扩展即可
- **稳定连接**：文本心跳 + SW Port 长连接保活，断线指数退避自动重连

## ⚙️ 环境要求

- DSH（DeepSeek Harness）已运行，Web GUI 在本机 `127.0.0.1:3080`
- Chrome **≥ 116** 或 Edge ≥ 116（SW Port 保活要求；旧版本连接可能不稳定）

## 🚀 快速开始（约 3 分钟）

### 第 1 步：安装浏览器扩展（1 分钟）

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启**开发者模式**
3. 点**加载已解压的扩展程序** → 选择本仓库的 `extension` 文件夹
4. 确认权限提示（需读取所有网站数据——浏览器控制的必要代价）

### 第 2 步：在 DSH 中安装插件（1 分钟）

把下面这句话**原样粘贴**到 DSH 会话里（把 `<仓库路径>` 换成你克隆本仓库的位置）：

```
请安装 browser-control 插件：读取 <仓库路径>\plugin\plugin.js 作为 Host 代码，
读取 <仓库路径>\plugin\client.js 作为 Client 代码，用 cordis_define 创建并运行，
然后调用 browser_pairing_code 告诉我配对码。
```

DSH 的 Agent 会自动完成定义与运行。**运行后会在会话流里出现一个授权卡片**——
点卡片上的**双勾（✓✓）**授权（只需一次）。

### 第 3 步：配对（1 分钟）

1. 复制 Agent 给出的配对码（形如 `dsh-xxxx...`；若没给出，直接问 Agent"配对码是多少"）
2. 点浏览器工具栏的扩展图标 → 在「配对令牌」框粘贴 → 点**连接**
3. popup 显示「已连接」、DSH 界面右下角面板变绿 → 完成 ✅

### 试试看

在 DSH 会话里说：

- "打开 https://example.com"
- "看看当前页面有什么"
- "点一下搜索框，输入 xxx，回车"
- "截个图"

## 🛠 Agent 工具清单

| 工具 | 说明 |
|---|---|
| `browser_navigate` | 导航到指定 URL（敏感站点触发授权门） |
| `browser_read_page` | 读取可交互元素树；多 frame 页面聚合各 frame（元素带 `frameId` + frame 内 `ref`） |
| `browser_click` | 点击元素（`frameId`+`ref` 或 CSS 选择器） |
| `browser_type` | 输入文本（`frameId`+`ref` 定位，clear 可选，密码框不回传） |
| `browser_press` | 按键（可指定 `frameId`，Enter/Escape/Tab/方向键 + 修饰键） |
| `browser_scroll` | 滚动页面（可指定 `frameId`） |
| `browser_list_tabs` / `browser_switch_tab` | 标签页管理 |
| `browser_screenshot` | 截图（captureVisibleTab + CDP 兜底）并保存为会话附件 |
| `browser_run_js` | 执行任意 JS（**默认策略拒绝**，EPOLICY） |
| `browser_pairing_code` | 查询配对令牌与连接状态 |

> 单 frame 普通网页无需关心 `frameId`（默认 0 = 主 frame）；多 frame / iframe 应用
> （如 QQ 邮箱类）以 `read_page` 返回的 `frameId` 为准。

## ❓ 常见问题

**DSH 重启后插件不见了？**
动态插件是进程内的，DSH 重启后需重新执行第 2 步（重新安装 + 授权）。
（Roadmap：宿主化改造，让 DSH 启动自动加载。）

**截图时浏览器顶部出现"正在调试此浏览器"？**
仅在 CDP 兜底路径生效时出现（captureVisibleTab 不可用的场景），横幅短暂；
主路径 captureVisibleTab 无横幅但要求浏览器窗口可见。

**在 `chrome://` 等内部页面无法读取/操作？**
正常。content script 无法注入内部页；导航到普通网页后恢复。

**按回车没有提交表单？**
少数 SPA 站点（如必应主页）对合成按键不敏感；点页面上的搜索/提交按钮即可。
常规表单有 `requestSubmit()` 兜底。

**配对码在哪？**
DSH 会话里问 Agent"配对码是多少"（`browser_pairing_code` 工具）；也可看插件日志。
令牌不硬编码：首次运行随机生成并写入令牌文件（`TOKEN_FILE`，默认 `.dsh-browser-token`，
相对 DSH 工作目录，可在 `plugin/plugin.js` 顶部改为绝对路径）；想固定令牌可预置该文件。

## 📦 目录结构

```
dsh-browser-control/
├── docs/              协议、需求、开发笔记（踩坑记录）
├── extension/         Chrome/Edge MV3 扩展（零构建，unpacked 加载）
│   ├── manifest.json
│   ├── background.js  SW：连接/命令路由/截图/多frame聚合/授权门/保活
│   ├── content.js     页面操作层：元素树（含自绘 UI）/点击/输入/按键/滚动
│   └── popup.*        配对、连接状态、授权管理 UI
├── plugin/            DSH 动态 Cordis 插件（Host 半 + Client 半）
│   ├── plugin.js      WebSocket 桥、browser_* 工具、授权门、附件
│   ├── client.js      GUI 常驻面板（shell.overlay）
│   └── test/          验证脚本（SHA1/base64、帧解析、心跳探针、模拟扩展…）
├── scripts/           install.ps1 安装检查与指引
├── README.md          本文件（中文）
├── README.en.md       英文版
└── LICENSE            MIT
```

## 🔒 安全模型

- **配对令牌**：不硬编码；随机生成、仅存本机令牌文件
- **授权门**：敏感类目（银行/支付/政务，源码常量可扩展）域名上的操作，必须经用户
  在浏览器侧确认（系统通知按钮或扩展 popup），授权按域名记住、可清除
- **数据最小化**：`read_page` 只回文本化元素树；密码框值不回传；含密钥串的文本脱敏
- **高危命令**：`browser_run_js` 默认拒绝（EPOLICY），如需启用需改插件策略
- **本地闭环**：扩展只连接本机 DSH 地址，页面数据不出本机

## 🧪 开发与验证

- 协议契约：`docs/protocol.md`（v1.0）
- 需求与决策：`docs/requirements.md`
- 踩坑记录与验证工具：`docs/DEVELOPMENT.md`、`plugin/test/`
- 零构建：扩展无依赖、插件零 npm 依赖（SHA1/base64 为手写实现）

## 📄 许可证

[MIT](./LICENSE)
