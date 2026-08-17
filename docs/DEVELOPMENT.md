# 开发笔记（Development Notes）

本文件记录项目开发过程中踩过的坑与验证结论，供后续维护与排查参考。

## 已解决的关键问题

### 1. DSH 进程崩溃（v1.3 修复）

- **根因**：动态插件沙箱禁用了 `clearTimeout`/`setTimeout`（强制使用 `ctx.timeout`/`ctx.interval`），
  插件在收到命令结果时调用原生 `clearTimeout(p.timer)` → 抛错 → 异常从 socket 回调
  冒泡到 Node 事件循环（未捕获）→ 整个 DSH 进程崩溃。
- **修复**：改用 `ctx.timeout()` 返回的 disposer（调用它取消定时器）；
  `onSocketData` 整体异常隔离（任何解析错误只断该连接，不再崩进程）。
- **教训**：动态插件沙箱内绝不可用原生定时器 API。

### 2. 扩展连接每 30-45 秒断一次（v1.4 + 扩展侧 Port 保活）

- **根因（两层）**：
  1. 心跳最初用 WS **协议层 ping 帧**（opcode 0x9）。浏览器协议层会静默消化 ping 并自动回
     pong，**不触发 `onmessage` 事件** → 扩展 service worker 无事件活动 → 被 Chrome
     空闲回收（30s）→ WS 断开 → 重连循环。
  2. 改为文本消息心跳后，SW 仍可能被回收：content script 的 `setInterval` 在页面隐藏时
     被 Chrome 节流（后台标签页定时器 1 次/分钟）→ keepalive 失效。
- **修复**：
  1. 心跳改为**文本消息** `{"type":"ping"}` / `{"type":"pong"}`（协议层 ping 帧不可用）。
  2. 扩展 content script 建立 `chrome.runtime.connect({name:'dsh-keepalive'})` **长连接 Port**
     （Chrome 116+：活跃 Port 保持 SW 不终止，不受页面定时器节流影响），
     并保留 10s 定时消息作为补充。

### 3. 截图附件保存失败 "Unsupported or malformed image data"（v1.7 修复）

- **根因**：**跨 realm `Uint8Array` 陷阱**。插件运行在 vm 沙箱（独立 realm），
  `Uint8Array.from(...)` 创建的是**沙箱 realm** 的对象；宿主 `attachments` 服务的
  sharp 库用 `instanceof Uint8Array` 检查 → **跨 realm instanceof 失败** → sharp 拒绝
  解析（"Unsupported input ... of type object"）。沙箱的 dual-realm instanceof 补丁
  只覆盖 Object/Array/Error/Promise/RegExp/Date/Map/Set，**不含 Uint8Array**。
- **修复**：用**宿主注入的 `TextEncoder().encode()` 创建宿主 realm 的 Uint8Array**
  （宿主函数构造的对象属于宿主 realm），填充字节后再传给 `attachments.saveImages`。
- **实证**：`plugin/test/sharp-realm-test.js` 三组对照（沙箱数组失败 / 宿主 Buffer 成功 /
  TextEncoder 工厂成功）。

### 4. 大帧（截图 base64）数据损坏（v1.6 修复）

- **根因**：`onSocketData` 曾直接 `conn.buf = chunk` 引用 Node socket 读缓冲；
  Node 会复用读缓冲，后续 `data` 事件覆盖同一块内存 → 多 TCP 分片的大消息损坏。
- **修复**：总是拷贝合并（`merged.set(conn.buf)` + `merged.set(chunk)`），
  帧消费用 `subarray` 截断（O(1)）。

### 5. 元素定位失败 "el.scrollIntoView is not a function"（扩展侧）

- **根因**：`lastTree` 保存的是元素树条目（普通 JSON 对象），不是 DOM 元素。
- **修复**：新增 `lastElements` 并行数组（ref → DOM 元素）。

### 6. 合成 Enter 不触发表单提交

- **根因**：合成 `KeyboardEvent` 的 `keyCode` 默认为 0，且 `isTrusted=false` 的事件
  不触发浏览器默认行为（如表单提交）。
- **修复**：补 `keyCode`/`which`；Enter 且焦点在表单内时调用 `form.requestSubmit()`。

## 验证工具（plugin/test/）

| 脚本 | 用途 |
|---|---|
| `check.js` | SHA1 / base64 手写实现断言（RFC 6455 握手向量等） |
| `ws-decode-test.js` | WS 帧解析单元测试（小帧/大帧 127 扩展/分包/多消息同 chunk） |
| `ws-probe.js` | 心跳探针（连接后观察文本 ping 是否每 15s 到达） |
| `ws-sim-extension.js` | 模拟扩展（hello 成为活动连接，命令回传 1x1 PNG 或 3MB 数据，验证 DSH 链路） |
| `ws-raw-client.js` | 裸 TCP WS 客户端（标准 RFC 6455 帧，绕开 undici，对照验证） |
| `sharp-realm-test.js` | sharp 对跨 realm Uint8Array 的行为验证 |

## 联调验收（AC）

| AC | 内容 | 状态 |
|---|---|---|
| AC-1 | 安装扩展 + popup 配对 → 已连接 | ✅ |
| AC-2 | 导航并返回标题 | ✅ |
| AC-3 | 元素树 + 点击 | ✅ |
| AC-4 | 输入 + 提交 | ✅（Enter 在部分 SPA 受限，点击提交按钮兜底；常规表单 requestSubmit 可用） |
| AC-5 | 截图附件化 | ✅ CDP 截图 + 附件保存 |
| AC-6 | 敏感站点授权门 | ✅ 触发授权 → 允许 → 执行；授权按域名记忆（popup 可查/清除） |
| AC-7 | DSH 重启后扩展自动重连 | ⏳ 部分验证（断线/重连/alarm 唤醒均正常；DSH 重启后动态插件需重新部署） |
| AC-8 | Edge 复测 | ⏳ 未测 |

## 待办

- [ ] Edge（AC-8）复测
- [ ] 宿主化改造：把动态插件挂入宿主 composition（如 `cordis.patch.yml`），
      解决"DSH 重启后动态插件定义/授权全丢、需重新部署"的根本问题
- [ ] 敏感域名列表扩充（协议附录 B 当前为最小集）
- [ ] `browser_run_js` 保持默认拒绝（EPOLICY），如需启用需策略开关

## 已知限制

- **动态插件进程内**：DSH 重启后需重新部署插件并重新授权 Client 半。
- **后台窗口截图**：截图使用 CDP `Page.captureScreenshot`（debugger 权限），
  不依赖窗口可见；截图时浏览器顶部会短暂显示"正在调试此浏览器"横幅。
- **`chrome://` 等内部页**：content script 无法注入，`read_page`/`click` 等页面操作
  对其不可用（导航到普通网页后恢复）。
- **配对令牌**：不硬编码（v1.8 起）；首次运行随机生成并写入 `TOKEN_FILE`
  （默认 `.dsh-browser-token`），可用 `browser_pairing_code` 工具随时查询。
