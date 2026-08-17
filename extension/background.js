// DSH Browser Control — background service worker (MV3)
// 协议契约：docs/protocol.md v1.0
// 职责：WebSocket 连接/握手/心跳、命令路由、授权门、标签页与截图、事件上报

const CONFIG = {
  defaultWsUrl: 'ws://127.0.0.1:3080/dsh/browser',
  protocolVersion: 1,
  staleThresholdMs: 45000,        // 45s 无下行视为断线
  navigateTimeoutMs: 30000,       // navigate 页面加载等待
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  maxScreenshotWidth: 2048,
  maxScreenshotBytes: 3 * 1024 * 1024,
};

let ws = null;
let session = null;               // welcome 信息
let lastStatus = 'disconnected';
let pending = new Map();          // commandId -> { timer }
let busy = false;
let reconnectTimer = null;
let reconnectDelay = CONFIG.reconnectBaseMs;
let lastDownlink = Date.now();
let staleTimer = null;
let lastEventAt = 0;

// ---------- 状态与徽标 ----------

function setStatus(status) { lastStatus = status; }

function setBadge(text, color) {
  try { chrome.action.setBadgeText({ text: text || '' }); } catch (e) {}
  if (color) { try { chrome.action.setBadgeBackgroundColor({ color }); } catch (e) {} }
}

async function getConfig() {
  return chrome.storage.local.get({ dshWsUrl: CONFIG.defaultWsUrl, dshToken: '', consentedDomains: {} });
}

// ---------- 连接管理 ----------

function detectBrowser() {
  try {
    const ua = navigator.userAgentData;
    if (ua && ua.brands) {
      for (const b of ua.brands) {
        if (/edge/i.test(b.brand || '')) return 'edge';
      }
    }
  } catch (e) {}
  return 'chrome';
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const cfg = await getConfig();
  if (!cfg.dshToken) { setStatus('no-token'); setBadge('', ''); return; }
  const base = cfg.dshWsUrl || CONFIG.defaultWsUrl;
  const sep = base.includes('?') ? '&' : '?';
  const url = base + sep + 'token=' + encodeURIComponent(cfg.dshToken);
  let socket;
  try { socket = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = socket;
  setStatus('connecting');
  setBadge('…', '#888888');

  socket.onopen = () => {
    send({ type: 'hello', v: CONFIG.protocolVersion, browser: detectBrowser(), extensionVersion: chrome.runtime.getManifest().version });
  };

  socket.onmessage = (ev) => {
    lastDownlink = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleDownlink(msg);
  };

  socket.onclose = (ev) => {
    ws = null;
    session = null;
    clearInterval(staleTimer);
    setBadge('', '');
    failAllPending('EUNKNOWN', '连接已断开');
    if (ev.code === 4401) { setStatus('auth-failed'); return; }        // EAUTH：令牌无效，等待用户处理
    if (ev.code === 4402) { setStatus('version-mismatch'); return; }   // EVERSION
    if (ev.code === 4403) { setStatus('disconnected'); return; }       // replaced：不重连
    setStatus('disconnected');
    scheduleReconnect();
  };

  socket.onerror = () => { try { socket.close(); } catch (e) {} };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.reconnectMaxMs);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); return true; } catch (e) {}
  }
  return false;
}

function failAllPending(code, message) {
  for (const id of Array.from(pending.keys())) {
    clearTimeout(pending.get(id).timer);
    sendResult(id, false, null, { code, message });
  }
  pending.clear();
  busy = false;
}

// ---------- 下行处理 ----------

function handleDownlink(msg) {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'welcome':
      session = msg;
      reconnectDelay = CONFIG.reconnectBaseMs;
      setStatus('connected');
      setBadge('DSH', '#1a7f37');
      console.log('[dsh] welcome', msg.sessionId);
      activeSnapshot().then((snap) => sendEvent('connected', snap));
      startStaleCheck();
      break;
    case 'command':
      handleCommand(msg);
      break;
    case 'close':
      console.log('[dsh] server close:', msg.reason);
      try { ws.close(); } catch (e) {}
      break;
    default:
      break;
  }
}

