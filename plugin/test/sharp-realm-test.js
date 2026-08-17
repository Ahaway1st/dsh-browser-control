// 验证：sharp 对 vm 沙箱 realm Uint8Array 的行为（跨 realm instanceof 假设）
const vm = require('node:vm');

// sharp 是 dsh-attachment-local 的依赖；此处尝试通用加载，失败时提示安装
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.log('sharp 未找到（它是 DSH attachments 服务的依赖）。');
  console.log('可在 DSH 安装目录下运行：npm install sharp，或修改本脚本的 sharp 路径。');
  process.exit(1);
}

// 1x1 PNG 字节（从 base64 解码）
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngBytes = Buffer.from(PNG1x1, 'base64');
console.log('PNG 字节数:', pngBytes.length);

// 测试 A：vm 沙箱 realm 的 Uint8Array（模拟插件里 base64ToBytes 的产物）
const sandbox = vm.createContext({});
const sbBuf = vm.runInContext('new Uint8Array(' + pngBytes.length + ')', sandbox);
for (let i = 0; i < pngBytes.length; i++) sbBuf[i] = pngBytes[i];
console.log('沙箱 Uint8Array instanceof 主 realm Uint8Array:', sbBuf instanceof Uint8Array);

(async () => {
  try {
    const m = await sharp(sbBuf).metadata();
    console.log('测试A sharp(沙箱Uint8Array): ✅ 成功', m.format, m.width + 'x' + m.height);
  } catch (e) {
    console.log('测试A sharp(沙箱Uint8Array): ❌ 失败 ->', e.message);
  }
  // 测试 B：主 realm Uint8Array
  try {
    const m = await sharp(pngBytes).metadata();
    console.log('测试B sharp(主realm Buffer): ✅ 成功', m.format, m.width + 'x' + m.height);
  } catch (e) {
    console.log('测试B sharp(主realm Buffer): ❌ 失败 ->', e.message);
  }
  // 测试 C：TextEncoder 工厂产物（主 realm Uint8Array）填充字节
  const hostBytes = new TextEncoder().encode('\0'.repeat(pngBytes.length));
  for (let i = 0; i < pngBytes.length; i++) hostBytes[i] = pngBytes[i];
  try {
    const m = await sharp(hostBytes).metadata();
    console.log('测试C sharp(TextEncoder工厂Uint8Array): ✅ 成功', m.format, m.width + 'x' + m.height);
  } catch (e) {
    console.log('测试C sharp(TextEncoder工厂Uint8Array): ❌ 失败 ->', e.message);
  }
})();
