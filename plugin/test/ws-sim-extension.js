// 模拟扩展：hello 成为 activeConn，收到命令后回 3MB 伪截图数据。
// 目的：验证 DSH 侧大帧（截图 base64）接收/解析/附件保存链路是否通畅。
// 注意：会顶替真实扩展连接（replaced），测试完扩展需手动重连（点图标或刷新）。
const fs = require('node:fs');
const path = require('node:path');
function resolveToken() {
  if (process.env.DSH_BROWSER_TOKEN) return process.env.DSH_BROWSER_TOKEN;
  try { return fs.readFileSync(path.join(__dirname, '..', '.dsh-browser-token'), 'utf8').trim(); } catch (e) {}
  throw new Error('未找到配对令牌：设置 DSH_BROWSER_TOKEN 环境变量，或提供 plugin/.dsh-browser-token');
}
const token = resolveToken();
const ws = new WebSocket('ws://127.0.0.1:3080/dsh/browser?token=' + token);
// 1x1 透明 PNG（合法图片，验证 DSH 附件保存链路）
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// 3MB 垃圾 base64（验证大帧性能）
const BIG = 'A'.repeat(3 * 1024 * 1024);
const useValidPng = process.argv[2] !== 'big';
const payload = useValidPng ? PNG1x1 : BIG;

ws.onopen = () => {
  console.log('SIM: open, sending hello');
  ws.send(JSON.stringify({ type: 'hello', v: 1, browser: 'sim', extensionVersion: 'test' }));
};
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (msg.type === 'welcome') {
    console.log('SIM: welcome', msg.sessionId);
    ws.send(JSON.stringify({ type: 'event', name: 'connected', data: { tabId: 1, url: 'https://example.com', title: 'Sim' } }));
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  } else if (msg.type === 'command') {
    const t0 = Date.now();
    console.log('SIM: command', msg.id, msg.name, 'replying', useValidPng ? '1x1-PNG' : '3MB-garbage', '...');
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: { data: payload, width: 0, height: 0, mime: 'image/png' } }));
    console.log('SIM: replied in', Date.now() - t0, 'ms');
  } else if (msg.type === 'close') {
    console.log('SIM: server close:', msg.reason);
  }
};
ws.onclose = (ev) => { console.log('SIM: closed', ev.code, ev.reason || ''); process.exit(0); };
ws.onerror = (e) => { console.log('SIM: error', e && e.message || e); };

setTimeout(() => { console.log('SIM: 90s timeout, exiting'); process.exit(0); }, 90000);
