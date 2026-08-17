# 协议规范 v1.0：DSH 浏览器控制

- 版本：v1.0（定稿）
- 状态：阶段 2 交付物；阶段 3（扩展）与阶段 4（DSH 插件）以此文档为契约
- 上游：docs/requirements.md v1.0（冲突时以本文档为准）

## 1. 传输与端点

- 传输：WebSocket（RFC 6455），HTTP Upgrade，text frame，UTF-8 JSON。
- 端点：`ws://127.0.0.1:3080/dsh/browser`（DSH `webServer.registerUpgrade` 路由，exact-path）。
- 认证：query 参数 `token=<pairing-token>`。
- 角色：DSH = 命令发起方（桥），扩展 = 命令执行方。传输层面是扩展连入 DSH，
  但命令方向是 DSH → 扩展。

## 2. 握手时序

```
扩展                                DSH（/dsh/browser）
 |  connect ws://…?token=T            |
 |----------------------------------->|
 |                                    | token 无效 → close 4401 (EAUTH)
 |  hello {v:1, browser, extVer}      |
 |----------------------------------->|
 |                                    | v ≠ 1 → close 4402 (EVERSION)
 |                                    | 已有活动会话 → 旧连接 close 4403 (replaced)
 |<-----------------------------------| welcome {sessionId, …}
 |  ready：可接收 command              |
```

1. 扩展连接，token 携带在 query 中。
2. DSH 校验 token：无效立即 close `4401`；有效则等待 hello。
3. 扩展发送 `hello`（见 3.3）。
4. DSH 校验协议版本 `v`，不匹配 close `4402`。
5. 若已有活动会话：DSH 向旧连接发送 `close(reason:"replaced")` 并 close `4403`，
   新连接成为活动会话（C-5 单会话顶替）。
6. DSH 发送 `welcome`，扩展进入 ready。
7. 断线重连后重复 1–6（token 持久化，免重配）。

## 3. 消息定义

### 3.1 信封

所有消息为 JSON 对象，必含 `v` 与 `type`；命令相关消息含 `id`（number，DSH 生成，单调递增）。

### 3.2 下行（DSH → 扩展）

| type | 字段 | 说明 |
|---|---|---|
| `welcome` | `sessionId`, `serverTime`, `heartbeatIntervalMs`(15000), `commandTimeoutMs`(60000), `maxConsentTimeoutMs`(60000) | 握手成功 |
| `command` | `id`, `name`, `args`, `consentRequired?`, `consentDomain?` | 执行命令；consentRequired=true 先走第 5 节授权流程 |
| `ping` | — | 心跳 |
| `close` | `reason` | 关闭通知（随后 WS close） |

### 3.3 上行（扩展 → DSH）

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `v`, `browser`("chrome"\|"edge"), `extensionVersion` | 握手 |
| `result` | `id`, `ok:true`, `data` | 成功 |
| `result` | `id`, `ok:false`, `error:{code,message}` | 失败 |
| `pong` | — | 心跳应答 |
| `event` | `name`, `data` | 主动事件 |

### 3.4 事件

| name | data | 触发 |
|---|---|---|
| `connected` | `{tabId,url,title}` | 连接建立后首个事件（当前活动标签页快照） |
| `tabChanged` | `{tabId,url,title,active}` | 标签页切换/激活变化 |
| `pageLoaded` | `{tabId,url,title}` | 页面 load 完成 |

授权结果**不**走事件通道，一律通过 `result` 返回（见第 5 节）。

## 4. 命令契约（10 个）

统一成功摘要（screenshot / read_page / list_tabs 除外）：
`{"ok":true,"tabId":N,"url":"…","title":"…","message":"…"}`

### 4.1 `navigate`
- args: `{"url": string}`
- 行为：活动标签页导航；等待 load 或 30s 超时。
- data：摘要（url 为最终地址）。

### 4.2 `click`
- args: `{"ref"?: number, "selector"?: string}`（二选一，ref 优先）
- 行为：目标滚动到可见后真实点击。
- 错误：`ENOTFOUND`（不存在/不可见）。

### 4.3 `type`
- args: `{"ref"?: number, "selector"?: string, "text": string, "clear"?: boolean=false}`
- 行为：聚焦输入；clear=true 先清空；password 输入框的值永不回传。
- 错误：`ENOTFOUND`。

### 4.4 `press`
- args: `{"key": string, "modifiers"?: string[]}`（Enter/Escape/Tab/ArrowUp/…；modifiers: Control/Alt/Shift/Meta）
- data：摘要。

### 4.5 `scroll`
- args: `{"direction": "up"|"down"|"top"|"bottom", "delta"?: number}`
- data：摘要。

### 4.6 `list_tabs`
- args: `{}`
- data: `{"tabs":[{"tabId":N,"url":"…","title":"…","active":bool,"pinned":bool}]}`

### 4.7 `switch_tab`
- args: `{"tabId": number}`
- 错误：`ENOTFOUND`（标签页不存在）。
- data：摘要。

### 4.8 `screenshot`
- args: `{}`
- 行为：captureVisibleTab → PNG；宽度 > 2048 降采样；base64 后 > 3MB 再降（N-2）。
- data: `{"data":"<base64>","width":N,"height":N,"mime":"image/png"}`
- 附件化由 DSH 侧完成（D-6），扩展只回 base64。

### 4.9 `read_page`
- args: `{}`
- 行为：content script 提取可交互元素树（附录 A），≤ 200 条。
- data: `{"url":"…","title":"…","elements":[…]}`（P-2）
- 敏感规则：password 输入框 value 不返回；含 `sk-`/`token=`/`password=` 的文本替换为 `<redacted>`（P-3）。

