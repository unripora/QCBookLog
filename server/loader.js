import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { File as BufferFile } from 'buffer';

// Node 18 兼容：undici 新版依赖全局 File（Node 20+ 才内置），
// Node 18.13+ 的 buffer 模块提供了同名实现，缺什么补什么
if (typeof globalThis.File === 'undefined') {
  globalThis.File = BufferFile;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        process.env[key.trim()] = value;
      }
    }
  });
  console.log('📁 环境变量已加载:', envPath);
  console.log('📁 CALIBRE_DB_PATH:', process.env.CALIBRE_DB_PATH);
}

await import('./app.js');
