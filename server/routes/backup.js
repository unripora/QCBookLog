/**
 * 备份恢复路由模块
 * 处理数据备份和恢复相关的API请求
 */

import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { readJsonFile, writeJsonFile, fileExists, updateVersionInfo } from '../services/legacy/dataService.js';
import archiver from 'archiver';
import unzipper from 'unzipper';
import databaseService from '../services/legacy/database-service.js';
import multer from 'multer';
import * as PATHS from '../utils/paths.js';

const router = express.Router();
const DATA_DIR = PATHS.DATA_DIR;
const BACKUP_DIR = path.join(DATA_DIR, 'metadata/backup');
const TEMP_DIR = path.join(DATA_DIR, 'tmp/library-backup');

/**
 * 异步整库备份任务存储
 * jobId -> { status, current, total, currentFile, filename, filePath, size, error, startedAt, finishedAt }
 * status: 'running' | 'completed' | 'failed'
 */
const backupJobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // 任务元数据保留 30 分钟

function generateJobId() {
  return `lib-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 递归统计目录字节大小(用于进度展示)
 */
async function getDirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSize(full);
    } else if (entry.isFile()) {
      try {
        const stats = await fs.stat(full);
        total += stats.size;
      } catch (e) {
        // 忽略无法读取的文件
      }
    }
  }
  return total;
}

async function countFiles(dir) {
  let count = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(full);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

/**
 * 清理临时目录下过期的 zip 文件（默认 30 分钟）
 */
async function cleanupOldTempZips(maxAgeMs = 30 * 60 * 1000) {
  try {
    const entries = await fs.readdir(TEMP_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.zip')) {
        const full = path.join(TEMP_DIR, entry.name);
        const stats = await fs.stat(full);
        if (now - stats.mtime.getTime() > maxAgeMs) {
          await fs.unlink(full).catch(() => {});
        }
      }
    }
  } catch (e) {
    // 目录可能不存在
  }
}

/**
 * 检查并清理过期的备份任务
 */
function pruneExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of backupJobs.entries()) {
    if (now - (job.finishedAt || job.startedAt) > JOB_TTL_MS) {
      // 删除临时文件
      if (job.filePath) {
        fs.unlink(job.filePath).catch(() => {});
      }
      backupJobs.delete(jobId);
    }
  }
}
setInterval(pruneExpiredJobs, 5 * 60 * 1000).unref();

/**
 * 获取所有备份列表
 */
router.get('/', async (req, res) => {
  try {
    const backupFiles = await fs.readdir(BACKUP_DIR);
    
    // 获取每个备份文件的详细信息
    const backups = await Promise.all(backupFiles.map(async (filename) => {
      const stats = await fs.stat(path.join(BACKUP_DIR, filename));
      return {
        filename: filename,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString()
      };
    }));
    
    // 按创建时间降序排序
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 创建备份
 */
router.post('/', async (req, res) => {
  try {
    // 创建备份文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `backup-${timestamp}.zip`;
    const backupPath = path.join(BACKUP_DIR, backupFilename);
    
    // 创建写入流
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // 最高压缩级别
    });
    
    // 监听事件
    output.on('close', () => {
      res.json({
        message: `备份成功，文件大小: ${archive.pointer()} 字节`,
        filename: backupFilename
      });
    });
    
    archive.on('error', (err) => {
      res.status(500).json({ error: err.message });
    });
    
    // 管道连接
    archive.pipe(output);
    
    // 添加数据目录到压缩包
    archive.directory(DATA_DIR, false);
    
    // 完成压缩
    await archive.finalize();
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 恢复备份
 */
router.post('/restore/:filename', async (req, res) => {
  try {
    const backupFilename = req.params.filename;
    const backupPath = path.join(BACKUP_DIR, backupFilename);
    
    // 检查备份文件是否存在
    if (!(await fileExists(`metadata/backup/${backupFilename}`))) {
      return res.status(404).json({ error: '备份文件不存在' });
    }
    
    // 创建临时目录
    const tempDir = path.join(DATA_DIR, `temp-${Date.now()}`);
    await fs.mkdir(tempDir);
    
    try {
      // 解压备份文件到临时目录
      await fs.createReadStream(backupPath)
        .pipe(unzipper.Extract({ path: tempDir }))
        .promise();
      
      // 复制临时目录中的数据到数据目录
      const tempDataDir = path.join(tempDir, 'data');
      if (await fileExists(tempDataDir, true)) {
        // 清空当前数据目录
        const currentFiles = await fs.readdir(DATA_DIR);
        for (const file of currentFiles) {
          if (file !== 'metadata') {
            const filePath = path.join(DATA_DIR, file);
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
              await fs.rm(filePath, { recursive: true });
            } else {
              await fs.unlink(filePath);
            }
          }
        }
        
        // 复制备份数据到数据目录
        const backupFiles = await fs.readdir(tempDataDir);
        for (const file of backupFiles) {
          const srcPath = path.join(tempDataDir, file);
          const destPath = path.join(DATA_DIR, file);
          await fs.cp(srcPath, destPath, { recursive: true });
        }
        
        await updateVersionInfo();
        res.json({ message: '备份恢复成功' });
      } else {
        throw new Error('备份文件格式不正确');
      }
    } finally {
      // 删除临时目录
      await fs.rm(tempDir, { recursive: true });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 删除备份
 */
router.delete('/:filename', async (req, res) => {
  try {
    const backupFilename = req.params.filename;
    const backupPath = path.join(BACKUP_DIR, backupFilename);
    
    // 检查备份文件是否存在
    if (!(await fileExists(`metadata/backup/${backupFilename}`))) {
      return res.status(404).json({ error: '备份文件不存在' });
    }
    
    // 删除备份文件
    await fs.unlink(backupPath);
    res.json({ message: '备份文件删除成功' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 下载备份文件
 */
router.get('/download/:filename', async (req, res) => {
  try {
    const backupFilename = req.params.filename;
    const backupPath = path.join(BACKUP_DIR, backupFilename);

    // 检查备份文件是否存在
    if (!(await fileExists(`metadata/backup/${backupFilename}`))) {
      return res.status(404).json({ error: '备份文件不存在' });
    }

    // 发送文件
    res.download(backupPath, backupFilename);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 导出整库备份（Calibre书库 + Talebook数据库）
 * 用于完整备份书籍数据和数据库
 */
/**
 * 启动整库备份任务(异步)
 * 包含:Calibre 书库目录 + Talebook 数据库 + QCBookLog 数据库 + 备份元数据
 * 立即返回 jobId,客户端通过 /library/status/:jobId 轮询进度,通过 /library/download/:jobId 下载
 */
router.post('/library', async (req, res) => {
  try {
    console.log('📦 开始创建整库备份任务...');

    // 获取 Calibre 书库目录
    const calibreDbPath = databaseService.getDbPath();
    const calibreLibraryDir = path.dirname(calibreDbPath);
    console.log('📁 Calibre 数据库路径:', calibreDbPath);
    console.log('📁 Calibre 书库目录:', calibreLibraryDir);

    // 获取 Talebook 数据库路径
    const talebookDbPath = databaseService.getTalebookDbPath();
    console.log('📁 Talebook 数据库路径:', talebookDbPath);

    // 获取 QCBookLog 数据库路径
    let qcBooklogDbPath = null;
    try {
      qcBooklogDbPath = databaseService.getQcBooklogDbPath();
      console.log('📁 QCBookLog 数据库路径:', qcBooklogDbPath);
    } catch (e) {
      console.warn('⚠️ 未找到 QCBookLog 数据库路径:', e.message);
    }

    // 检查路径是否存在
    try {
      await fs.access(calibreLibraryDir, fsSync.constants.R_OK);
      console.log('✅ Calibre 书库目录存在且可访问');
    } catch (error) {
      console.error('❌ Calibre 书库目录不存在或无法访问:', error);
      return res.status(404).json({ error: `Calibre 书库目录不存在或无法访问: ${calibreLibraryDir}` });
    }

    try {
      await fs.access(talebookDbPath, fsSync.constants.R_OK);
      console.log('✅ Talebook 数据库存在且可访问');
    } catch (error) {
      console.error('❌ Talebook 数据库不存在或无法访问:', error);
      return res.status(404).json({ error: `Talebook 数据库文件不存在或无法访问: ${talebookDbPath}` });
    }

    let qcBooklogExists = false;
    if (qcBooklogDbPath) {
      try {
        await fs.access(qcBooklogDbPath, fsSync.constants.R_OK);
        qcBooklogExists = true;
        console.log('✅ QCBookLog 数据库存在且可访问');
      } catch (error) {
        console.warn('⚠️ QCBookLog 数据库文件不存在,跳过:', qcBooklogDbPath);
      }
    }

    // 预统计字节数(用于进度展示)
    const calibreDirSize = await getDirSize(calibreLibraryDir);
    let totalBytes = calibreDirSize;
    try {
      const talebookStats = await fs.stat(talebookDbPath);
      totalBytes += talebookStats.size;
    } catch (e) { /* ignore */ }
    if (qcBooklogExists && qcBooklogDbPath) {
      try {
        const qcStats = await fs.stat(qcBooklogDbPath);
        totalBytes += qcStats.size;
      } catch (e) { /* ignore */ }
    }
    // 元数据文件粗略估算
    totalBytes += 1024 * 1024;
    console.log(`📊 预计待处理字节: ${totalBytes} (Calibre 目录: ${calibreDirSize})`);

    // 创建任务
    const jobId = generateJobId();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `library-backup-${timestamp}.zip`;

    // 确保临时目录存在并清理过期 zip
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await cleanupOldTempZips();
    const filePath = path.join(TEMP_DIR, `${jobId}.zip`);

    const job = {
      status: 'running',
      current: 0,
      total: 0,
      currentFile: '准备中...',
      filename,
      filePath,
      size: 0,
      processedBytes: 0,
      totalBytes,
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    };
    backupJobs.set(jobId, job);

    // 立即返回 jobId,不阻塞
    res.json({
      jobId,
      totalBytes,
      filename
    });

    // 异步执行打包
    runLibraryBackupJob(job, {
      calibreLibraryDir,
      talebookDbPath,
      qcBooklogDbPath,
      qcBooklogExists
    }).catch(err => {
      console.error('❌ 整库备份任务失败:', err);
      job.status = 'failed';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
    });
  } catch (error) {
    console.error('❌ 启动整库备份任务失败:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * 查询整库备份任务进度
 */
router.get('/library/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = backupJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: '任务不存在或已过期', code: 'JOB_NOT_FOUND' });
  }
  res.json({
    jobId,
    status: job.status,
    current: job.current,
    total: job.total,
    currentFile: job.currentFile,
    processedBytes: job.processedBytes || 0,
    totalBytes: job.totalBytes || 0,
    percent: job.totalBytes > 0 ? Math.min(100, Math.floor((job.processedBytes / job.totalBytes) * 100)) : 0,
    filename: job.filename,
    size: job.size,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  });
});

/**
 * 下载整库备份结果
 */
router.get('/library/download/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = backupJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }
  if (job.status !== 'completed') {
    return res.status(400).json({ error: `任务尚未完成,当前状态: ${job.status}` });
  }
  if (!job.filePath || !fsSync.existsSync(job.filePath)) {
    return res.status(410).json({ error: '备份文件已失效,请重新创建任务' });
  }

  try {
    const stats = fsSync.statSync(job.filePath);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);

    const stream = fsSync.createReadStream(job.filePath);
    let aborted = false;

    stream.on('error', (err) => {
      console.error('❌ 备份文件流式下载失败:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else if (!res.destroyed) {
        res.end();
      }
    });

    req.on('close', () => {
      if (!aborted) {
        aborted = true;
        stream.destroy();
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('❌ 备份文件下载失败:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * 执行整库备份任务(后台)
 */
async function runLibraryBackupJob(job, ctx) {
  const { calibreLibraryDir, talebookDbPath, qcBooklogDbPath, qcBooklogExists } = ctx;

  // 对 QCBookLog 数据库执行 WAL checkpoint,确保所有数据写入主文件
  if (qcBooklogExists && qcBooklogDbPath) {
    try {
      const qcBooklogDb = databaseService.connectionManager?.getQcBooklogDb?.();
      if (qcBooklogDb && typeof qcBooklogDb.pragma === 'function') {
        qcBooklogDb.pragma('wal_checkpoint(FULL)');
        console.log('✅ QCBookLog 数据库 WAL checkpoint 已执行');
      }
    } catch (e) {
      console.warn('⚠️ QCBookLog WAL checkpoint 失败(继续备份):', e.message);
    }
  }

  // 创建写入流
  const output = fsSync.createWriteStream(job.filePath);
  const archive = archiver('zip', {
    zlib: { level: 6 }
  });

  // 使用 archiver 内置 progress 事件按字节推进
  archive.on('progress', (data) => {
    job.processedBytes = data.fs.processedBytes;
    job.totalBytes = data.fs.totalBytes;
    job.current = data.entries.processed;
    job.total = data.entries.total;
    job.currentFile = `${data.entries.processed} / ${data.entries.total}`;
  });

  // 监听错误
  archive.on('error', (err) => {
    console.error('❌ 压缩失败:', err);
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = Date.now();
  });

  // 监听完成
  output.on('close', () => {
    try {
      const stats = fsSync.statSync(job.filePath);
      job.size = stats.size;
    } catch (e) {
      job.size = archive.pointer();
    }
    job.status = 'completed';
    job.processedBytes = job.totalBytes;
    job.current = job.total;
    job.currentFile = '完成';
    job.finishedAt = Date.now();
    console.log(`✅ 整库备份任务完成: ${job.filename}, 大小: ${job.size} 字节`);
  });

  output.on('error', (err) => {
    console.error('❌ 写入备份文件失败:', err);
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = Date.now();
  });

  // 管道连接
  archive.pipe(output);

  // 1. 添加 Calibre 书库目录
  job.currentFile = 'calibre-library/...';
  console.log('📦 添加 Calibre 书库目录...');
  archive.directory(calibreLibraryDir, 'calibre-library');

  // 2. 添加 Talebook 数据库
  job.currentFile = 'talebook.db';
  console.log('📦 添加 Talebook 数据库...');
  const talebookBuffer = await fs.readFile(talebookDbPath);
  archive.append(talebookBuffer, { name: 'talebook.db' });

  // 3. 添加 QCBookLog 数据库(完整)
  if (qcBooklogExists && qcBooklogDbPath) {
    job.currentFile = 'qcbooklog.db';
    console.log('📦 添加 QCBookLog 数据库(完整)...');
    const qcBooklogBuffer = await fs.readFile(qcBooklogDbPath);
    archive.append(qcBooklogBuffer, { name: 'qcbooklog.db' });
    console.log(`📦 QCBookLog 数据库已添加,大小: ${qcBooklogBuffer.length} 字节`);

    // 尝试同时附加 WAL/SHM(若存在),确保运行时数据完整
    for (const suffix of ['-wal', '-shm']) {
      const walPath = qcBooklogDbPath + suffix;
      if (fsSync.existsSync(walPath)) {
        const walBuffer = await fs.readFile(walPath);
        archive.append(walBuffer, { name: `qcbooklog.db${suffix}` });
        console.log(`📦 QCBookLog ${suffix} 文件已添加,大小: ${walBuffer.length} 字节`);
      }
    }
  } else {
    console.log('⚠️ 跳过 QCBookLog 数据库(文件不存在)');
  }

  // 4. 添加备份元数据
  job.currentFile = 'backup-metadata.json';
  const metadata = {
    version: '2.1',
    type: 'full-library-backup',
    exportTime: new Date().toISOString(),
    calibreLibraryPath: calibreLibraryDir,
    talebookDbPath: talebookDbPath,
    qcBooklogDbPath: qcBooklogExists ? qcBooklogDbPath : null,
    appName: 'QC-booklog'
  };
  archive.append(JSON.stringify(metadata, null, 2), { name: 'backup-metadata.json' });
  console.log('📦 备份元数据已添加');

  // 完成压缩
  await archive.finalize();
}

/**
 * 整库恢复(上传备份 ZIP, 直接替换 Calibre / Talebook / QCBookLog 三个数据库)
 * 流程:
 *   1. 接收 ZIP, 验证 backup-metadata.json
 *   2. 备份当前数据(calibre-library、talebook.db、qcbooklog.db 等)
 *   3. 解压 ZIP 到临时目录
 *   4. 关闭数据库连接
 *   5. 原子替换文件
 *   6. 重新连接数据库
 *   7. 触发后端进程重启(通过 touch 一个被 --watch 监控的文件)
 */
const restoreUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB
});

router.post('/library/restore', restoreUpload.single('file'), async (req, res) => {
  let stagingDir = null;
  let preRestoreDir = null;
  let restoreLog = [];
  const log = (msg) => {
    console.log(`[restore] ${msg}`);
    restoreLog.push(`${new Date().toISOString()} ${msg}`);
  };

  try {
    if (!req.file) {
      return res.status(400).json({ error: '未收到上传文件' });
    }
    log(`接收到上传文件: ${req.file.originalname} (${req.file.size} 字节)`);

    // 1. 校验 ZIP 格式: 读取 backup-metadata.json
    const zipBuffer = req.file.buffer;
    const directory = await unzipper.Open.buffer(zipBuffer);
    const metaEntry = directory.files.find(f => f.path === 'backup-metadata.json');
    if (!metaEntry) {
      return res.status(400).json({ error: 'ZIP 中未找到 backup-metadata.json,不是合法的整库备份文件' });
    }
    const metaContent = await metaEntry.buffer();
    const metadata = JSON.parse(metaContent.toString('utf8'));
    if (metadata.type !== 'full-library-backup') {
      return res.status(400).json({
        error: `此备份类型为 ${metadata.type},不是整库备份(full-library-backup),请使用普通导入`
      });
    }
    log(`备份元数据校验通过,版本=${metadata.version},导出时间=${metadata.exportTime}`);

    // 2. 准备临时目录
    const restoreId = `restore-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    stagingDir = path.join(TEMP_DIR, `${restoreId}-staging`);
    preRestoreDir = path.join(TEMP_DIR, `${restoreId}-prebackup`);
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.mkdir(preRestoreDir, { recursive: true });
    log(`临时目录: ${stagingDir}, 备份目录: ${preRestoreDir}`);

    // 3. 解压 ZIP 到 staging 目录
    log('开始解压 ZIP...');
    await directory.extract({ path: stagingDir });
    log('解压完成');

    // 4. 验证解压后的关键文件
    const qcDbSrc = path.join(stagingDir, 'qcbooklog.db');
    const taleSrc = path.join(stagingDir, 'talebook.db');
    const calibreLibSrc = path.join(stagingDir, 'calibre-library');
    const missing = [];
    if (!fsSync.existsSync(qcDbSrc)) missing.push('qcbooklog.db');
    if (!fsSync.existsSync(taleSrc)) missing.push('talebook.db');
    if (!fsSync.existsSync(calibreLibSrc)) missing.push('calibre-library/');
    if (missing.length > 0) {
      return res.status(400).json({
        error: `备份文件不完整,缺少: ${missing.join(', ')}`
      });
    }
    log('关键文件存在性校验通过');

    // 5. 获取目标路径
    let qcBooklogDbPath, talebookDbPath, calibreLibraryDir;
    try {
      qcBooklogDbPath = databaseService.getQcBooklogDbPath();
    } catch (e) {
      qcBooklogDbPath = null;
    }
    talebookDbPath = databaseService.getTalebookDbPath();
    const calibreDbPath = databaseService.getDbPath();
    calibreLibraryDir = path.dirname(calibreDbPath);
    log(`目标路径: calibre=${calibreLibraryDir}, talebook=${talebookDbPath}, qcbooklog=${qcBooklogDbPath}`);

    // 6. 备份当前文件
    log('开始备份当前数据...');
    const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const curBackupDir = path.join(preRestoreDir, 'pre-restore');
    await fs.mkdir(curBackupDir, { recursive: true });
    if (qcBooklogDbPath) {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = qcBooklogDbPath + suffix;
        if (fsSync.existsSync(src)) {
          await fs.copyFile(src, path.join(curBackupDir, `qcbooklog${suffix || '.db'}`));
        }
      }
    }
    if (fsSync.existsSync(talebookDbPath)) {
      await fs.copyFile(talebookDbPath, path.join(curBackupDir, 'talebook.db'));
      const wal = talebookDbPath + '-wal';
      const shm = talebookDbPath + '-shm';
      if (fsSync.existsSync(wal)) await fs.copyFile(wal, path.join(curBackupDir, 'talebook.db-wal'));
      if (fsSync.existsSync(shm)) await fs.copyFile(shm, path.join(curBackupDir, 'talebook.db-shm'));
    }
    // 备份 calibre 库(只记录目录,实际文件较大,只备份元数据文件)
    const calibreMetaBackup = path.join(curBackupDir, 'calibre-metadata.json');
    const calibreMeta = path.join(calibreLibraryDir, 'calibre_metadata.json');
    if (fsSync.existsSync(calibreMeta)) {
      await fs.copyFile(calibreMeta, calibreMetaBackup);
    }
    log('当前数据备份完成');

    // 7. 关闭所有数据库连接
    log('关闭数据库连接...');
    try {
      if (databaseService.connectionManager) {
        databaseService.connectionManager.close();
        log('数据库连接已关闭');
      }
    } catch (e) {
      log(`关闭连接时出错(继续): ${e.message}`);
    }

    // 8. 替换 qcbooklog.db (含 WAL/SHM)
    if (qcBooklogDbPath) {
      log(`替换 qcbooklog.db -> ${qcBooklogDbPath}`);
      // 先删除旧的 WAL/SHM(避免冲突)
      for (const suffix of ['-wal', '-shm']) {
        const oldFile = qcBooklogDbPath + suffix;
        if (fsSync.existsSync(oldFile)) {
          try { await fs.unlink(oldFile); } catch (e) { /* ignore */ }
        }
      }
      // 复制主文件
      await fs.copyFile(qcDbSrc, qcBooklogDbPath);
      // 复制 WAL/SHM(若有)
      for (const suffix of ['-wal', '-shm']) {
        const src = path.join(stagingDir, `qcbooklog.db${suffix}`);
        if (fsSync.existsSync(src)) {
          await fs.copyFile(src, qcBooklogDbPath + suffix);
        }
      }
    } else {
      log('未配置 qcbooklog 路径,跳过 qcbooklog 替换');
    }

    // 9. 替换 talebook.db
    log(`替换 talebook.db -> ${talebookDbPath}`);
    for (const suffix of ['-wal', '-shm']) {
      const oldFile = talebookDbPath + suffix;
      if (fsSync.existsSync(oldFile)) {
        try { await fs.unlink(oldFile); } catch (e) { /* ignore */ }
      }
    }
    await fs.copyFile(taleSrc, talebookDbPath);
    for (const suffix of ['-wal', '-shm']) {
      const src = path.join(stagingDir, `talebook.db${suffix}`);
      if (fsSync.existsSync(src)) {
        await fs.copyFile(src, talebookDbPath + suffix);
      }
    }

    // 10. 替换 calibre-library 目录
    // 策略: 因为 /tmp (staging) 和 calibre 目标目录通常跨设备,
    //       无法用 fs.rename 一步到位,必须先用 fs.cp 拷贝到同设备的临时位置,
    //       再用 rename 做同设备原子交换
    log(`替换 calibre-library -> ${calibreLibraryDir}`);
    const oldCalibreDir = `${calibreLibraryDir}-old-${backupStamp}`;

    // 10.1 临时目录必须放在 calibre 同级父目录(同文件系统,rename 才不跨设备)
    //     不能用 DATA_DIR,因为 DATA_DIR = ../data 可能解析为不同挂载点
    const calibreParent = path.dirname(calibreLibraryDir);
    const tmpCalibreDir = path.join(calibreParent, `.tmp-calibre-${backupStamp}`);
    if (fsSync.existsSync(tmpCalibreDir)) {
      await fs.rm(tmpCalibreDir, { recursive: true, force: true });
    }
    log(`拷贝 staging -> ${tmpCalibreDir} (calibre 同级目录,确保同设备)`);
    try {
      await fs.cp(calibreLibSrc, tmpCalibreDir, {
        recursive: true,
        verbatimSymlinks: true
      });
      log('拷贝到临时目录完成');
    } catch (cpErr) {
      log(`拷贝失败: ${cpErr.message}`);
      if (fsSync.existsSync(tmpCalibreDir)) {
        await fs.rm(tmpCalibreDir, { recursive: true, force: true });
      }
      throw cpErr;
    }

    // 10.2 把当前 calibre-library 重命名为 old (同设备 rename, OK)
    if (fsSync.existsSync(calibreLibraryDir)) {
      try {
        await fs.rename(calibreLibraryDir, oldCalibreDir);
        log(`旧 calibre 库已重命名为: ${oldCalibreDir}`);
      } catch (renameErr) {
        log(`重命名旧 calibre 库失败: ${renameErr.message}`);
        // 清理临时拷贝,然后把旧目录留着(恢复失败场景)
        await fs.rm(tmpCalibreDir, { recursive: true, force: true }).catch(() => {});
        throw renameErr;
      }
    }

    // 10.3 把临时目录 rename 到目标 (同设备 rename, OK)
    try {
      await fs.rename(tmpCalibreDir, calibreLibraryDir);
      log('calibre-library 已替换');
      // 删除旧的 calibre 库(异步,不阻塞响应)
      fs.rm(oldCalibreDir, { recursive: true, force: true }).catch(err => {
        console.warn(`[restore] 清理旧 calibre 库失败(可手动删除): ${err.message}`);
      });
    } catch (renameErr) {
      // 回滚: 把旧的 calibre 库恢复回去,清理临时目录
      log(`替换 calibre-library 失败,尝试回滚: ${renameErr.message}`);
      if (fsSync.existsSync(calibreLibraryDir)) {
        await fs.rm(calibreLibraryDir, { recursive: true, force: true });
      }
      if (fsSync.existsSync(oldCalibreDir)) {
        try {
          await fs.rename(oldCalibreDir, calibreLibraryDir);
        } catch (e) {
          log(`回滚也失败(需要手动处理): ${e.message}`);
        }
      }
      if (fsSync.existsSync(tmpCalibreDir)) {
        await fs.rm(tmpCalibreDir, { recursive: true, force: true }).catch(() => {});
      }
      throw renameErr;
    }

    // 11. 重新连接数据库
    log('重新连接数据库...');
    try {
      await databaseService.connectionManager.reconnect();
      log('数据库重新连接成功');
    } catch (e) {
      log(`重新连接失败(可能需要手动重启): ${e.message}`);
    }

    // 12. 清理 staging 目录
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }

    // 13. 触发后端进程重启(让所有缓存/连接完全重建)
    // 通过 touch loader.js 触发 node --watch 重启
    setTimeout(() => {
      try {
        const triggerFile = path.join(PATHS.SERVER_ROOT, 'loader.js');
        if (fsSync.existsSync(triggerFile)) {
          const now = new Date();
          fsSync.utimesSync(triggerFile, now, now);
          console.log('[restore] 已 touch loader.js 触发 watch 重启');
        }
      } catch (e) {
        console.warn('[restore] 触发重启失败(可手动重启):', e.message);
      }
    }, 500);

    log('整库恢复完成,后端将自动重启');

    return res.json({
      success: true,
      message: '整库恢复完成,后端将在几秒内自动重启以加载新数据',
      metadata: {
        version: metadata.version,
        exportTime: metadata.exportTime,
        backupId: restoreId
      },
      log: restoreLog
    });
  } catch (err) {
    console.error('❌ 整库恢复失败:', err);
    // 清理临时目录
    if (stagingDir) {
      fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    return res.status(500).json({
      success: false,
      error: err.message,
      log: restoreLog
    });
  }
});

export default router;