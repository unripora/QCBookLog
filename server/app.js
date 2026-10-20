/**
 * QC Booklog 后端服务
 * 数据本地化存储解决方案
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import winston from 'winston';
import axios from 'axios';
import fs from 'fs/promises';
import fsSync from 'fs';
import calibreService from './services/legacy/calibreService.js';
import activityService from './services/legacy/activityService.js';
import databaseService from './services/legacy/database-service.js';
import syncScheduler from './services/sync/syncScheduler.js';
import configManager from './config/index.js';
import bookSourceSettingsService from './services/settings/book-source-settings-service.js';
import { DATA_DIR, LOGS_DIR, METADATA_DIR, DIST_DIR } from './utils/paths.js';
import { createLanAuth } from './utils/lanAuth.js';

// 配置日志
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(LOGS_DIR, 'app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// 获取当前文件路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 创建Express应用
const app = express();
// QC_PORT=0 时由系统分配端口（Electron），否则沿用 PORT / 7401
const PORT = process.env.QC_PORT !== undefined ? Number(process.env.QC_PORT) : (process.env.PORT || 7401);

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 动态静态文件服务 - 支持任意深度的路径
app.get('/api/static/calibre/:path(*)', async (req, res, next) => {
  try {
    // 确保使用最新的书库目录
    calibreService.updateBookDir();
    const bookDir = calibreService.getBookDir();

    // 提取路径参数
    const requestPath = req.params.path;
    const filePath = path.join(bookDir, decodeURIComponent(requestPath));

    // 检查文件是否存在
    try {
      const stats = await fs.stat(filePath);
      
      // 生成ETag（基于文件修改时间和大小）
      const etag = `"${stats.size}-${stats.mtime.getTime()}"`;
      const lastModified = stats.mtime.toUTCString();
      
      // 检查客户端缓存是否有效
      const clientETag = req.headers['if-none-match'];
      const clientLastModified = req.headers['if-modified-since'];
      
      // 如果ETag匹配，返回304
      if (clientETag === etag) {
        return res.status(304).end();
      }
      
      // 如果Last-Modified匹配，返回304
      if (clientLastModified && new Date(clientLastModified) >= stats.mtime) {
        return res.status(304).end();
      }
      
      // 设置缓存头
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 缓存1年
      res.setHeader('Expires', new Date(Date.now() + 31536000000).toUTCString());
      
      // 发送文件
      res.sendFile(filePath);
    } catch (err) {
      console.error(`❌ 文件不存在: ${filePath}`);
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('❌ 动态静态文件服务错误:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 健康检查路由
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 版本信息路由
app.get('/api/version', (req, res) => {
  try {
    const version = JSON.parse(fsSync.readFileSync(path.join(METADATA_DIR, 'version.json'), 'utf8'));
    res.json(version);
  } catch (error) {
    logger.error('Failed to get version info', error);
    res.status(500).json({ error: 'Failed to get version info' });
  }
});

// 豆瓣图片中转接口（核心：完全伪装成豆瓣站内请求）
const DOUBAN_HEADERS = {
  'Referer': 'https://book.douban.com/', // 白名单域名，必带
  'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36 Edg/143.0.0.0',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Connection': 'keep-alive',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-User': '?1'
};

// 多域名轮换（避免单域名被封，提升稳定性）
// 移除img4.doubanio.com，因为它无法解析
const DOUBAN_DOMAINS = [
  'img1.doubanio.com',
  'img9.doubanio.com',
  'img2.doubanio.com',
  'img3.doubanio.com'
];

// 中转接口：前端直接请求 /api/douban/cover/:coverId
app.get('/api/douban/cover/:coverId', async (req, res) => {
  const { coverId } = req.params;
  const randomDomain = DOUBAN_DOMAINS[Math.floor(Math.random() * DOUBAN_DOMAINS.length)];
  const doubanUrl = `https://${randomDomain}/view/subject/l/public/${coverId}.jpg`;

  try {
    console.log(`📤 开始转发图片请求，ID: ${coverId}, URL: ${doubanUrl}`);
    // 后端发起请求（完全自定义请求头，不受浏览器限制）
    const response = await axios.get(doubanUrl, {
      headers: { ...DOUBAN_HEADERS, Host: randomDomain }, // 动态匹配Host
      responseType: 'stream',
      timeout: 15000,
      maxRedirects: 5
    });

    console.log(`✅ 成功获取豆瓣图片，状态码: ${response.status}`);
    // 转发图片流 + 优化缓存
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 缓存7天
    res.setHeader('X-Proxy-Source', 'QC-booklog-Backend'); // 自定义响应头，便于调试

    // 管道传输图片数据到前端
    response.data.pipe(res);

    // 处理流错误
    response.data.on('error', (err) => {
      logger.error('图片流传输错误:', err);
      res.status(500).end();
    });

  } catch (err) {
    console.error(`❌ 封面中转失败（ID: ${coverId}）:`);
    console.error(`   错误类型: ${err.name}`);
    console.error(`   错误消息: ${err.message}`);
    console.error(`   完整错误:`, err);
    logger.error(`封面中转失败（ID: ${coverId}）:`, err);
    // 直接返回404，让前端处理降级，避免依赖外部服务
    res.status(404).end();
  }
});

// 阿里云OSS图片请求头
const ALIYUN_OSS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'http://localhost:7402/', // 模拟前端请求的Referer
  'Origin': 'http://localhost:7402' // 模拟前端请求的Origin
};

// 阿里云OSS图片中转接口
app.get('/api/aliyun-oss-image/:imagePath*', async (req, res) => {
  // 合并路径参数，处理带多个斜杠的情况
  const imagePath = req.params.imagePath + (req.params[0] || '');
  const aliyunUrl = `https://data-isbn.oss-cn-hangzhou.aliyuncs.com/${imagePath}`;

  try {
    console.log(`📤 开始转发阿里云OSS图片请求，路径: ${imagePath}, URL: ${aliyunUrl}`);
    // 后端发起请求（添加合适的请求头，避免403错误）
    const response = await axios.get(aliyunUrl, {
      headers: ALIYUN_OSS_HEADERS,
      responseType: 'stream',
      timeout: 15000,
      maxRedirects: 5
    });

    console.log(`✅ 成功获取阿里云OSS图片，状态码: ${response.status}`);
    // 转发图片流 + 优化缓存
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800'); // 缓存7天
    res.setHeader('X-Proxy-Source', 'QC-booklog-Backend'); // 自定义响应头，便于调试

    // 管道传输图片数据到前端
    response.data.pipe(res);

    // 处理流错误
    response.data.on('error', (err) => {
      logger.error('阿里云OSS图片流传输错误:', err);
      res.status(500).end();
    });

  } catch (err) {
    console.error(`❌ 阿里云OSS图片中转失败（路径: ${imagePath}）:`);
    console.error(`   错误类型: ${err.name}`);
    console.error(`   错误消息: ${err.message}`);
    console.error(`   完整错误:`, err);
    logger.error(`阿里云OSS图片中转失败（路径: ${imagePath}）:`, err);
    // 直接返回404，让前端处理降级，避免依赖外部服务
    res.status(404).end();
  }
});

// 导入路由模块
import bookRoutes from './routes/books/index.js';
import groupRoutes from './routes/groups.js';
import tagRoutes from './routes/tags.js';
import bookmarkRoutes from './routes/bookmarks.js';
import backupRoutes from './routes/backup.js';
import dataTransferRoutes from './routes/dataTransfer.js';
import dbrRoutes from './routes/dbr.js';
import syncRoutes from './routes/sync.js';
import configRoutes from './routes/config/index.js';
import readingStatusRoutes from './routes/readingstatus.js';
import qcGroupsRoutes from './routes/qcGroups.js';
import qcBookmarksRoutes from './routes/qcBookmarks.js';
import readerRoutes from './routes/readers.js';
import readingGoalsRoutes from './routes/readingGoals.js';
import readingHeatmapRoutes from './routes/readingHeatmap.js';
import readingTrackingRoutes from './routes/readingTracking.js';
import wishlistRoutes from './routes/wishlist.js';
import activitiesRoutes from './routes/activities.js';
import readingStateSyncRoutes from './routes/readingStateSync.js';
import userSettingsRoutes from './routes/userSettings.js';
import userImagesRoutes from './routes/userImages.js';
import bookSourceSettingsRoutes from './routes/bookSourceSettings.js';
import reviewRoutes from './routes/reviews.js';
import gitSyncRoutes from './routes/gitSync.js';
import doulistRoutes from './routes/doulist.js';
import annualSummaryRoutes from './routes/annualSummary.js';
import dbrService from './services/legacy/dbrService.js';

// 注册路由
app.use('/api/books', bookRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/bookmarks', bookmarkRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/data-transfer', dataTransferRoutes);
app.use('/api/dbr', dbrRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/config', configRoutes);
app.use('/api/readingstatus', readingStatusRoutes);
app.use('/api/qc/groups', qcGroupsRoutes);
app.use('/api/qc/bookmarks', qcBookmarksRoutes);
app.use('/api/readers', readerRoutes);
app.use('/api/reading-goals', readingGoalsRoutes);
app.use('/api/reading-heatmap', readingHeatmapRoutes);
app.use('/api/reading', readingTrackingRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/reading-state-sync', readingStateSyncRoutes);
app.use('/api/user-settings', userSettingsRoutes);
app.use('/api/user-images', userImagesRoutes);
app.use('/api/book-source-settings', bookSourceSettingsRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/git', gitSyncRoutes);
app.use('/api/doulist', doulistRoutes);
app.use('/api/annual-summary', annualSummaryRoutes);

// 书源 API 代理：统一由插件层处理
app.get('/api/tanshu/isbn/:isbn', async (req, res) => {
  try {
    const { isbn } = req.params;
    console.log(`🔍 探数图书API请求，ISBN: ${isbn}`);
    const data = await bookSourceSettingsService.searchByIsbn('tanshu', isbn);
    console.log(`✅ 探数图书API响应:`, data);
    res.json(data);
  } catch (error) {
    console.error(`❌ 探数图书API错误:`, error.message);
    res.status(500).json({ error: error.message || '探数图书API调用失败' });
  }
});

app.get('/api/douban/v2/book/isbn/:isbn', async (req, res) => {
  try {
    const { isbn } = req.params;
    console.log(`🔍 豆瓣图书API请求，ISBN: ${isbn}`);
    const data = await bookSourceSettingsService.searchByIsbn('douban', isbn);
    console.log(`✅ 豆瓣图书API响应成功，书名: ${data.title || '无'}`);
    res.json(data);
  } catch (error) {
    console.error(`❌ 豆瓣图书API错误:`, error.message);
    res.status(500).json({ error: error.message || '豆瓣图书API调用失败' });
  }
});

app.get('/api/isbn-work/isbn/:isbn', async (req, res) => {
  try {
    const { isbn } = req.params;
    console.log(`🔍 公共图书API请求，ISBN: ${isbn}`);
    const data = await bookSourceSettingsService.searchByIsbn('isbnWork', isbn);
    console.log(`✅ 公共图书API响应:`, data);
    res.json(data);
  } catch (error) {
    console.error(`❌ 公共图书API错误:`, error.message);
    res.status(500).json({ error: error.message || '公共图书API调用失败' });
  }
});

// 性能监控路由
app.get('/api/performance/metrics', (req, res) => {
  try {
    const metrics = {
      calibre: calibreService.getPerformanceMetrics(),
      dbr: dbrService.getPerformanceMetrics(),
      timestamp: new Date().toISOString()
    };
    res.json(metrics);
  } catch (error) {
    logger.error('Failed to get performance metrics', error);
    res.status(500).json({ error: 'Failed to get performance metrics' });
  }
});

// 性能报告路由
app.get('/api/performance/report', (req, res) => {
  try {
    calibreService.printPerformanceReport();
    dbrService.printPerformanceReport();
    res.json({ message: 'Performance report printed to console' });
  } catch (error) {
    logger.error('Failed to print performance report', error);
    res.status(500).json({ error: 'Failed to print performance report' });
  }
});

// 前端静态资源托管（生产构建产物 dist/）
// 优先级必须保持：/api 路由（含上方 /api/static/calibre 动态文件服务）→ 静态资源 → SPA fallback
if (fsSync.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));

  // SPA history 模式回退：非 /api 的 GET 请求统一返回 index.html
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
} else {
  console.log('ℹ️ 未找到 dist/ 构建产物，仅提供 API 服务');
}

// 错误处理中间件
app.use((err, req, res, next) => {
  logger.error('Server error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// 启动服务器
const startServer = async () => {
  try {
    console.log('🔄 正在初始化数据库服务...');
    await databaseService.init();
    console.log('✅ 数据库服务初始化成功');

    // 初始化 Git 同步服务（仅在 QCBookLog 库可用时）
    if (databaseService.connectionManager?.isQcBooklogAvailable()) {
      try {
        const { default: gitService } = await import('./services/git/gitService.js');
        await gitService.init();
      } catch (err) {
        console.warn('⚠️ Git 同步服务初始化失败（不影响主功能）:', err.message);
      }
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
      const actualPort = server.address().port;
      // 供 Electron 主进程解析实际监听端口
      console.log(`SERVER_LISTENING_PORT=${actualPort}`);
      logger.info(`Server is running on port ${actualPort}`);
      console.log(`Server is running on http://0.0.0.0:${actualPort}`);

      // 显示数据库服务状态
      console.log(`\n📊 数据库服务状态:`);
      console.log(`   - 初始化状态: ${databaseService._initialized ? '✅ 已初始化' : '❌ 未初始化'}`);
      console.log(`   - Calibre数据库: ${databaseService.connectionManager?.calibreDb ? '✅ 已连接' : '❌ 未连接'}`);
      console.log(`   - Talebook数据库: ${databaseService.connectionManager?.talebookDb ? '✅ 已连接' : '❌ 未连接'}`);
      console.log(`   - QCBookLog数据库: ${databaseService.connectionManager?.qcBooklogDb ? '✅ 已连接' : '❌ 未连接'}`);
      console.log(`   - Calibre路径: ${databaseService.connectionManager?.config?.calibrePath || '未配置'}`);
      console.log(`   - Talebook路径: ${databaseService.connectionManager?.config?.talebookPath || '未配置'}`);
      console.log(`   - QCBookLog路径: ${databaseService.connectionManager?.config?.qcBooklogPath || '未配置'}`);

      if (databaseService.connectionManager?.calibreError) {
        console.log(`   ⚠️ Calibre连接错误: ${databaseService.connectionManager.calibreError}`);
      }
      if (databaseService.connectionManager?.talebookError) {
        console.log(`   ⚠️ Talebook连接错误: ${databaseService.connectionManager.talebookError}`);
      }
      if (databaseService.connectionManager?.qcBooklogError) {
        console.log(`   ⚠️ QCBookLog连接错误: ${databaseService.connectionManager.qcBooklogError}`);
      }

      // 显示当前配置的数据库路径
      const currentDbPath = calibreService.getBookDir();
      console.log(`\n📚 当前 Calibre 书库目录: ${currentDbPath}`);
      console.log(`✅ 如果需要切换书库，请访问: http://localhost:${actualPort}/config`);
      console.log('');

      // 启动同步调度器
      if (databaseService.connectionManager?.isQcBooklogAvailable()) {
        console.log(`🔄 启动阅读状态同步调度器...`);
        syncScheduler.start();
        console.log(`✅ 阅读状态同步调度器已启动`);
      } else {
        console.log(`⚠️ QCBookLog 数据库不可用，跳过启动同步调度器`);
      }

      // 局域网监听（监听 B）：默认关闭，LAN_ENABLED=1 时开启
      if (process.env.LAN_ENABLED === '1') {
        startLanListener(actualPort);
      }
    });
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
};

/**
 * 启动局域网监听（监听 B）
 * 独立 Express 实例，仅挂鉴权中间件 + 路由代理，不影响桌面窗口（监听 A）
 */
const startLanListener = (localPort) => {
  const lanAuth = createLanAuth();
  const lanApp = express();

  // 静态页面放行，API 走口令校验
  lanApp.use(lanAuth.middleware);

  // 其余请求全部转发到本地监听 A（同进程内的回环请求）
  lanApp.use((req, res) => {
    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: localPort,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${localPort}` }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: '后端转发失败' });
      }
    });
    req.pipe(proxyReq);
  });

  const lanPort = process.env.QC_LAN_PORT ? Number(process.env.QC_LAN_PORT) : 0;
  const lanServer = lanApp.listen(lanPort, '0.0.0.0', () => {
    const actualLanPort = lanServer.address().port;
    console.log(`LAN_LISTENING_PORT=${actualLanPort}`);
    console.log(`LAN_PASSCODE=${lanAuth.getPasscode()}`);
    console.log(`📱 手机访问已开启，端口 ${actualLanPort}`);
  });
};

startServer();