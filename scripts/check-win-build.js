/**
 * Windows 构建后自检
 *
 * 在 Windows 机器上执行 `npm run check:win` 验证打包前置条件：
 *   1. Node / Electron ABI 是否与 server/node_modules 匹配
 *   2. better-sqlite3 / sqlite3 是否已按 Electron ABI 编译
 *   3. Electron 与 electron-builder 是否就绪
 *   4. dist/ 是否已构建
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SERVER_NM = path.join(ROOT, 'server', 'node_modules');

const require = createRequire(import.meta.url);

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
};

const readAbiFromGypi = (moduleName) => {
  const gypi = path.join(SERVER_NM, moduleName, 'build', 'config.gypi');
  if (!fs.existsSync(gypi)) {
    throw new Error('未找到 build/config.gypi，模块未编译');
  }
  const text = fs.readFileSync(gypi, 'utf8');
  const match = text.match(/"node_module_version":\s*(\d+)/);
  if (!match) throw new Error('无法读取 node_module_version');
  return Number(match[1]);
};

const electronAbi = () => {
  const pkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('未安装 electron');
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

  // electron 的 ABI 从 node-abi 映射，这里用一个已知表兜底
  const known = { '33': 130, '32': 128, '31': 126, '30': 123, '29': 121 };
  const major = version.split('.')[0];
  const abi = known[major];
  if (!abi) throw new Error(`未收录 Electron ${version} 的 ABI，请手动确认`);
  return { version, abi };
};

console.log('=== QC BookLog Windows 构建自检 ===\n');
console.log(`平台: ${process.platform}  架构: ${process.arch}`);
console.log(`Node: ${process.version}  ABI: ${process.versions.modules}\n`);

check('Electron 已安装', () => {
  const { version, abi } = electronAbi();
  return `v${version}（目标 ABI ${abi}）`;
});

check('electron-builder 已安装', () => {
  const p = path.join(ROOT, 'node_modules', 'electron-builder', 'package.json');
  if (!fs.existsSync(p)) throw new Error('未安装 electron-builder');
  return `v${JSON.parse(fs.readFileSync(p, 'utf8')).version}`;
});

check('dist/ 已构建', () => {
  const index = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(index)) throw new Error('缺少 dist/index.html，请先运行 npm run build');
  return '存在 dist/index.html';
});

check('better-sqlite3 已按 Electron ABI 编译', () => {
  const abi = readAbiFromGypi('better-sqlite3');
  const target = electronAbi().abi;
  if (abi !== target) {
    throw new Error(
      `当前 ABI ${abi}，Electron 需要 ${target}。请运行 npm run electron:rebuild`
    );
  }
  return `ABI ${abi} 匹配`;
});

check('sqlite3 已按 Electron ABI 编译', () => {
  const abi = readAbiFromGypi('sqlite3');
  const target = electronAbi().abi;
  if (abi !== target) {
    throw new Error(
      `当前 ABI ${abi}，Electron 需要 ${target}。请运行 npm run electron:rebuild`
    );
  }
  return `ABI ${abi} 匹配`;
});

check('server/node_modules 存在', () => {
  if (!fs.existsSync(SERVER_NM)) throw new Error('缺少 server/node_modules，请先 cd server && npm install');
  const count = fs.readdirSync(SERVER_NM).length;
  return `${count} 个包`;
});

console.log('检查结果：\n');
let failed = 0;
for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  console.log(`${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  if (!r.ok) failed++;
}

console.log('');
if (failed > 0) {
  console.log(`❌ ${failed} 项未通过，请修复后再执行 npm run build:win`);
  process.exit(1);
} else {
  console.log('✅ 全部通过，可执行 npm run build:win');
}