function startStaleCheck() {
  clearInterval(staleTimer);
  staleTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastDownlink > CONFIG.staleThresholdMs) {
      console.log('[dsh] stale link, reconnect');
      try { ws.close(); } catch (e) {}
    }
  }, 10000);
}

// ---------- 命令处理 ----------

async function handleCommand(cmd) {
  console.log('[dsh] command start:', cmd.id, cmd.name, cmd.consentRequired ? '(consent:' + cmd.consentDomain + ')' : '');
  if (busy) {
    sendResult(cmd.id, false, null, { code: 'EBUSY', message: '已有命令执行中' });
    return;
  }
  busy = true;
  const timeout = (session && session.commandTimeoutMs) || CONFIG.commandTimeoutMs;
  const timer = setTimeout(() => {
    pending.delete(cmd.id);
    busy = false;
    sendResult(cmd.id, false, null, { code: 'ETIMEOUT', message: '命令超时' });
  }, timeout);
  pending.set(cmd.id, { timer });
  try {
    if (cmd.consentRequired) {
      const domain = cmd.consentDomain || '';
      if (!(await isConsented(domain))) {
        const answer = await askConsent(domain, cmd.name);
        if (answer !== 'granted') {
          finish(cmd.id, false, null, { code: 'ECONSENT', message: answer === 'timeout' ? '授权超时' : '用户拒绝授权' });
          return;
        }
        await rememberConsent(domain);
      }
    }
    const data = await execute(cmd);
    console.log('[dsh] command done:', cmd.id, cmd.name);
    finish(cmd.id, true, data, null);
  } catch (e) {
    console.log('[dsh] command error:', cmd.id, cmd.name, e && e.message);
    finish(cmd.id, false, null, { code: e.code || 'EUNKNOWN', message: e.message || String(e) });
  }
}

function finish(id, ok, data, error) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  busy = false;
  sendResult(id, ok, data, error);
}

function sendResult(id, ok, data, error) {
  send({ type: 'result', id, ok, data, error });
}

// ---------- 授权门 ----------

async function isConsented(domain) {
  if (!domain) return true;
  const { consentedDomains } = await chrome.storage.local.get('consentedDomains');
  return !!(consentedDomains && consentedDomains[domain]);
}

async function rememberConsent(domain) {
  if (!domain) return;
  const { consentedDomains = {} } = await chrome.storage.local.get('consentedDomains');
  consentedDomains[domain] = Date.now();
  await chrome.storage.local.set({ consentedDomains });
}

let pendingConsent = null; // { id, domain, commandName, finish } 待处理授权（popup 可确认）

function askConsent(domain, commandName) {
  return new Promise((resolve) => {
    const id = 'dsh-consent-' + Date.now();
    const timeout = (session && session.maxConsentTimeoutMs) || CONFIG.maxConsentTimeoutMs;
    const timer = setTimeout(() => finish('timeout'), timeout);
    const onButton = (nid, index) => { if (nid === id) finish(index === 0 ? 'granted' : 'denied'); };
    const onClosed = (nid) => { if (nid === id) { /* 通知被关不取消：可经 popup 确认，超时兜底 */ } };
    function finish(result) {
      if (pendingConsent && pendingConsent.id === id) pendingConsent = null;
      try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
      clearTimeout(timer);
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      try { chrome.notifications.clear(id); } catch (e) {}
      resolve(result);
    }
    pendingConsent = { id, domain, commandName, finish };
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'DSH 需要你的授权',
      message: `在 ${domain} 上执行 ${commandName}，是否允许？（也可点开扩展 popup 确认）`,
      priority: 2,
      buttons: [{ title: '允许' }, { title: '拒绝' }],
    }).catch(() => {});
    try { chrome.action.setBadgeText({ text: '!' }); } catch (e) {}
  });
}

// ---------- 命令执行 ----------

