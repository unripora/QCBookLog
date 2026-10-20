/**
 * 数据转移路由模块
 * 实现从本地 Calibre 数据目录向 Talebook 数据库目录的全量数据复制
 */

import express from 'express';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import databaseService from '../services/legacy/database-service.js';
import calibreService from '../services/legacy/calibreService.js';
import configManager from '../config/index.js';
import { METADATA_DIR, PROJECT_ROOT } from '../utils/paths.js';

const router = express.Router();

/**
 * 转移日志存储路径
 */
const LOG_DIR = path.join(METADATA_DIR, 'transfer-logs');
const LOG_FILE = path.join(LOG_DIR, 'transfer-history.log');

/**
 * 确保日志目录存在
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 写入转移日志
 */
function writeTransferLog(entry) {
  try {
    ensureLogDir();
    const line = `[${entry.timestamp}] ${entry.action} | source=${entry.source} | target=${entry.target} | result=${entry.result}${entry.error ? ` | error=${entry.error}` : ''}${entry.stats ? ` | stats=${JSON.stringify(entry.stats)}` : ''}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    console.log(`📝 [Transfer] ${line.trim()}`);
  } catch (logError) {
    console.error('❌ 写入转移日志失败:', logError.message);
  }
}

/**
 * 读取转移历史
 */
router.get('/logs', async (req, res) => {
  try {
    ensureLogDir();
    if (!fs.existsSync(LOG_FILE)) {
      return res.json({ success: true, logs: [] });
    }
    const content = await fsPromises.readFile(LOG_FILE, 'utf8');
    const logs = content
      .split('\n')
      .filter(Boolean)
      .reverse()
      .slice(0, 100)
      .map((line) => {
        const match = line.match(/^\[(.*?)\]\s+(\S+)\s+\|\s+source=(\S+)\s+\|\s+target=(\S+)\s+\|\s+result=(\S+)(?:\s+\|\s+error=(.*?))?(?:\s+\|\s+stats=({.*}))?$/);
        if (!match) return { raw: line };
        return {
          timestamp: match[1],
          action: match[2],
          source: match[3],
          target: match[4],
          result: match[5],
          error: match[6] || null,
          stats: match[7] ? JSON.parse(match[7]) : null
        };
      });
    res.json({ success: true, logs });
  } catch (error) {
    console.error('❌ 读取转移日志失败:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取当前 Calibre 源目录信息
 */
router.get('/source-info', async (req, res) => {
  try {
    const calibrePath = databaseService.connectionManager?.config?.calibrePath;
    if (!calibrePath) {
      return res.status(400).json({ success: false, error: 'Calibre 数据库路径未配置' });
    }
    const calibreDir = path.dirname(calibrePath);
    const exists = fs.existsSync(calibreDir);
    let fileCount = 0;
    let totalSize = 0;
    if (exists) {
      const walk = (dir) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.isFile()) {
              fileCount += 1;
              totalSize += fs.statSync(full).size;
            }
          } catch (e) {
            // 跳过无法访问的文件
          }
        }
      };
      walk(calibreDir);
    }
    res.json({
      success: true,
      calibreDir,
      calibrePath,
      exists,
      fileCount,
      totalSize
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 估算目标目录状态
 */
router.post('/target-info', async (req, res) => {
  try {
    const { targetDir } = req.body;
    if (!targetDir) {
      return res.status(400).json({ success: false, error: '请提供目标 Talebook 目录' });
    }
    const absTarget = path.isAbsolute(targetDir) ? targetDir : path.resolve(PROJECT_ROOT, targetDir);
    const exists = fs.existsSync(absTarget);
    let fileCount = 0;
    let totalSize = 0;
    if (exists) {
      const walk = (dir) => {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              walk(full);
            } else if (entry.isFile()) {
              fileCount += 1;
              totalSize += fs.statSync(full).size;
            }
          } catch (e) {
            // 跳过
          }
        }
      };
      walk(absTarget);
    }
    res.json({
      success: true,
      targetDir: absTarget,
      exists,
      fileCount,
      totalSize
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 执行数据转移：把本地 Calibre 目录的内容全量覆盖到目标 Talebook 目录
 * 完成后会自动把 Talebook 数据库路径切换为新路径
 */
router.post('/execute', async (req, res) => {
  const timestamp = new Date().toISOString();
  const { targetDir, confirmed } = req.body;

  // 1. 基础校验
  if (!confirmed) {
    writeTransferLog({
      timestamp, action: 'execute',
      source: '(unknown)', target: targetDir || '(empty)',
      result: 'rejected', error: '用户未确认高危操作'
    });
    return res.status(400).json({ success: false, error: '请先在弹窗中确认执行此高危操作' });
  }
  if (!targetDir) {
    return res.status(400).json({ success: false, error: '请提供目标 Talebook 目录' });
  }

  const calibrePath = databaseService.connectionManager?.config?.calibrePath;
  if (!calibrePath) {
    return res.status(400).json({ success: false, error: 'Calibre 数据库路径未配置' });
  }
  const calibreDir = path.dirname(calibrePath);
  const absTarget = path.isAbsolute(targetDir) ? targetDir : path.resolve(PROJECT_ROOT, targetDir);

  // 2. 安全校验：源和目标不能是同一个目录
  try {
    const realCalibre = fs.realpathSync(calibreDir);
    let realTarget;
    try {
      realTarget = fs.realpathSync(absTarget);
    } catch (e) {
      // 目标目录不存在时跳过此项检查
      realTarget = absTarget;
    }
    if (realCalibre === realTarget) {
      return res.status(400).json({ success: false, error: '源目录与目标目录相同，禁止执行覆盖' });
    }
  } catch (e) {
    // realpath 失败时跳过
  }

  // 3. 创建目标目录
  try {
    fs.mkdirSync(absTarget, { recursive: true });
  } catch (mkdirError) {
    const err = `创建目标目录失败: ${mkdirError.message}`;
    writeTransferLog({
      timestamp, action: 'execute',
      source: calibreDir, target: absTarget,
      result: 'failed', error: err
    });
    return res.status(500).json({ success: false, error: err });
  }

  // 4. 执行全量覆盖复制
  const stats = { copiedFiles: 0, skipped: 0, failedFiles: 0, totalBytes: 0 };
  const errors = [];

  const copyRecursive = (srcDir, dstDir) => {
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch (readError) {
      errors.push({ path: srcDir, error: `读取目录失败: ${readError.message}` });
      return;
    }

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      try {
        if (entry.isDirectory()) {
          // 子目录递归覆盖
          fs.mkdirSync(dstPath, { recursive: true });
          copyRecursive(srcPath, dstPath);
        } else if (entry.isFile()) {
          // 文件复制（覆盖）
          try {
            const data = fs.readFileSync(srcPath);
            fs.writeFileSync(dstPath, data);
            stats.copiedFiles += 1;
            stats.totalBytes += data.length;
          } catch (copyErr) {
            stats.failedFiles += 1;
            errors.push({ path: srcPath, error: copyErr.message });
          }
        } else if (entry.isSymbolicLink()) {
          // 跳过符号链接，避免越界
          stats.skipped += 1;
        }
      } catch (entryErr) {
        stats.failedFiles += 1;
        errors.push({ path: srcPath, error: entryErr.message });
      }
    }
  };

  try {
    copyRecursive(calibreDir, absTarget);
  } catch (copyTopError) {
    const err = `全量复制失败: ${copyTopError.message}`;
    writeTransferLog({
      timestamp, action: 'execute',
      source: calibreDir, target: absTarget,
      result: 'failed', error: err, stats
    });
    return res.status(500).json({ success: false, error: err, stats, errors });
  }

  // 5. 复制完成 -> 自动切换 Talebook 数据库路径
  const talebookDbPath = path.join(absTarget, 'calibre-webserver.db');
  try {
    await databaseService.updateTalebookDbPath(talebookDbPath);
    await configManager.saveConfig({
      talebookPath: talebookDbPath,
      talebookDir: absTarget
    });
  } catch (switchError) {
    const err = `自动切换 Talebook 路径失败: ${switchError.message}`;
    writeTransferLog({
      timestamp, action: 'execute',
      source: calibreDir, target: absTarget,
      result: 'partial', error: err, stats
    });
    return res.status(500).json({ success: false, error: err, stats, errors });
  }

  const resultEntry = {
    timestamp, action: 'execute',
    source: calibreDir, target: absTarget,
    result: stats.failedFiles > 0 ? 'partial' : 'success',
    error: errors.length > 0 ? `${errors.length} 个文件失败` : null,
    stats
  };
  writeTransferLog(resultEntry);

  res.json({
    success: true,
    message: stats.failedFiles > 0
      ? `数据转移完成，但有 ${stats.failedFiles} 个文件失败`
      : '数据转移完成，Talebook 路径已自动切换',
    source: calibreDir,
    target: absTarget,
    talebookDbPath,
    stats,
    errors
  });
});

export default router;
