# DSH Browser Control — Chrome/Edge 扩展

MV3 零构建扩展：DSH（DeepSeek Harness）Agent 操作你真实浏览器的桥。
协议契约见 `../docs/protocol.md`（v1.0）。

## 目录结构

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单与权限（见下） |
| `background.js` | Service Worker：WebSocket 连接/握手/文本心跳、命令路由、CDP 截图、授权门、SW 保活 |
| `content.js` | 页面操作层：元素树提取、点击/输入/按键/滚动、SW 保活 Port（按需注入、幂等） |
| `popup.html/js/css` | 配对（令牌/地址）、连接状态、待授权确认、已授权域名管理 |
| `icons/` | 扩展图标（脚本生成） |

## 权限说明（manifest）

- `tabs`：读取标签页信息、`captureVisibleTab` 兜底截图
- `activeTab`：用户点击扩展图标后临时授予（`captureTab` 截图路径）
- `scripting` + `host_permissions <all_urls>`：按需注入 content script（页面操作必需）
- `notifications`：敏感站点授权门通知
- `debugger`：CDP `Page.captureScreenshot`（**主截图路径**，后台窗口也可用；截图时浏览器顶部短暂显示"正在调试此浏览器"）
- `storage`：令牌/连接配置/授权记录（`chrome.storage.local`）
- `alarms`：断线重连兜底唤醒

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启**开发者模式**
3. **加载已解压的扩展程序** → 选择本目录
4. 确认权限提示（需读取所有网站数据——浏览器控制的必要代价）

## 配对

1. 在 DSH 会话中向 Agent 询问配对码（`browser_pairing_code` 工具）
2. 点工具栏扩展图标 → 粘贴令牌 → 点「连接」
3. popup 显示「已连接」；DSH 右下角面板变绿

## 使用

在 DSH 会话里直接对 Agent 说，例如："打开 https://example.com"、"看看当前页面有什么"、
"点一下搜索框，输入 xxx，回车"、"截个图"。

## 安全与稳定机制

- **授权门**：敏感站点（银行/支付/政务）操作会弹系统通知（含允许/拒绝按钮），
  也可打开 popup 在「🔔 待授权请求」中确认；授权按域名记住（`chrome.storage.local`），
  popup 可查看/清除
- **SW 保活**：content script 建立 `chrome.runtime.connect` Port 长连接 +
  10s 保活消息（Chrome 116+ 活跃 Port 保持 SW 不终止，不依赖页面可见性）
- **数据最小化**：`read_page` 只回文本元素树；密码框值永不回传
- **断线重连**：指数退避（1s→30s）+ alarm 兜底；令牌不变时自动重连
