# DSH 侧插件（browser-control）

DSH 动态 Cordis 插件的源码存档：`plugin.js`（Host 半）+ `client.js`（Client 半，GUI 面板）。

## 部署方式

当前为**动态插件**（DSH 会话内通过 `cordis_define` 定义、`cordis_run` 运行）。
每次 DSH 重启后需重新部署并重新授权 Client 半。

> 计划中的改进：宿主化改造（挂入宿主 composition 如 `cordis.patch.yml`），
> 使 DSH 启动时自动加载，彻底解决重启丢失问题。

## 配对令牌

- **不硬编码**。插件启动时：
  1. 尝试从 `TOKEN_FILE`（默认 `.dsh-browser-token`，相对 DSH 工作目录；
     可在 `plugin.js` 顶部改为绝对路径）读取已有令牌；
  2. 文件不存在则随机生成并写入；
  3. 令牌同时打印在插件日志，且随时可通过 `browser_pairing_code` 工具查询。
- 想固定令牌：预先创建 `TOKEN_FILE` 并写入你的令牌即可（跨重启稳定）。

## 命令契约

协议见 `../docs/protocol.md`（v1.0）。插件实现的桥：

- WebSocket 服务端：`/dsh/browser`（`webServer.registerUpgrade`，手写 RFC 6455）
- 文本消息心跳：每 15s `{"type":"ping"}`，45s 无上行判 stale
- 命令队列：串行、60s 超时、单在途（EBUSY 保护）
- 授权门：敏感域名（银行/支付/政务，`SENSITIVE_DOMAINS` 常量）命令带
  `consentRequired`，扩展侧确认后放行；授权按域名记住
- 截图附件：扩展回传 base64 → 解码（宿主 realm Uint8Array，见 DEVELOPMENT.md
  跨 realm 陷阱）→ `attachments.saveImages` 保存

## 运行环境约束（node:vm 沙箱）

动态插件 Host 代码运行在受限沙箱：

- ❌ 无 `require` / `fetch` / `Buffer` / `URL` / `crypto` / `process`
- ❌ 无 `setTimeout` / `setInterval` / `clearTimeout`（必须用 `ctx.timeout` / `ctx.interval`）
- ✅ 可用：`ctx`（注入服务）、`harness`、`console`、`btoa`/`atob`、`TextEncoder`/`TextDecoder`

因此 SHA1 与 base64 为手写实现（`test/check.js` 有完整断言）。

## 测试

```bash
node test/check.js              # SHA1/base64 原语断言
node test/ws-decode-test.js     # WS 帧解析单元测试
node test/ws-probe.js           # 心跳探针（观察文本 ping）
node test/ws-sim-extension.js   # 模拟扩展（验证 DSH 链路）
node test/ws-raw-client.js      # 裸 TCP WS 客户端（对照验证）
node test/sharp-realm-test.js   # sharp 跨 realm Uint8Array 行为验证
```

> `ws-sim-extension.js` / `ws-raw-client.js` 会顶替真实扩展连接（replaced），
> 测试完扩展会在下个 alarm 周期自动重连。
