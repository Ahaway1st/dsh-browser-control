// 裸 TCP WS 客户端：完全可控的标准 RFC 6455 masked 帧，绕开 undici，
// 验证 DSH 侧对"标准帧"的解析是否正常（对照模拟扩展的 undici 客户端）。
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function resolveToken() {
  if (process.env.DSH_BROWSER_TOKEN) return process.env.DSH_BROWSER_TOKEN;
  try { return fs.readFileSync(path.join(__dirname, '..', '.dsh-browser-token'), 'utf8').trim(); } catch (e) {}
  throw new Error('未找到配对令牌：设置 DSH_BROWSER_TOKEN 环境变量，或提供 plugin/.dsh-browser-token');
}
const token = resolveToken();
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function buildMaskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) header = Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  else { const l = payload.length; header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, (l >>> 24) & 0xff, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff]); }
  return Buffer.concat([header, mask, masked]);
}

const sock = net.connect(3080, '127.0.0.1');
let upgraded = false;
let rx = Buffer.alloc(0);

sock.on('connect', () => {
  const key = crypto.randomBytes(16).toString('base64');
  sock.write('GET /dsh/browser?token=' + token + ' HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
});

sock.on('data', (chunk) => {
  rx = Buffer.concat([rx, chunk]);
  if (!upgraded) {
    const idx = rx.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = rx.subarray(0, idx).toString();
    console.log('RAW: HTTP', head.split('\r\n')[0]);
    if (!head.includes('101')) { console.log('RAW: 握手失败'); process.exit(1); }
    rx = rx.subarray(idx + 4);
    upgraded = true;
    sock.write(buildMaskedFrame(JSON.stringify({ type: 'hello', v: 1, browser: 'raw', extensionVersion: 'test' })));
    return;
  }
  for (;;) {
    if (rx.length < 2) break;
    const b0 = rx[0], b1 = rx[1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) { if (rx.length < 4) break; len = (rx[2] << 8) | rx[3]; offset = 4; }
    else if (len === 127) { if (rx.length < 10) break; len = 0; for (let i = 0; i < 8; i++) len = len * 256 + rx[offset + i]; offset = 10; }
    if (rx.length < offset + len) break;
    const payload = rx.subarray(offset, offset + len);
    rx = rx.subarray(offset + len);
    if (opcode === 0x9) { sock.write(Buffer.from([0x8a, 0x00])); continue; }
    if (opcode !== 0x1) continue;
    const text = payload.toString('utf8');
    let msg;
    try { msg = JSON.parse(text); } catch (e) { console.log('RAW: JSON 解析失败:', text.slice(0, 80)); continue; }
    if (msg.type === 'welcome') {
      console.log('RAW: welcome', msg.sessionId);
      sock.write(buildMaskedFrame(JSON.stringify({ type: 'event', name: 'connected', data: { tabId: 1, url: 'https://example.com', title: 'Raw' } })));
    } else if (msg.type === 'ping') {
      sock.write(buildMaskedFrame(JSON.stringify({ type: 'pong' })));
    } else if (msg.type === 'command') {
      console.log('RAW: command', msg.name, 'replying 1x1 PNG...');
      sock.write(buildMaskedFrame(JSON.stringify({ type: 'result', id: msg.id, ok: true, data: { data: PNG1x1, width: 0, height: 0, mime: 'image/png' } })));
      console.log('RAW: replied');
    } else if (msg.type === 'close') {
      console.log('RAW: server close', msg.reason);
    }
  }
});
sock.on('error', (e) => console.log('RAW: error', e.message));
sock.on('close', () => { console.log('RAW: closed'); process.exit(0); });
setTimeout(() => { console.log('RAW: 60s exit'); process.exit(0); }, 60000);
