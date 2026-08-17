// DSH Browser Control — Host 插件（动态 Cordis 插件，Host 半）
// 协议契约：docs/protocol.md v1.0（与 extension/ 扩展对应）
// v1.8：移除硬编码配对令牌（配置文件/随机生成 + browser_pairing_code 工具查询）
// v1.7：跨 realm Uint8Array 修复（attachments/sharp instanceof）；v1.6：socket 读缓冲修复；
// v1.5：帧缓冲 Uint8Array 化；v1.4：心跳文本消息；v1.3：clearTimeout 崩溃修复
// 运行环境约束（node:vm 沙箱）：无 require/fetch/crypto/Buffer/URL/setTimeout/clearTimeout；
// SHA1 与 base64 为手写实现（见 plugin/test/check.js）。

return {
  inject: ['timer', 'webServer', 'attachments', 'fs'],
  async apply(ctx) {
    const WS_PATH = '/dsh/browser';
    const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const PROTOCOL_VERSION = 1;
    const HEARTBEAT_INTERVAL_MS = 15000;
    const STALE_MS = 45000;
    const COMMAND_TIMEOUT_MS = 60000;
    const CONSENT_TIMEOUT_MS = 60000;
    const TOKEN_FILE = '.dsh-browser-token'; // 令牌持久化文件（相对 DSH 工作目录；可改为绝对路径）
    const SENSITIVE_DOMAINS = {
      bank: ['icbc.com.cn', 'ccb.com', 'abchina.com', 'boc.cn', 'bankcomm.com', 'cmbchina.com', 'psbc.com'],
      payment: ['alipay.com', 'paypal.com'],
      gov: ['gov.cn'],
    };

    let token = null;
    const conns = new Set();
    let activeConn = null;
    let activeUrl = '';
    let cmdSeq = 1;
    const pending = new Map();
    const queue = [];
    let sending = false;

    function sha1(input) {
      const bytes = [];
      for (let i = 0; i < input.length; i++) bytes.push(input.charCodeAt(i) & 0xff);
      const ml = bytes.length * 8;
      bytes.push(0x80);
      while (bytes.length % 64 !== 56) bytes.push(0);
      for (let i = 7; i >= 0; i--) bytes.push((ml / Math.pow(2, i * 8)) & 0xff);
      let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
      const w = new Array(80);
      for (let i = 0; i < bytes.length; i += 64) {
        for (let j = 0; j < 16; j++) {
          w[j] = ((bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3]) >>> 0;
        }
        for (let j = 16; j < 80; j++) {
          const n = (w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]);
          w[j] = ((n << 1) | (n >>> 31)) >>> 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4;
        for (let j = 0; j < 80; j++) {
          let f, k;
          if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
          else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
          else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
          else { f = b ^ c ^ d; k = 0xCA62C1D6; }
          const temp = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0) >>> 0;
          e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
        }
        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
      }
      return [h0, h1, h2, h3, h4].flatMap((h) => [h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]);
    }

    const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    function base64Encode(bytes) {
      let out = '';
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        out += B64_ALPHABET[b0 >> 2];
        out += B64_ALPHABET[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
        out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
        out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
      }
      return out;
    }

    function base64ToBytes(str) {
      const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
      const out = [];
      let buffer = 0, bits = 0;
      for (const ch of clean) {
        if (ch === '=') break;
        const v = B64_ALPHABET.indexOf(ch);
        if (v < 0) continue;
        buffer = (buffer << 6) | v;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out.push((buffer >> bits) & 0xff);
        }
      }
      return out;
    }

    function wsSendFrame(socket, opcode, payload) {
      if (!socket || socket.destroyed) return;
      const len = payload.length;
      const head = [0x80 | opcode];
      if (len < 126) head.push(len);
      else if (len < 65536) head.push(126, (len >> 8) & 0xff, len & 0xff);
      else head.push(127, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
      const out = new Uint8Array(head.length + len);
      for (let i = 0; i < head.length; i++) out[i] = head[i];
      for (let i = 0; i < len; i++) out[head.length + i] = payload[i];
      socket.write(out);
    }

    function wsSendText(socket, text) {
      wsSendFrame(socket, 0x1, new TextEncoder().encode(text));
    }

    function wsDecodeFrame(buf) {
      // buf: Uint8Array（大帧如截图 base64 数 MB，逐字节数组会极慢）
      if (buf.length < 2) return null;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return null;
        len = (buf[2] << 8) | buf[3];
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return null;
        len = 0;
        for (let i = 0; i < 8; i++) len = len * 256 + buf[offset + i];
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return null;
      let payload;
      if (masked) {
        payload = new Uint8Array(len);
        const key = buf.subarray(offset, offset + 4);
        const start = offset + maskLen;
        for (let i = 0; i < len; i++) payload[i] = buf[start + i] ^ key[i % 4];
      } else {
        payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      }
      return { opcode, payload, consumed: offset + maskLen + len };
    }

    async function upgradeHandler(req, socket) {
      try {
        const raw = req.url || '/';
        const qIndex = raw.indexOf('?');
        const query = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
        const params = {};
        for (const pair of query.split('&')) {
          if (!pair) continue;
          const eq = pair.indexOf('=');
          const k = eq >= 0 ? pair.slice(0, eq) : pair;
          const v = eq >= 0 ? pair.slice(eq + 1) : '';
          params[decodeURIComponent(k)] = decodeURIComponent(v);
        }
        if ((params.token || '') !== token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nEAUTH: invalid token');
          socket.end();
          return;
        }
        const key = req.headers['sec-websocket-key'];
        if (!key || String(req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nbad websocket upgrade request');
          socket.end();
          return;
        }
        const accept = base64Encode(sha1(String(key) + WS_GUID));
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const conn = { socket, buf: new Uint8Array(0), lastUp: Date.now(), sessionId: null, closed: false };
        conns.add(conn);
        socket.on('data', (chunk) => onSocketData(conn, chunk));
        socket.on('close', () => onSocketClose(conn));
        socket.on('error', () => {});
      } catch (e) {
        try { socket.destroy(); } catch (e2) {}
      }
    }

    function onSocketData(conn, chunk) {
      try {
        // 总是拷贝合并（不能直接引用 chunk：Node 会复用 socket 读缓冲，
        // 直接引用会在后续 data 事件中被覆盖，导致大帧数据损坏）
        const merged = new Uint8Array(conn.buf.length + chunk.length);
        merged.set(conn.buf);
        merged.set(chunk, conn.buf.length);
        conn.buf = merged;
        for (;;) {
          const frame = wsDecodeFrame(conn.buf);
          if (!frame) break;
          conn.buf = conn.buf.subarray(frame.consumed); // O(1) 截断
          handleFrame(conn, frame);
          if (conn.closed) break;
        }
      } catch (e) {
        console.error('[browser-control] frame error:', e && e.message);
        try { closeConn(conn, 4400, 'protocol error'); } catch (e2) {}
      }
    }

    function handleFrame(conn, frame) {
      conn.lastUp = Date.now();
      if (frame.opcode === 0x8) {
        wsSendFrame(conn.socket, 0x8, []);
        conn.closed = true;
        try { conn.socket.end(); } catch (e) {}
        return;
      }
      if (frame.opcode === 0x9) {
        wsSendFrame(conn.socket, 0xa, frame.payload);
        return;
      }
      if (frame.opcode === 0x1) {
        const text = new TextDecoder().decode(frame.payload);
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        handleMessage(conn, msg);
      }
    }

    function closeConn(conn, code, reason) {
      if (conn.closed) return;
      conn.closed = true;
      conns.delete(conn);
      if (activeConn === conn) activeConn = null;
      if (reason) console.log('[browser-control] closing', conn.sessionId || 'pre-session', reason);
      try { wsSendFrame(conn.socket, 0x8, [code >> 8, code & 0xff]); } catch (e) {}
      try { conn.socket.end(); } catch (e) {}
      flushPendingFor(conn, 'EUNKNOWN: 连接已关闭');
    }

    function onSocketClose(conn) {
      conn.closed = true;
      conns.delete(conn);
      if (activeConn === conn) {
        activeConn = null;
        console.log('[browser-control] extension disconnected');
      }
      flushPendingFor(conn, 'EUNKNOWN: 扩展连接已断开');
    }

    function flushPendingFor(conn, message) {
      for (const [id, p] of Array.from(pending.entries())) {
        if (p.conn === conn) {
          try { p.timer(); } catch (e) {}
          pending.delete(id);
          p.reject(new Error(message));
        }
      }
      for (let i = queue.length - 1; i >= 0; i--) queue[i].reject(new Error(message));
      queue.length = 0;
      sending = false;
      pump();
    }

    function handleMessage(conn, msg) {
      switch (msg.type) {
        case 'hello': {
          if (msg.v !== PROTOCOL_VERSION) { closeConn(conn, 4402, 'EVERSION'); return; }
          if (activeConn && activeConn !== conn) {
            try { wsSendText(activeConn.socket, JSON.stringify({ type: 'close', reason: 'replaced' })); } catch (e) {}
            closeConn(activeConn, 4403, 'replaced by new connection');
          }
          activeConn = conn;
          conn.sessionId = 'sess-' + (cmdSeq++);
          console.log('[browser-control] extension connected:', msg.browser || '?', msg.extensionVersion || '?', 'session', conn.sessionId);
          wsSendText(conn.socket, JSON.stringify({
            type: 'welcome',
            v: PROTOCOL_VERSION,
            sessionId: conn.sessionId,
            serverTime: Date.now(),
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            commandTimeoutMs: COMMAND_TIMEOUT_MS,
            maxConsentTimeoutMs: CONSENT_TIMEOUT_MS,
          }));
          break;
        }
        case 'result': {
          const p = pending.get(msg.id);
          if (!p) break;
          try { p.timer(); } catch (e) {}
          pending.delete(msg.id);
          sending = false;
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(((msg.error && msg.error.code) || 'EUNKNOWN') + ': ' + ((msg.error && msg.error.message) || '扩展执行失败')));
          pump();
          break;
        }
        case 'event': {
          console.log('[browser-control] event:', msg.name, msg.data ? JSON.stringify(msg.data).slice(0, 300) : '');
          if ((msg.name === 'connected' || msg.name === 'tabChanged' || msg.name === 'pageLoaded') && msg.data && typeof msg.data.url === 'string') {
            activeUrl = msg.data.url;
          }
          break;
        }
        case 'pong':
          break;
        default:
          break;
      }
    }

    function sendCommand(name, args, opts) {
      return new Promise((resolve, reject) => {
        if (!activeConn) {
          reject(new Error('EUNKNOWN: 扩展未连接 — 请先在浏览器扩展 popup 中粘贴配对令牌并连接'));
          return;
        }
        const cmd = { type: 'command', id: cmdSeq++, name, args: args || {} };
        if (opts && opts.consentRequired) {
          cmd.consentRequired = true;
          cmd.consentDomain = opts.consentDomain;
        }
        queue.push({ cmd, resolve, reject });
        pump();
      });
    }

    function pump() {
      if (sending || !activeConn || queue.length === 0) return;
      sending = true;
      const item = queue.shift();
      const timer = ctx.timeout(() => {
        pending.delete(item.cmd.id);
        sending = false;
        item.reject(new Error('ETIMEOUT: 命令超时（扩展无响应）'));
        pump();
      }, COMMAND_TIMEOUT_MS);
      pending.set(item.cmd.id, { conn: activeConn, resolve: item.resolve, reject: item.reject, timer });
      try {
        wsSendText(activeConn.socket, JSON.stringify(item.cmd));
      } catch (e) {
        try { timer(); } catch (e2) {}
        pending.delete(item.cmd.id);
        sending = false;
        item.reject(new Error('EUNKNOWN: 命令发送失败'));
        pump();
      }
    }

    function heartbeat() {
      const now = Date.now();
      for (const conn of Array.from(conns)) {
        if (conn.closed) continue;
        // 用文本消息而非 WS 协议层 ping 帧：浏览器对协议层 ping 自动消化，
        // 不触发 onmessage 事件，service worker 会被 Chrome 空闲回收
        try { wsSendText(conn.socket, '{"type":"ping"}'); } catch (e) {}
        if (now - conn.lastUp > STALE_MS) {
          console.log('[browser-control] stale connection closed');
          closeConn(conn, 4400, 'stale');
        }
      }
    }

    function hostOfUrl(url) {
      let u = String(url || '').trim();
      u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      u = u.split('/')[0].split('?')[0].split('#')[0];
      if (u.startsWith('[')) {
        const close = u.indexOf(']');
        if (close >= 0) return u.slice(1, close).toLowerCase();
      }
      const colon = u.lastIndexOf(':');
      if (colon >= 0) u = u.slice(0, colon);
      return u.toLowerCase();
    }

    function isSensitive(host) {
      if (!host) return false;
      for (const list of Object.values(SENSITIVE_DOMAINS)) {
        for (const suffix of list) {
          if (host === suffix || host.endsWith('.' + suffix)) return true;
        }
      }
      return false;
    }

    function consentFor(host) {
      return isSensitive(host) ? { consentRequired: true, consentDomain: host } : undefined;
    }

    async function requireConnected() {
      if (!activeConn) throw new Error('EUNKNOWN: 扩展未连接 — 请先在浏览器扩展 popup 中粘贴配对令牌并连接');
    }

    function makeTool(name, description, parameters, execute) {
      return harness.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute,
      });
    }

    const tools = [
      makeTool(
        'browser_pairing_code',
        '返回浏览器扩展的配对令牌与连接地址。用户在浏览器扩展 popup 中粘贴该令牌后点「连接」即可完成配对。',
        {},
        async () => ({
          pairingCode: token,
          endpoint: 'ws://127.0.0.1:3080' + WS_PATH,
          connected: !!activeConn,
          sessionId: activeConn ? activeConn.sessionId : null,
        }),
      ),
      makeTool(
        'browser_navigate',
        '在浏览器活动标签页中导航到指定 URL。目标为敏感站点（银行/支付/政务）时，扩展会弹出授权通知，需要用户允许后才能执行。',
        {
          url: { type: 'string', required: true, description: '目标 http(s) URL，如 https://example.com' },
        },
        async (args) => {
          await requireConnected();
          const url = String(args.url || '').trim();
          if (!/^https?:\/\//i.test(url)) throw new Error('EUNKNOWN: url 必须是 http(s) 地址');
          const data = await sendCommand('navigate', { url }, consentFor(hostOfUrl(url)));
          if (data && typeof data.url === 'string') activeUrl = data.url;
          return data;
        },
      ),
      makeTool(
        'browser_click',
        '在浏览器当前页面点击元素。目标可用 browser_read_page 返回的元素 ref 索引，或 CSS 选择器。敏感站点操作需用户授权。',
        {
          ref: { type: 'integer', description: '元素树 ref 索引（来自 browser_read_page 的 elements[].ref）' },
          selector: { type: 'string', description: 'CSS 选择器，ref 与 selector 二选一（ref 优先）' },
        },
        async (args) => {
          await requireConnected();
          return sendCommand('click', { ref: args.ref, selector: args.selector }, consentFor(hostOfUrl(activeUrl)));
        },
      ),
      makeTool(
        'browser_type',
        '在浏览器当前页面的输入框中输入文本。密码框的值不会被回传。敏感站点操作需用户授权。',
        {
          ref: { type: 'integer', description: '元素树 ref 索引' },
          selector: { type: 'string', description: 'CSS 选择器，ref 与 selector 二选一（ref 优先）' },
          text: { type: 'string', required: true, description: '要输入的文本' },
          clear: { type: 'boolean', description: '是否先清空输入框（默认 false）' },
        },
        async (args) => {
          await requireConnected();
          return sendCommand('type', { ref: args.ref, selector: args.selector, text: args.text, clear: !!args.clear }, consentFor(hostOfUrl(activeUrl)));
        },
      ),
      makeTool(
        'browser_press',
        '在浏览器当前页面发送按键事件（Enter/Escape/Tab/ArrowUp 等，可带修饰键）。敏感站点操作需用户授权。',
        {
          key: { type: 'string', required: true, description: '按键名，如 Enter、Escape、Tab、ArrowDown' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Alt', 'Shift', 'Meta'] }, description: '修饰键列表（可选）' },
        },
        async (args) => {
          await requireConnected();
          return sendCommand('press', { key: args.key, modifiers: args.modifiers }, consentFor(hostOfUrl(activeUrl)));
        },
      ),
      makeTool(
        'browser_scroll',
        '滚动浏览器当前页面。敏感站点操作需用户授权。',
        {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: '滚动方向' },
          delta: { type: 'number', description: '滚动像素量（up/down 时有效，默认 600）' },
        },
        async (args) => {
          await requireConnected();
          return sendCommand('scroll', { direction: args.direction, delta: args.delta }, consentFor(hostOfUrl(activeUrl)));
        },
      ),
      makeTool(
        'browser_list_tabs',
        '列出浏览器所有标签页（id、URL、标题、是否激活、是否固定）。只读操作，不触发授权。',
        {},
        async () => {
          await requireConnected();
          return sendCommand('list_tabs', {});
        },
      ),
      makeTool(
        'browser_switch_tab',
        '切换到指定标签页。目标页面为敏感站点时需用户授权。',
        {
          tabId: { type: 'integer', required: true, description: '标签页 id（来自 browser_list_tabs）' },
        },
        async (args) => {
          await requireConnected();
          return sendCommand('switch_tab', { tabId: args.tabId }, consentFor(hostOfUrl(activeUrl)));
        },
      ),
      makeTool(
        'browser_screenshot',
        '截取浏览器当前活动标签页的可见区域，并自动保存为 DSH 会话附件（GUI 中可直接查看）。只读操作，不触发授权。',
        {},
        async () => {
          await requireConnected();
          const data = await sendCommand('screenshot', {});
          if (!data || typeof data.data !== 'string') throw new Error('EUNKNOWN: 截图返回异常');
          // 跨 realm 陷阱：沙箱里 new/Uint8Array.from 创建的是沙箱 realm 的 Uint8Array，
          // 宿主 attachments(sharp) 用 instanceof Uint8Array 检查会失败（"Unsupported input"）。
          // 修复：用宿主注入的 TextEncoder 创建宿主 realm 的 Uint8Array 再填充字节。
          const byteList = base64ToBytes(data.data);
          const hostBytes = new TextEncoder().encode('\0'.repeat(byteList.length));
          for (let i = 0; i < byteList.length; i++) hostBytes[i] = byteList[i];
          const refs = await ctx.attachments.saveImages([{ data: hostBytes, mediaType: 'image/png', name: 'browser-screenshot.png' }]);
          const ref = refs && refs[0];
          if (!ref) throw new Error('EUNKNOWN: 截图附件保存失败');
          return {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            note: '截图已保存为会话附件（模型不可直接看图，以 browser_read_page 元素树为准）',
          };
        },
      ),
      makeTool(
        'browser_read_page',
        '读取浏览器当前页面的可交互元素树（文本化描述：按钮/链接/输入框/标题等，含 ref 索引），供后续点击/输入定位。只读操作，不触发授权。',
        {},
        async () => {
          await requireConnected();
          const data = await sendCommand('read_page', {});
          if (data && typeof data.url === 'string') activeUrl = data.url;
          return data;
        },
      ),
      makeTool(
        'browser_run_js',
        '在浏览器当前页面执行任意 JavaScript。当前策略默认拒绝（EPOLICY），如确需启用需修改插件策略。',
        {
          expression: { type: 'string', required: true, description: '要执行的 JS 表达式' },
        },
        async () => {
          throw new Error('EPOLICY: browser_run_js 默认被策略拒绝（需求 Q-3 决策），当前版本不执行任意 JS');
        },
      ),
    ];

    // ================= 令牌（无硬编码：配置文件优先，否则随机生成并持久化） =================

    function randomHex(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
      return s;
    }

    async function loadToken() {
      try {
        const target = await ctx.fs.resolve(TOKEN_FILE);
        const text = await ctx.fs.readText(target);
        const t = (text || '').trim();
        if (t) return t;
      } catch (e) {
        console.log('[browser-control] token read failed:', e.message);
      }
      return null;
    }

    async function saveToken(t) {
      try {
        const target = await ctx.fs.resolve(TOKEN_FILE);
        await ctx.fs.writeText(target, t + '\n');
      } catch (e) {
        console.log('[browser-control] token persist failed:', e.message, '（令牌仅在本次运行有效）');
      }
    }

    token = await loadToken();
    if (!token) {
      token = 'dsh-' + randomHex(32);
      await saveToken(token);
    }
    console.log('[browser-control] pairing token: ' + token);
    console.log('[browser-control] WebSocket endpoint: ws://127.0.0.1:3080' + WS_PATH);

    const disposers = [];
    disposers.push(harness.handle('get-pairing-info', () => ({
      pairingCode: token,
      endpoint: 'ws://127.0.0.1:3080' + WS_PATH,
      connected: !!activeConn,
      sessionId: activeConn ? activeConn.sessionId : null,
    })));
    disposers.push(ctx.webServer.registerUpgrade({ path: WS_PATH, handler: upgradeHandler }));
    disposers.push(ctx.interval(() => heartbeat(), HEARTBEAT_INTERVAL_MS));
    for (const tool of tools) disposers.push(harness.registerTool(ctx, tool));

    ctx.effect(() => () => {
      for (const d of disposers) { try { d(); } catch (e) {} }
      for (const conn of Array.from(conns)) { try { conn.socket.destroy(); } catch (e) {} }
      conns.clear();
      activeConn = null;
    }, 'browser-control.cleanup');
  },
};