async function execute(cmd) {
  const args = cmd.args || {};
  switch (cmd.name) {
    case 'navigate': return execNavigate(args);
    case 'list_tabs': return execListTabs();
    case 'switch_tab': return execSwitchTab(args);
    case 'screenshot': return execScreenshot();
    case 'read_page': return execPageOp('read_page', {});
    case 'click': return execPageOp('click', args);
    case 'type': return execPageOp('type', args);
    case 'press': return execPageOp('press', args);
    case 'scroll': return execPageOp('scroll', args);
    case 'run_js': return execRunJs(args);
    default: throw { code: 'EUNKNOWN', message: '未知命令: ' + cmd.name };
  }
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function activeSnapshot() {
  const tab = await activeTab();
  return tab ? { tabId: tab.id, url: tab.url || '', title: tab.title || '' } : { tabId: null, url: '', title: '' };
}

function summary(tab) {
  return { ok: true, tabId: tab.id, url: tab.url || '', title: tab.title || '', message: '' };
}

async function execNavigate({ url }) {
  if (!url || !/^https?:\/\//i.test(url)) throw { code: 'EUNKNOWN', message: 'url 必须是 http(s) 地址' };
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw { code: 'ENOTFOUND', message: '没有活动标签页' };
  await chrome.tabs.update(tab.id, { url });
  await waitTabComplete(tab.id, CONFIG.navigateTimeoutMs);
  const t = await chrome.tabs.get(tab.id);
  return summary(t);
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject({ code: 'ETIMEOUT', message: '页面加载超时' }); }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    };
    function cleanup() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function execListTabs() {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map((t) => ({ tabId: t.id, url: t.url || '', title: t.title || '', active: t.active, pinned: t.pinned })) };
}

async function execSwitchTab({ tabId }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw { code: 'ENOTFOUND', message: '标签页不存在: ' + tabId };
  await chrome.tabs.update(tabId, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
  return summary(tab);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时(' + ms + 'ms)')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function execScreenshot() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw { code: 'ENOTFOUND', message: '没有活动标签页' };
  console.log('[dsh] screenshot: tab', tab.id, tab.url);
  // 主路径：CDP Page.captureScreenshot（debugger 权限）
  // 协议级渲染截图，不依赖窗口可见/聚焦/activeTab 授予；
  // 不用 SW 定时器做超时（Chrome 对无 UI 扩展的定时器不可靠），挂起由 DSH 侧 60s 兜底
  const base64 = await captureViaDebugger(tab.id);
  console.log('[dsh] screenshot: captured', base64.length, 'chars');
  // 尺寸由 DSH 侧 attachments 服务解析；这里直通 base64，
  // 避免 SW 内做解码/降采样长任务（fetch/createImageBitmap/canvas）触发 Chrome 回收 SW
  return { data: base64, width: 0, height: 0, mime: 'image/png' };
}

function captureViaDebugger(tabId) {
  return new Promise((resolve, reject) => {
    console.log('[dsh] screenshot: debugger.attach', tabId);
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const attachErr = chrome.runtime.lastError;
      if (attachErr) {
        console.log('[dsh] screenshot: attach failed', attachErr.message);
        reject(new Error('debugger attach: ' + attachErr.message));
        return;
      }
      console.log('[dsh] screenshot: attached, sendCommand Page.captureScreenshot');
      chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png', fromSurface: true }, (result) => {
        const cmdErr = chrome.runtime.lastError;
        chrome.debugger.detach({ tabId }, () => {});
        if (cmdErr) {
          console.log('[dsh] screenshot: capture failed', cmdErr.message);
          reject(new Error('CDP capture: ' + cmdErr.message));
          return;
        }
        if (result && typeof result.data === 'string') {
          console.log('[dsh] screenshot: capture ok');
          resolve(result.data);
        } else {
          console.log('[dsh] screenshot: no data');
          reject(new Error('CDP 截图无数据'));
        }
      });
    });
  });
}

async function normalizeImage(dataUrl) {
  // 解码、按宽度/体积降采样；解码失败则原样返回
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    let w = bmp.width;
    let h = bmp.height;
    let scale = Math.min(1, CONFIG.maxScreenshotWidth / w);
    for (let i = 0; i < 4 && scale < 1; i++) {
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: 'image/png' });
      const data = await blobToBase64(out);
      if (data.length <= CONFIG.maxScreenshotBytes || i === 3) return { data, width: w, height: h };
      scale = 0.7; // 体积仍超限则继续缩小
    }
    const data = await blobToBase64(blob);
    return { data, width: bmp.width, height: bmp.height };
  } catch (e) {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { data: base64, width: 0, height: 0 };
  }
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function execPageOp(op, args) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw { code: 'ENOTFOUND', message: '没有活动标签页' };
  const res = await pageOp(tab.id, op, args);
  if (!res.ok) throw res.error || { code: 'EUNKNOWN', message: '操作失败' };
  const data = res.data || {};
  if (data && typeof data === 'object' && data.tabId === null) data.tabId = tab.id;
  return data;
}

