// 帧解析逻辑测试：构造 masked WS 帧 + TCP 分包模拟，验证解析正确性
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 与 plugin.js 一致的 wsDecodeFrame
function wsDecodeFrame(buf) {
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

// 构造 masked text 帧（模拟 node WebSocket 客户端发送）
function buildMaskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  } else {
    const l = payload.length;
    // 标准 127 长度扩展：8 字节大端（l < 2^32 时高 4 字节为 0）
    header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, (l >>> 24) & 0xff, (l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff]);
  }
  return Buffer.concat([header, mask, masked]);
}

// 与 plugin.js 一致的 onSocketData 累积逻辑（模拟 TCP 分包，每块 7 字节）
function feedChunks(conn, chunks) {
  const messages = [];
  for (const chunk of chunks) {
    const merged = new Uint8Array(conn.buf.length + chunk.length);
    merged.set(conn.buf);
    merged.set(chunk, conn.buf.length);
    conn.buf = merged;
    for (;;) {
      const frame = wsDecodeFrame(conn.buf);
      if (!frame) break;
      conn.buf = conn.buf.subarray(frame.consumed);
      if (frame.opcode === 0x1) {
        messages.push(new TextDecoder().decode(frame.payload));
      }
    }
  }
  return messages;
}

// 测试 1：1x1 PNG 消息，分包 7 字节
const msg1 = JSON.stringify({ type: 'result', id: 1, ok: true, data: { data: PNG1x1, width: 0, height: 0, mime: 'image/png' } });
const frame1 = buildMaskedFrame(msg1);
const chunks1 = [];
for (let i = 0; i < frame1.length; i += 7) chunks1.push(frame1.subarray(i, i + 7));
const conn1 = { buf: new Uint8Array(0) };
const msgs1 = feedChunks(conn1, chunks1);
console.log('测试1 消息数:', msgs1.length);
console.log('测试1 解析后 data.data 正确:', msgs1.length === 1 && JSON.parse(msgs1[0]).data.data === PNG1x1);
if (msgs1.length === 1) {
  const parsed = JSON.parse(msgs1[0]);
  console.log('测试1 data.data 长度:', parsed.data.data.length, '头 20 字符:', parsed.data.data.slice(0, 20));
}

// 测试 2：3MB 垃圾数据（126 长度扩展路径不覆盖，测 65536+ 127 路径），分包 65536
const big = 'A'.repeat(70000);
const msg2 = JSON.stringify({ type: 'result', id: 2, ok: true, data: { data: big, width: 0, height: 0, mime: 'image/png' } });
const frame2 = buildMaskedFrame(msg2);
console.log('测试2 帧总长:', frame2.length, '（>64KB 应走 127 长度扩展）');
const chunks2 = [];
for (let i = 0; i < frame2.length; i += 10000) chunks2.push(frame2.subarray(i, i + 10000));
const conn2 = { buf: new Uint8Array(0) };
const msgs2 = feedChunks(conn2, chunks2);
console.log('测试2 消息数:', msgs2.length);
console.log('测试2 解析正确:', msgs2.length === 1 && JSON.parse(msgs2[0]).data.data === big);

// 测试 3：多消息同 chunk（hello + pong 连发）
const msg3 = JSON.stringify({ type: 'pong' });
const frame3a = buildMaskedFrame(msg3);
const frame3b = buildMaskedFrame(msg3);
const conn3 = { buf: new Uint8Array(0) };
const msgs3 = feedChunks(conn3, [Buffer.concat([frame3a, frame3b])]);
console.log('测试3 两消息解析:', msgs3.length === 2 && msgs3.every((m) => JSON.parse(m).type === 'pong'));