### 4.10 `run_js`
- args: `{"expression": string}`
- 策略：**DSH 默认拒绝（EPOLICY），命令不发送到扩展**（Q-3）；仅未来配置开启后才执行。
- 行为（开启时）：活动页面执行，仅返回 JSON 可序列化结果；异常 → `EJS`。
- data: `{"result": <json>}`

## 5. 授权门流程（敏感站点）

1. DSH 判定命令是否涉及敏感域名（附录 B 匹配规则）：
   - `navigate` 用目标 url 的域名；
   - 其余命令用当前活动标签页域名。
   命中 → 命令附 `consentRequired:true` 与 `consentDomain`。
2. 扩展收到 consentRequired 命令：
   a. 查 `chrome.storage.local.consentedDomains`：已授权 → 直接执行（不弹窗）；
   b. 未授权 → 弹系统通知「DSH 希望在 \<domain\> 上执行 \<command\>」，按钮 [允许] [拒绝]，
      等待 ≤ `maxConsentTimeoutMs`（60s）；
   c. 允许 → 写入 consentedDomains（默认记住，S-6），执行命令，正常回 result；
   d. 拒绝 → `result {ok:false, error:{code:"ECONSENT", message:"用户拒绝授权"}}`；
   e. 超时 → `result {ok:false, error:{code:"ECONSENT", message:"授权超时"}}`。
3. 同域名后续命令不再弹窗（本连接内 + storage 持久）。
4. popup 可查看并清除 consentedDomains（U-3）。

## 6. 心跳与保活

- DSH 每 15s 发 `ping`；扩展立即回 `pong`。
- DSH 连续 3 次未收到 pong（45s）→ 判定断线，close 并清理会话。
- 扩展 45s 无任何下行 → 判定断线 → 指数退避重连（1s→2s→4s→…→30s 上限，成功后复位）。
- 重连后重走第 2 节握手（C-4）。

> **实现要点（踩坑记录，v1.4）**：`ping`/`pong` 必须是**文本消息帧**（JSON），
> **绝不能**用 WS 协议层的 ping 帧（opcode 0x9）——浏览器协议层会静默消化协议层 ping
> 并自动回 pong，**不触发 `onmessage` 事件**，扩展 service worker 会因无事件活动被
> Chrome 空闲回收（30s），导致 WS 断开、连接反复重建。
> 扩展侧保活还依赖页面 content script 每 10s 发一条 `dsh-keepalive` 内部消息
> （扩展内部消息必然唤醒 SW，与浏览器版本的 WS 保活行为无关）。

## 7. 并发与超时

- 任一时刻至多一个在途命令：扩展串行执行；DSH 侧串行发送。
- 扩展收到上一条未完成的新命令 → 回 `EBUSY`（正常流程不应发生）。
- 命令超时：DSH 侧 `commandTimeoutMs`=60s → 回 `ETIMEOUT`；扩展侧仍需尽力完成并丢弃结果。

## 8. 错误码与关闭码

### 8.1 命令错误 `error.code`

| code | 含义 |
|---|---|
| `EAUTH` | 令牌无效（连接级，close 4401） |
| `EVERSION` | 协议版本不匹配（close 4402） |
| `ETIMEOUT` | 命令执行超时 |
| `ENOTFOUND` | 目标元素/标签页不存在 |
| `ECONSENT` | 用户拒绝或授权超时 |
| `EPOLICY` | 策略拒绝（如 run_js 默认拒绝） |
| `EJS` | JS 执行错误 |
| `EBUSY` | 已有命令执行中 |
| `EUNKNOWN` | 未知错误 |

### 8.2 WS close codes

| code | 含义 |
|---|---|
| `4400` | 协议错误（非 JSON、缺字段） |
| `4401` | EAUTH |
| `4402` | EVERSION |
| `4403` | replaced（被新连接顶替） |

## 9. 安全要求

- `welcome` 前不处理任何 command。
- 扩展不得向任何第三方转发页面数据；连接仅指向用户配置的 DSH 地址。
- 数据最小化：read_page 只回元素树；screenshot 只回图像；敏感字段截断（P-3、S-4）。
- 令牌明文仅存本机：扩展侧 chrome.storage.local，DSH 侧工作区文件。

## 10. 版本兼容

- 当前 `v=1`；DSH 只接受 v=1；扩展遇 `EVERSION` 时 popup 提示升级。
- 新增命令向后兼容：扩展对未知命令名回 `EUNKNOWN`，不得断开连接。

## 附录 A：元素树条目

```
{ type, text, role, ref, value?, placeholder?, href?, x, y, w, h, disabled? }
```

- `type`: button | link | input | textbox | checkbox | select | nav | heading | text | img | other
- `ref`: 0 起整数索引（单次 read_page 结果内稳定；页面变化后失效，需重读）
- `x/y/w/h`: 相对视口 CSS 像素
- `text` 截断：> 500 字符截断加 "…"；敏感串替换 `<redacted>`

## 附录 B：敏感类目匹配规则（DSH 侧常量，v0.1）

- 类目：`bank`（银行）、`payment`（支付）、`gov`（政务）。
- 匹配：主机名后缀匹配，含裸域（条目 `alipay.com` 命中 `alipay.com` 及任意 `*.alipay.com`）。
- v0.1 默认最小列表（实现阶段可扩充，扩充是常量变更，不破坏协议）：
  - `payment`: alipay.com, paypal.com
  - `gov`: gov.cn（含全部子域）
  - `bank`: 实现阶段给出境内主要银行域名最小集
- 说明：该列表是**授权门触发名单**，不是拦截名单（S-1、Q-4 决策）。