async function pageOp(tabId, op, args) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'dsh-op', op, args });
  } catch (e) {
    // content script 未注入（扩展安装前打开的页面）→ 注入后重试一次
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, { type: 'dsh-op', op, args });
  }
}

async function execRunJs({ expression }) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) throw { code: 'ENOTFOUND', message: '没有活动标签页' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'MAIN',
      func: (expr) => {
        try {
          const value = (0, eval)(expr);
          return { result: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
        } catch (e) {
          return { error: { message: String((e && e.message) || e) } };
        }
      },
      args: [expression],
    });
    const out = results && results[0] && results[0].result;
    if (!out) throw { code: 'EUNKNOWN', message: '无执行结果' };
    if (out.error) throw { code: 'EJS', message: out.error.message };
    return { result: out.result };
  } catch (e) {
    if (e.code) throw e;
    throw { code: 'EJS', message: e.message || String(e) };
  }
}

// ---------- 事件上报 ----------

function sendEvent(name, data) {
  if (!session || !ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastEventAt < 300) return; // 节流
  lastEventAt = now;
  send({ type: 'event', name, data });
}

chrome.tabs.onActivated.addListener(() => {
  activeSnapshot().then((snap) => sendEvent('tabChanged', snap));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') {
    activeSnapshot().then((snap) => sendEvent('pageLoaded', snap));
  }
});

// ---------- 保活与生命周期 ----------

chrome.alarms.create('dsh-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-keepalive') return;
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});

chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(() => { connect(); });
connect();

// ---------- SW 保活 Port ----------
// 活跃的 chrome.runtime Port 会让 SW 不被 Chrome 空闲回收（Chrome 116+）。
// content script 建立 'dsh-keepalive' 长连接；这里持有引用防止 GC。
const keepalivePorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-keepalive') return;
  keepalivePorts.add(port);
  port.onDisconnect.addListener(() => keepalivePorts.delete(port));
});

// ---------- popup 消息 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'dsh-keepalive') { sendResponse({ ok: true }); return true; } // content script 保活唤醒
  if (msg.type === 'getConsent') {
    sendResponse(pendingConsent ? { id: pendingConsent.id, domain: pendingConsent.domain, commandName: pendingConsent.commandName } : null);
    return true;
  }
  if (msg.type === 'decideConsent') {
    if (pendingConsent && pendingConsent.id === msg.id) {
      pendingConsent.finish(msg.granted ? 'granted' : 'denied');
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'getState') {
    (async () => {
      const cfg = await getConfig();
      const snap = await activeSnapshot();
      sendResponse({
        status: lastStatus,
        sessionId: session ? session.sessionId : null,
        wsUrl: cfg.dshWsUrl,
        token: cfg.dshToken,
        consentedDomains: cfg.consentedDomains || {},
        tab: snap,
        version: chrome.runtime.getManifest().version,
      });
    })();
    return true;
  }
  if (msg.type === 'connect') {
    (async () => {
      await chrome.storage.local.set({
        dshToken: (msg.token || '').trim(),
        dshWsUrl: (msg.wsUrl || '').trim() || CONFIG.defaultWsUrl,
      });
      reconnectDelay = CONFIG.reconnectBaseMs;
      await connect();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'disconnect') {
    if (ws) { try { ws.close(); } catch (e) {} }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'clearConsent') {
    (async () => {
      const { consentedDomains = {} } = await chrome.storage.local.get('consentedDomains');
      delete consentedDomains[msg.domain];
      await chrome.storage.local.set({ consentedDomains });
      sendResponse({ ok: true });
    })();
    return true;
  }
});
