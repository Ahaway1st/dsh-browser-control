// WS 心跳探针：连接插件 WebSocket，只握手（不发 hello，不顶替活动连接），
// 观察 DSH 是否每 ~15s 发送 ping 帧。运行 50 秒后自动退出。
const fs = require('node:fs');
const path = require('node:path');
function resolveToken() {
  if (process.env.DSH_BROWSER_TOKEN) return process.env.DSH_BROWSER_TOKEN;
  try { return fs.readFileSync(path.join(__dirname, '..', '.dsh-browser-token'), 'utf8').trim(); } catch (e) {}
  throw new Error('未找到配对令牌：设置 DSH_BROWSER_TOKEN 环境变量，或提供 plugin/.dsh-browser-token');
}
const token = resolveToken();
const ws = new WebSocket('ws://127.0.0.1:3080/dsh/browser?token=' + token);
let lastPing = null;
let count = 0;
const started = Date.now();

ws.onopen = () => { console.log('PROBE: open at', new Date().toISOString()); };
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  const now = Date.now();
  if (msg.type === 'ping') {
    count++;
    const gap = lastPing === null ? '-' : (now - lastPing) + 'ms';
    console.log(`PROBE: ping#${count} gap=${gap} t=${(now - started)}ms`);
    lastPing = now;
    try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
  } else if (msg.type === 'welcome') {
    console.log('PROBE: unexpected welcome', msg.sessionId);
  } else if (msg.type === 'command') {
    console.log('PROBE: unexpected command', msg.name);
  } else if (msg.type === 'close') {
    console.log('PROBE: server close:', msg.reason);
  }
};
ws.onclose = (ev) => { console.log('PROBE: closed', ev.code, ev.reason || '', 'after', (Date.now() - started) + 'ms'); process.exit(0); };
ws.onerror = (e) => { console.log('PROBE: error', e && e.message || e); };

setTimeout(() => {
  console.log(`PROBE: done, received ${count} pings in ${(Date.now() - started)}ms`);
  try { ws.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 500);
}, 50000);
