/**
 * OCR 静态资源准备
 *
 * public/tessdata、public/tesseract-core、public/tesseract-dist 体积较大且不入库
 * （见 .gitignore），克隆仓库后本地缺少这些文件会导致「书摘 OCR」功能不可用。
 * 本脚本从已安装依赖与官方 CDN 补齐，可重复执行（已存在则跳过）。
 *
 * 用法：
 *   node scripts/prepare-ocr-assets.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const LANGS = ['chi_sim', 'chi_tra', 'eng', 'jpn', 'kor', 'fra', 'deu', 'rus'];
const TESSDATA_BASE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const copyIfExists = (srcDir, dstDir, filter) => {
  if (!fs.existsSync(srcDir)) return 0;
  ensureDir(dstDir);
  let n = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    if (!fs.statSync(src).isFile() || !filter(name)) continue;
    fs.copyFileSync(src, path.join(dstDir, name));
    n++;
  }
  return n;
};

const download = async (url, dest) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('空响应');
  fs.writeFileSync(dest, buf);
  return buf.length;
};

const prepareCore = () => {
  const src = path.join(ROOT, 'node_modules', 'tesseract.js-core');
  const dst = path.join(PUBLIC, 'tesseract-core');
  if (!fs.existsSync(src)) {
    console.log('⏭️  跳过 tesseract-core（未安装 tesseract.js-core，请先 npm install）');
    return false;
  }
  const n = copyIfExists(src, dst, (f) => f.endsWith('.wasm.js') || f.endsWith('.wasm'));
  console.log(`✅ tesseract-core：${n} 个文件`);
  return n > 0;
};

const prepareWorker = () => {
  const src = path.join(ROOT, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
  const dst = path.join(PUBLIC, 'tesseract-dist', 'worker.min.js');
  if (!fs.existsSync(src)) {
    console.log('⏭️  跳过 tesseract-dist（未安装 tesseract.js）');
    return false;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log('✅ tesseract-dist：worker.min.js');
  return true;
};

const prepareTessdata = async () => {
  const dst = path.join(PUBLIC, 'tessdata');
  ensureDir(dst);
  const missing = [];
  for (const lang of LANGS) {
    if (fs.existsSync(path.join(dst, `${lang}.traineddata.gz`))) continue;
    missing.push(lang);
  }
  if (missing.length === 0) {
    console.log(`✅ tessdata：${LANGS.length} 个语言包已存在`);
    return true;
  }

  console.log(`⬇️  下载语言包：${missing.join(', ')}（约 14 MB，失败可忽略，仅影响 OCR）`);
  for (const lang of missing) {
    const dest = path.join(dst, `${lang}.traineddata.gz`);
    let ok = false;
    for (const repo of [lang, `${lang}_traineddata`]) {
      const url = `${TESSDATA_BASE}/${repo}/4.0.0_best_int/${lang}.traineddata.gz`;
      try {
        const size = await download(url, dest);
        console.log(`   ✅ ${lang}（${(size / 1024 / 1024).toFixed(1)} MB）`);
        ok = true;
        break;
      } catch {
        // 换下一个 repo 名重试
      }
    }
    if (!ok) {
      console.warn(`   ⚠️  ${lang} 下载失败，OCR 将不支持该语言`);
      fs.rmSync(dest, { force: true });
    }
  }
  return true;
};

console.log('=== 准备 OCR 静态资源 ===\n');
prepareCore();
prepareWorker();
await prepareTessdata();
console.log('\n完成。缺失语言包不影响构建与运行，仅影响对应语种 OCR 识别。');
