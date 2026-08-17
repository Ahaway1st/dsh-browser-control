// 验证手写 SHA1 与 base64 原语（与 plugin.js 中实现逐字一致）
// 运行：node check.js

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

function bytesToHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- 断言 ----
const assert = require('node:assert');

// SHA1 标准向量
assert.strictEqual(bytesToHex(sha1('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
assert.strictEqual(bytesToHex(sha1('')), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
// RFC 6455 握手向量：key dGhlIHNhbXBsZSBub25jZQ == accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
const accept = base64Encode(sha1('dGhlIHNhbXBsZSBub25jZQ==' + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'));
assert.strictEqual(accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
// base64 编解码往返（二进制安全：0-255 全字节）
const round = [];
for (let i = 0; i < 256; i++) round.push(i);
assert.strictEqual(base64Encode(round), Buffer.from(round).toString('base64'));
// 1x1 PNG 解码（与 Buffer 基准一致）
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = base64ToBytes(png);
assert.strictEqual(pngBytes.length, Buffer.from(png, 'base64').length);
assert.strictEqual(base64Encode(pngBytes), png);
// 中文文本（UTF-8 场景）
assert.strictEqual(base64Encode(Array.from(new TextEncoder().encode('你好'))), '5L2g5aW9');
assert.strictEqual(base64Encode(base64ToBytes('5L2g5aW9')), '5L2g5aW9');

console.log('ALL CRYPTO PRIMITIVE CHECKS PASSED');
