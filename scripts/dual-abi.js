/**
 * 原生模块双 ABI 编译脚本
 *
 * 问题背景：
 *   better-sqlite3 / sqlite3 是 N-API 之外的原生模块，编译产物与 Node/Electron 的
 *   NODE_MODULE_VERSION（ABI）强绑定。同一份 server/node_modules 无法同时被两者加载：
 *     - Node 18.19.1 → ABI 109
 *     - Electron 33  → ABI 130
 *
 * 用法：
 *   node scripts/dual-abi.js electron   # 编译为 Electron ABI，用于桌面端运行/打包
 *   node scripts/dual-abi.js node       # 编译回 Node ABI，用于本地开发与 Docker 部署
 *
 * 说明：
 *   - Electron 侧使用 @electron/rebuild，必须用 -o/--only 跳过依赖树扫描
 *     （server/node_modules 有 300+ 包，全量扫描会长时间无响应）
 *   - Node 侧必须用 --nodedir=/usr 走系统头文件
 *     （node-gyp 默认下载的 v18.19.1 headers 中 NODE_MODULE_VERSION 为 108，
 *       与实际运行时的 109 不一致，会导致 ERR_DLOPEN_FAILED）
 */

import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');

const MODULES = ['better-sqlite3', 'sqlite3'];

const target = process.argv[2];
if (!['electron', 'node'].includes(target)) {
  console.error('用法: node scripts/dual-abi.js <electron|node>');
  process.exit(1);
}

/** 清理 @electron/rebuild 留下的临时编译目录，避免 bindings 解析到旧版本 */
const cleanStaleBuilds = () => {
  const nm = path.join(SERVER_DIR, 'node_modules');
  if (!fs.existsSync(nm)) return;
  for (const entry of fs.readdirSync(nm)) {
    if (entry.startsWith('.better-sqlite3-') || entry.startsWith('.sqlite3-')) {
      fs.rmSync(path.join(nm, entry), { recursive: true, force: true });
      console.log(`🧹 已清理临时目录: ${entry}`);
    }
  }
};

const rebuildForElectron = () => {
  const cli = path.join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('❌ 未找到 @electron/rebuild，请先运行 npm install');
    process.exit(1);
  }
  console.log('🔧 编译原生模块为 Electron ABI...');
  execFileSync(process.execPath, [cli, '-f', '-o', MODULES.join(','), '-m', 'server'], {
    cwd: ROOT,
    stdio: 'inherit'
  });
};

const rebuildForNode = () => {
  console.log('🔧 编译原生模块为 Node ABI...');
  for (const name of MODULES) {
    const moduleDir = path.join(SERVER_DIR, 'node_modules', name);
    if (!fs.existsSync(moduleDir)) {
      console.log(`⏭️  跳过 ${name}（未安装）`);
      continue;
    }
    const buildDir = path.join(moduleDir, 'build');
    fs.rmSync(buildDir, { recursive: true, force: true });

    const gyp = path.join(ROOT, 'node_modules', '.bin', 'node-gyp');
    const gypCli = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
    const runner = fs.existsSync(gypCli) ? gypCli : gyp;

    // --nodedir=/usr 仅用于 Linux：那里 node-gyp 下载的 headers 与其运行时 ABI 不一致，
    // 需借系统头文件。Windows/macOS 下载的官方 headers 与运行时一致，不能覆盖。
    const args = [runner, 'rebuild'];
    if (process.platform === 'linux') args.push('--nodedir=/usr');

    execFileSync(process.execPath, args, {
      cwd: moduleDir,
      stdio: 'inherit'
    });
    console.log(`✅ ${name} 已编译为 Node ABI`);
  }
};

if (target === 'electron') {
  cleanStaleBuilds();
  rebuildForElectron();
  console.log('✅ 原生模块已编译为 Electron ABI，可运行 npm run electron:dev 或打包');
} else {
  cleanStaleBuilds();
  rebuildForNode();
  console.log('✅ 原生模块已编译为 Node ABI，可运行 npm run server / Docker 部署');
}
