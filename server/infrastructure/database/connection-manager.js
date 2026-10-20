/**
 * 数据库连接管理器
 * 负责管理 Calibre 和 Talebook 数据库的连接
 */

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import configManager from '../../config/index.js';
import fsSync from 'fs';
import { PROJECT_ROOT, DATA_DIR } from '../../utils/paths.js';

// 使用同步 require 导入 better-sqlite3
const require = createRequire(import.meta.url);
let Database = null;

try {
  const module = require('better-sqlite3');
  Database = module.default || module;
  console.log('✅ better-sqlite3 导入成功');
} catch (error) {
  console.warn('⚠️ better-sqlite3 未安装，数据库服务将不可用');
  console.warn('⚠️ 请运行: cd server && npm install better-sqlite3 --build-from-source');
  console.warn('⚠️ 或安装 Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/');
}

/**
 * 数据库连接管理器
 */
class DatabaseConnectionManager {
  constructor() {
    this.calibreDb = null;
    this.talebookDb = null;
    this.qcBooklogDb = null;
    this.config = this.loadConfig();
    this._currentLibraryUuid = null;
    this.calibreError = null;
    this.talebookError = null;
    this.qcBooklogError = null;
    // Talebook 关键表可用性缓存：null 表示尚未探测
    this._talebookUsable = null;
  }

  /**
   * 加载配置
   */
  loadConfig() {
    const config = configManager.loadConfigSync();
    
    const projectRoot = this.getProjectRoot();
    
    // 数据文件统一落在 DATA_DIR 下（Electron 下为 userData/data）
    const defaultCalibrePath = path.join(DATA_DIR, 'calibre/metadata.db');
    const defaultTalebookPath = path.join(DATA_DIR, 'talebook/calibre-webserver.db');
    const defaultQcBooklogPath = path.join(DATA_DIR, 'qc_booklog.db');

    const resolvePath = (dbPath) => {
      if (!dbPath) return dbPath;
      if (path.isAbsolute(dbPath)) return dbPath;
      return path.resolve(projectRoot, dbPath);
    };

    // 调试日志：显示环境变量和配置值
    console.log('🔍 connection-manager 配置调试:');
    console.log('  process.env.CALIBRE_DB_PATH:', process.env.CALIBRE_DB_PATH || '(未设置)');
    console.log('  process.env.TALEBOOK_DB_PATH:', process.env.TALEBOOK_DB_PATH || '(未设置)');
    console.log('  process.env.QCBOOKLOG_DB_PATH:', process.env.QCBOOKLOG_DB_PATH || '(未设置)');
    console.log('  config.calibrePath:', config.calibrePath || '(未设置)');
    console.log('  config.talebookPath:', config.talebookPath || '(未设置)');
    console.log('  config.qcBooklogPath:', config.qcBooklogPath || '(未设置)');

    // 优先级：1. 环境变量（Docker） 2. 配置文件 3. 默认路径
    const calibrePath = process.env.CALIBRE_DB_PATH || config.calibrePath;
    const talebookPath = process.env.TALEBOOK_DB_PATH || config.talebookPath;
    const qcBooklogPath = process.env.QCBOOKLOG_DB_PATH || config.qcBooklogPath;

    return {
      calibrePath: resolvePath(calibrePath) || defaultCalibrePath,
      talebookPath: resolvePath(talebookPath) || defaultTalebookPath,
      qcBooklogPath: resolvePath(qcBooklogPath) || defaultQcBooklogPath
    };
  }
  
  /**
   * 获取项目根目录
   */
  getProjectRoot() {
    return PROJECT_ROOT;
  }

  /**
   * 初始化所有数据库连接
   */
  async init() {
    if (Database) {
      await this.initCalibre();
      await this.initTalebook();
      await this.initQcBooklog();
    }
  }

  /**
   * 初始化 Calibre 数据库
   */
  async initCalibre() {
    if (!this.calibreDb) {
      this.calibreError = null;
      try {
        // 检查数据库文件是否存在
        console.log('🔍 检查 Calibre 数据库文件:', this.config.calibrePath);
        if (!fsSync.existsSync(this.config.calibrePath)) {
          throw new Error(`数据库文件不存在: ${this.config.calibrePath}`);
        }
        
        // 检查文件权限
        try {
          fsSync.accessSync(this.config.calibrePath, fsSync.constants.R_OK);
          console.log('✅ 数据库文件可读');
        } catch (accessErr) {
          throw new Error(`数据库文件不可读: ${this.config.calibrePath}`);
        }
        
        this.calibreDb = new Database(this.config.calibrePath);
        this.calibreDb.pragma('journal_mode = WAL');
        this.calibreDb.pragma('busy_timeout = 10000');
        this.calibreDb.pragma('foreign_keys = ON');
        console.log('✅ Calibre 数据库连接成功:', this.config.calibrePath);
        this._currentLibraryUuid = this.fetchLibraryUuid();
        if (this._currentLibraryUuid) {
          console.log('📚 当前 Calibre 库 UUID:', this._currentLibraryUuid);
        }
      } catch (error) {
        console.error('❌ Calibre 数据库连接失败:', error.message);
        console.error('❌ 数据库路径:', this.config.calibrePath);
        
        // 列出目录内容帮助诊断
        const dbDir = path.dirname(this.config.calibrePath);
        try {
          if (fsSync.existsSync(dbDir)) {
            const files = fsSync.readdirSync(dbDir);
            console.log(`📁 目录 ${dbDir} 内容:`, files.slice(0, 10).join(', '), files.length > 10 ? `... 共${files.length}个文件` : '');
          } else {
            console.log(`❌ 目录不存在: ${dbDir}`);
          }
        } catch (e) {
          console.log(`❌ 无法读取目录: ${dbDir}`, e.message);
        }
        
        this.calibreDb = null;
        this.calibreError = error.message;
      }
    }
  }

  /**
   * 从 Calibre 数据库获取 library_uuid
   */
  fetchLibraryUuid() {
    if (!this.calibreDb) {
      return null;
    }

    try {
      let libraryUuid = null;

      // 方法1: 从 library_id 表获取（Calibre 标准位置）
      try {
        const result = this.calibreDb.prepare(`
          SELECT uuid FROM library_id LIMIT 1
        `).get();
        libraryUuid = result ? result.uuid : null;
        if (libraryUuid) {
          console.log('📚 从 library_id 表获取到 UUID:', libraryUuid);
          return libraryUuid;
        }
      } catch (e) {
        // library_id 表可能不存在
      }

      // 方法2: 从 metadata_plugins 表获取
      try {
        const result = this.calibreDb.prepare(`
          SELECT value FROM metadata_plugins WHERE name = 'calibre_library_uuid'
        `).get();
        libraryUuid = result ? result.value : null;
        if (libraryUuid) {
          console.log('📚 从 metadata_plugins 表获取到 UUID:', libraryUuid);
          return libraryUuid;
        }
      } catch (e) {
        // metadata_plugins 表可能不存在
      }

      // 方法3: 从 preferences 表获取（key/val 结构）
      try {
        const result = this.calibreDb.prepare(`
          SELECT val FROM preferences WHERE key = 'library_uuid'
        `).get();
        libraryUuid = result ? result.val : null;
        if (libraryUuid) {
          console.log('📚 从 preferences 表(key/val)获取到 UUID:', libraryUuid);
          return libraryUuid;
        }
      } catch (e) {
        // preferences 表可能不存在或结构不同
      }

      // 方法4: 从 preferences 表获取（name/value 结构）
      try {
        const result = this.calibreDb.prepare(`
          SELECT value FROM preferences WHERE name = 'library_uuid'
        `).get();
        libraryUuid = result ? result.value : null;
        if (libraryUuid) {
          console.log('📚 从 preferences 表(name/value)获取到 UUID:', libraryUuid);
          return libraryUuid;
        }
      } catch (e) {
        // preferences 表结构不同
      }

      // 方法5: 生成基于数据库路径的默认 UUID
      const dbPath = this.config.calibrePath;
      const defaultUuid = 'qc-' + crypto.createHash('md5').update(dbPath).digest('hex').substring(0, 8);
      console.log('📚 无法从数据库获取 UUID，生成默认 UUID:', defaultUuid, '(基于路径:', dbPath, ')');
      return defaultUuid;
    } catch (error) {
      console.warn('⚠️ 获取 library_uuid 失败:', error.message);
      // 返回一个默认值，确保系统可以正常运行
      return 'qc-default-library';
    }
  }

  /**
   * 获取当前 Calibre 库的 UUID
   */
  getCurrentLibraryUuid() {
    if (!this._currentLibraryUuid && this.calibreDb) {
      this._currentLibraryUuid = this.fetchLibraryUuid();
      console.log('📚 getCurrentLibraryUuid - 获取到的 UUID:', this._currentLibraryUuid);
    }
    if (!this._currentLibraryUuid) {
      console.warn('⚠️ getCurrentLibraryUuid - UUID 为空, calibreDb:', !!this.calibreDb);
    }
    return this._currentLibraryUuid;
  }

  /**
   * 初始化 Talebook 数据库
   */
  async initTalebook() {
    if (!this.talebookDb) {
      this.talebookError = null;
      try {
        this.talebookDb = new Database(this.config.talebookPath);
        this.talebookDb.pragma('journal_mode = WAL');
        this.talebookDb.pragma('busy_timeout = 10000');
        this.talebookDb.pragma('foreign_keys = ON');
        console.log('✅ Talebook 数据库连接成功:', this.config.talebookPath);
        
        this.ensureDefaultReader();
        this.upgradeTalebookSchema();
        this.detectTalebookUsability();
      } catch (error) {
        console.error('❌ Talebook 数据库连接失败:', error.message);
        console.error('❌ 数据库路径:', this.config.talebookPath);
        this.talebookDb = null;
        this._talebookUsable = null;
        this.talebookError = error.message;
      }
    }
  }

  /**
   * 探测 Talebook 关键业务表是否真实可用
   *
   * 背景：Talebook 库文件可能只是「存在但为空」，此时连接对象非空、
   * 但 reading_state / items 等表并不存在。若仅用 `if (this.talebookDb)`
   * 判定数据来源，查询会抛错后被静默吞掉，导致始终读不到真实数据。
   * 这里把「表是否可用」作为唯一判定依据，并将结果缓存。
   *
   * @returns {boolean} Talebook 关键表是否可用
   */
  detectTalebookUsability() {
    if (!this.talebookDb) {
      this._talebookUsable = false;
      return false;
    }

    try {
      const requiredTables = ['reading_state', 'items'];
      const placeholders = requiredTables.map(() => '?').join(',');
      const rows = this.talebookDb
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (${placeholders})`
        )
        .all(...requiredTables);
      const found = new Set(rows.map((r) => r.name));
      this._talebookUsable = requiredTables.every((t) => found.has(t));

      if (this._talebookUsable) {
        console.log('✅ Talebook 关键表可用（reading_state / items）');
      } else {
        const missing = requiredTables.filter((t) => !found.has(t));
        console.warn(
          `⚠️ Talebook 缺少关键表 [${missing.join(', ')}]，将降级使用 QCBookLog 数据库`
        );
        this.talebookError = `缺少关键表: ${missing.join(', ')}`;
      }
    } catch (error) {
      console.warn('⚠️ Talebook 可用性探测失败:', error.message);
      this._talebookUsable = false;
      this.talebookError = error.message;
    }

    return this._talebookUsable;
  }

  /**
   * 获取「真实可用」的 Talebook 数据库实例
   *
   * 与 getTalebookDb() 的区别：当 Talebook 缺少关键表时返回 null，
   * 使调用方原有的 `if (talebookDb) ... else ...` 降级分支能正确走通。
   * 若调用方需要库路径等元信息（配置页展示），请使用 getTalebookDb()。
   *
   * @returns {import('better-sqlite3').Database|null}
   */
  getUsableTalebookDb() {
    if (this._talebookUsable === null) {
      this.detectTalebookUsability();
    }
    return this._talebookUsable ? this.talebookDb : null;
  }

  upgradeTalebookSchema() {
    if (!this.talebookDb) return;
    
    try {
      try {
        this.talebookDb.exec(`ALTER TABLE reading_state ADD COLUMN personal_rating REAL DEFAULT 0`);
        console.log('✅ 添加 personal_rating 列');
      } catch (e) {
        if (!e.message.includes('duplicate column')) {
          console.warn('⚠️ 添加 personal_rating 列失败:', e.message);
        }
      }
      
      try {
        this.talebookDb.exec(`ALTER TABLE reading_state ADD COLUMN personal_rating_date TEXT`);
        console.log('✅ 添加 personal_rating_date 列');
      } catch (e) {
        if (!e.message.includes('duplicate column')) {
          console.warn('⚠️ 添加 personal_rating_date 列失败:', e.message);
        }
      }
      
      console.log('✅ Talebook 数据库架构升级完成');
    } catch (error) {
      console.warn('⚠️ Talebook 数据库架构升级失败:', error.message);
    }
  }

  ensureDefaultReader() {
    if (!this.talebookDb) return;
    
    try {
      // 确保 readers 表有 extra 字段
      try {
        this.talebookDb.exec(`ALTER TABLE readers ADD COLUMN extra TEXT DEFAULT '{}'`);
        console.log('✅ 已添加 readers.extra 字段');
      } catch (e) {
        // 字段已存在，忽略错误
      }
      
      // 修复现有读者的 extra 字段为空 JSON 对象
      this.talebookDb.prepare(`UPDATE readers SET extra = '{}' WHERE extra IS NULL OR extra = ''`).run();
      
      const existing = this.talebookDb.prepare('SELECT id FROM readers WHERE id = 0').get();
      if (!existing) {
        this.talebookDb.prepare(`
          INSERT INTO readers (id, username, password, salt, name, email, admin, active, permission, extra, create_time, update_time)
          VALUES (0, 'default', '', '', 'Default Reader', '', 0, 1, '', '{}', datetime('now'), datetime('now'))
        `).run();
        console.log('✅ 已创建默认读者 (id=0)');
      }
    } catch (error) {
      console.warn('⚠️ 创建默认读者失败:', error.message);
    }
  }

  /**
   * 初始化 QCBookLog 数据库
   */
  async initQcBooklog() {
    if (!this.qcBooklogDb) {
      this.qcBooklogError = null;
      try {
        this.qcBooklogDb = new Database(this.config.qcBooklogPath);
        this.qcBooklogDb.pragma('journal_mode = WAL');
        this.qcBooklogDb.pragma('busy_timeout = 10000');
        this.qcBooklogDb.pragma('foreign_keys = ON');
        console.log('✅ QCBookLog 数据库连接成功:', this.config.qcBooklogPath);
        
        this.createQcBooklogTables();
      } catch (error) {
        console.error('❌ QCBookLog 数据库连接失败:', error.message);
        console.error('❌ 数据库路径:', this.config.qcBooklogPath);
        this.qcBooklogDb = null;
        this.qcBooklogError = error.message;
      }
    }
  }

  /**
   * 创建 QCBookLog 数据库表结构
   */
  createQcBooklogTables() {
    if (!this.qcBooklogDb) {
      console.error('❌ 数据库未连接，无法创建表结构');
      return;
    }

    try {
      console.log('📝 检查并创建 QCBookLog 数据库表结构...');

      // 创建书籍映射表
      console.log('📝 创建书籍映射表 (qc_book_mapping)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_mapping (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          library_uuid TEXT NOT NULL DEFAULT '',
          calibre_book_id INTEGER NOT NULL,
          talebook_book_id INTEGER,
          title TEXT,
          author TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(library_uuid, calibre_book_id)
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_mapping_library ON qc_book_mapping(library_uuid)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_mapping_calibre ON qc_book_mapping(calibre_book_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_mapping_library_calibre ON qc_book_mapping(library_uuid, calibre_book_id)
      `);
      console.log('  ✅ qc_book_mapping 表创建成功');

      this.ensureLibraryUuidColumn();

      // 创建用户表
      console.log('📝 创建用户表 (qc_users)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_users (
          id INTEGER PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          display_name VARCHAR(100),
          name VARCHAR(100),
          email VARCHAR(100),
          avatar_url VARCHAR(255),
          avatar VARCHAR(255),
          admin INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_qc_users_username ON qc_users(username)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_qc_users_email ON qc_users(email)
      `);
      console.log('  ✅ qc_users 表创建成功');

      // 创建分组表
      console.log('📝 创建分组表 (qc_groups)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(50) NOT NULL UNIQUE,
          description TEXT,
          color VARCHAR(7),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('  ✅ qc_groups 表创建成功');

      // 创建标签表
      console.log('📝 创建标签表 (qc_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name VARCHAR(50) NOT NULL UNIQUE,
          color VARCHAR(7),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('  ✅ qc_tags 表创建成功');

      // 检查并更新 qc_bookdata 表结构（添加 book_id UNIQUE 约束）
      const bookdataInfo = this.qcBooklogDb.prepare("SELECT sql FROM sqlite_master WHERE name = 'qc_bookdata'").get();
      if (bookdataInfo && !bookdataInfo.sql.includes('book_id INTEGER NOT NULL UNIQUE')) {
        console.log('  🔄 检测到 qc_bookdata 表结构需要更新，正在重建...');
        this.qcBooklogDb.exec('DROP TABLE IF EXISTS qc_reading_records');
        this.qcBooklogDb.exec('DROP TABLE IF EXISTS qc_bookdata');
        console.log('  ✅ 旧表已删除');
      }

      // 创建书籍扩展数据表
      console.log('📝 创建书籍扩展数据表 (qc_bookdata)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookdata (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER,
          book_id INTEGER NOT NULL UNIQUE,
          page_count INTEGER DEFAULT 0,
          standard_price REAL DEFAULT 0,
          purchase_price REAL DEFAULT 0,
          purchase_date TEXT,
          binding1 INTEGER DEFAULT 0,
          binding2 INTEGER DEFAULT 0,
          paper1 INTEGER DEFAULT 0,
          edge1 INTEGER DEFAULT 0,
          edge2 INTEGER DEFAULT 0,
          note TEXT DEFAULT '',
          book_type INTEGER DEFAULT 1,
          total_reading_time INTEGER DEFAULT 0,
          read_pages INTEGER DEFAULT 0,
          reading_count INTEGER DEFAULT 0,
          last_read_date TEXT,
          last_read_duration INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE SET NULL
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_bookdata_mapping ON qc_bookdata(mapping_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_bookdata_book_id ON qc_bookdata(book_id)
      `);
      console.log('  ✅ qc_bookdata 表创建成功');

      // 检查并添加缺失的 book_type 列（兼容旧数据库）
      try {
        const columns = this.qcBooklogDb.prepare("PRAGMA table_info(qc_bookdata)").all();
        const hasBookType = columns.some(col => col.name === 'book_type');
        if (!hasBookType) {
          console.log('  🔄 检测到 qc_bookdata 表缺少 book_type 列，正在添加...');
          this.qcBooklogDb.exec('ALTER TABLE qc_bookdata ADD COLUMN book_type INTEGER DEFAULT 1');
          console.log('  ✅ book_type 列添加成功');
        }
      } catch (err) {
        console.warn('  ⚠️ 检查/添加 book_type 列失败:', err.message);
      }

      // 检查并添加缺失的 source 列（兼容旧数据库）
      try {
        const columns = this.qcBooklogDb.prepare("PRAGMA table_info(qc_bookdata)").all();
        const hasSource = columns.some(col => col.name === 'source');
        if (!hasSource) {
          console.log('  🔄 检测到 qc_bookdata 表缺少 source 列，正在添加...');
          this.qcBooklogDb.exec("ALTER TABLE qc_bookdata ADD COLUMN source TEXT DEFAULT ''");
          console.log('  ✅ source 列添加成功');
        }
      } catch (err) {
        console.warn('  ⚠️ 检查/添加 source 列失败:', err.message);
      }

      // 创建书摘表
      console.log('📝 创建书摘表 (qc_bookmarks)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER NOT NULL,
          user_id INTEGER DEFAULT 0,
          chapter TEXT,
          pos INTEGER DEFAULT 0,
          pos_type TEXT DEFAULT 'chapter',
          text TEXT,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE CASCADE
        )
      `);
      console.log('  ✅ qc_bookmarks 表创建成功');

      // 创建书摘标签关联表
      console.log('📝 创建书摘标签关联表 (qc_bookmark_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookmark_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookmark_id INTEGER NOT NULL,
          tag_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (bookmark_id) REFERENCES qc_bookmarks(id) ON DELETE CASCADE
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_bookmark_tags_bookmark_id ON qc_bookmark_tags(bookmark_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag_id ON qc_bookmark_tags(tag_id)
      `);
      console.log('  ✅ qc_bookmark_tags 表创建成功');

      // 创建书籍分组关联表
      console.log('📝 创建书籍分组关联表 (qc_book_groups)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE CASCADE,
          FOREIGN KEY (group_id) REFERENCES qc_groups(id) ON DELETE CASCADE,
          UNIQUE(mapping_id, group_id)
        )
      `);
      console.log('  ✅ qc_book_groups 表创建成功');

      // 创建书籍标签关联表
      console.log('📝 创建书籍标签关联表 (qc_book_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES qc_tags(id) ON DELETE CASCADE,
          UNIQUE(mapping_id, tag_id)
        )
      `);
      console.log('  ✅ qc_book_tags 表创建成功');

      // 创建阅读记录表
      console.log('📝 创建阅读记录表 (qc_reading_records)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_reading_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          user_id INTEGER DEFAULT 0,
          reader_id INTEGER DEFAULT 0,
          start_time TEXT,
          end_time TEXT,
          duration INTEGER DEFAULT 0,
          start_page INTEGER DEFAULT 0,
          end_page INTEGER DEFAULT 0,
          pages_read INTEGER DEFAULT 0,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_reading_book_user ON qc_reading_records(book_id, user_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_reading_start_time ON qc_reading_records(start_time)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_reading_user_date ON qc_reading_records(user_id, start_time)
      `);
      console.log('  ✅ qc_reading_records 表创建成功');

      // 创建阅读状态表
      console.log('📝 创建阅读状态表 (qc_reading_state)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_reading_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER NOT NULL UNIQUE,
          user_id INTEGER DEFAULT 0,
          read_status TEXT DEFAULT '未读',
          current_chapter TEXT,
          current_page INTEGER DEFAULT 0,
          total_pages INTEGER DEFAULT 0,
          progress REAL DEFAULT 0,
          last_read_at DATETIME,
          book_id INTEGER,
          reader_id INTEGER DEFAULT 0,
          favorite INTEGER DEFAULT 0,
          wants INTEGER DEFAULT 0,
          read_state INTEGER DEFAULT 0,
          online_read INTEGER DEFAULT 0,
          download INTEGER DEFAULT 0,
          progress_percent INTEGER DEFAULT 0,
          notes TEXT,
          rating INTEGER DEFAULT 0,
          personal_rating REAL DEFAULT 0,
          personal_rating_date TEXT,
          favorite_date TEXT,
          wants_date TEXT,
          read_date TEXT,
          start_date TEXT,
          last_read_time TEXT,
          sync_status INTEGER DEFAULT 0,
          last_sync_time TEXT,
          sync_error TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE CASCADE
        )
      `);
      console.log('  ✅ qc_reading_state 表创建成功');

      // 创建阅读状态表索引
      console.log('📝 创建阅读状态表索引...');
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_qc_reading_state_mapping_id ON qc_reading_state(mapping_id);
        CREATE INDEX IF NOT EXISTS idx_qc_reading_state_user_id ON qc_reading_state(user_id);
        CREATE INDEX IF NOT EXISTS idx_qc_reading_state_read_status ON qc_reading_state(read_status);
        CREATE INDEX IF NOT EXISTS idx_qc_reading_state_reader_id ON qc_reading_state(reader_id);
        CREATE INDEX IF NOT EXISTS idx_qc_reading_state_book_reader ON qc_reading_state(book_id, reader_id);
      `);
      console.log('  ✅ qc_reading_state 表索引创建成功');

      // 创建每日统计表
      console.log('📝 创建每日统计表 (qc_daily_reading_stats)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_daily_reading_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          reader_id INTEGER DEFAULT 0,
          stat_date DATE NOT NULL,
          date DATE,
          total_reading_time INTEGER DEFAULT 0,
          total_time INTEGER DEFAULT 0,
          total_pages_read INTEGER DEFAULT 0,
          total_pages INTEGER DEFAULT 0,
          books_read_count INTEGER DEFAULT 0,
          total_books INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, stat_date),
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date ON qc_daily_reading_stats(user_id, stat_date)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_daily_stats_reader_date ON qc_daily_reading_stats(reader_id, stat_date)
      `);
      console.log('  ✅ qc_daily_reading_stats 表创建成功');

      // 创建阅读目标表
      console.log('📝 创建阅读目标表 (qc_reading_goals)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_reading_goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          reader_id INTEGER DEFAULT 0,
          year INTEGER,
          goal_type VARCHAR(20) NOT NULL,
          target INTEGER DEFAULT 0,
          target_value INTEGER DEFAULT 0,
          completed INTEGER DEFAULT 0,
          current_value INTEGER DEFAULT 0,
          start_date DATE NOT NULL,
          end_date DATE,
          status VARCHAR(20) DEFAULT 'active',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, year),
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_reading_goals_user_year ON qc_reading_goals(user_id, year)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_reading_goals_reader_year ON qc_reading_goals(reader_id, year)
      `);
      console.log('  ✅ qc_reading_goals 表创建成功');

      // 创建评论表
      console.log('📝 创建评论表 (qc_comments)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          rating INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        )
      `);
      console.log('  ✅ qc_comments 表创建成功');

      // 创建愿望清单表
      console.log('📝 创建愿望清单表 (qc_wishlist)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_wishlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mapping_id INTEGER,
          user_id INTEGER DEFAULT 0,
          reader_id INTEGER DEFAULT 0,
          title TEXT NOT NULL,
          author TEXT,
          isbn TEXT,
          publisher TEXT,
          price REAL,
          priority INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(reader_id, isbn),
          FOREIGN KEY (mapping_id) REFERENCES qc_book_mapping(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON qc_wishlist(user_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_wishlist_reader_id ON qc_wishlist(reader_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_wishlist_isbn ON qc_wishlist(isbn)
      `);
      console.log('  ✅ qc_wishlist 表创建成功');

      // 创建活动日志表
      console.log('📝 创建活动日志表 (qc_activity_log)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          user_id INTEGER DEFAULT 0,
          reader_id INTEGER DEFAULT 0,
          book_id INTEGER,
          book_title TEXT,
          book_author TEXT,
          book_cover TEXT,
          content TEXT,
          chapter TEXT,
          start_page INTEGER,
          end_page INTEGER,
          pages_read INTEGER,
          duration INTEGER,
          start_time TEXT,
          end_time TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON qc_activity_log(user_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_reader_id ON qc_activity_log(reader_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_type ON qc_activity_log(type)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_book_id ON qc_activity_log(book_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON qc_activity_log(created_at)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_user_date ON qc_activity_log(user_id, created_at)
      `);
      console.log('  ✅ qc_activity_log 表创建成功');

      console.log('📝 创建用户设置表 (qc_user_settings)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_user_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 0,
          setting_key TEXT NOT NULL,
          setting_value TEXT NOT NULL,
          setting_type TEXT NOT NULL DEFAULT 'string',
          priority TEXT NOT NULL DEFAULT 'high',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, setting_key)
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON qc_user_settings(user_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_settings_key ON qc_user_settings(setting_key)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_settings_priority ON qc_user_settings(priority)
      `);
      console.log('  ✅ qc_user_settings 表创建成功');

      console.log('📝 创建用户图片表 (qc_user_images)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_user_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 0,
          image_type TEXT NOT NULL,
          image_data TEXT NOT NULL,
          image_name TEXT,
          image_size INTEGER DEFAULT 0,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_images_user_id ON qc_user_images(user_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_images_type ON qc_user_images(image_type)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_user_images_sort ON qc_user_images(user_id, image_type, sort_order)
      `);
      console.log('  ✅ qc_user_images 表创建成功');

      // 创建书源设置表（存储图书源 API Key）
      console.log('📝 创建书源设置表 (qc_book_source_settings)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_source_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_key VARCHAR(50) NOT NULL UNIQUE,
          source_name VARCHAR(100) NOT NULL,
          api_key TEXT NOT NULL DEFAULT '',
          is_required INTEGER DEFAULT 0,
          description TEXT DEFAULT '',
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_book_source_settings_key ON qc_book_source_settings(source_key)
      `);
      console.log('  ✅ qc_book_source_settings 表创建成功');

      // 创建豆列书单表（独立于 qc_bookdata，主键为豆瓣 subject ID）
      console.log('📝 创建豆列书单表 (qc_doulist_books / qc_doulist_imports / qc_doulist_import_items)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_doulist_books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          douban_id TEXT NOT NULL UNIQUE,
          title TEXT,
          subtitle TEXT,
          author TEXT,
          translator TEXT,
          publisher TEXT,
          publish_year TEXT,
          isbn13 TEXT,
          isbn10 TEXT,
          pages INTEGER,
          price REAL,
          binding TEXT,
          producer TEXT,
          series TEXT,
          rating REAL,
          rating_count INTEGER,
          tags TEXT,
          summary TEXT,
          cover_url TEXT,
          douban_url TEXT,
          enrich_status TEXT DEFAULT 'none',
          enriched_at DATETIME,
          shelf_status TEXT DEFAULT 'pending',
          shelved_at DATETIME,
          read_status TEXT DEFAULT 'unread',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_doulist_books_enrich ON qc_doulist_books(enrich_status)
      `);
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_doulist_imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doulist_id TEXT NOT NULL,
          doulist_title TEXT,
          owner TEXT,
          owner_url TEXT,
          total_items INTEGER DEFAULT 0,
          total_pages INTEGER DEFAULT 0,
          status TEXT DEFAULT 'running',
          is_buy INTEGER DEFAULT 1,
          is_read INTEGER DEFAULT 0,
          last_start INTEGER DEFAULT 0,
          fetched_items INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(doulist_id)
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_doulist_imports_status ON qc_doulist_imports(status)
      `);
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_doulist_import_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doulist_id TEXT NOT NULL,
          douban_id TEXT NOT NULL,
          added_at TEXT,
          remark TEXT,
          imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(doulist_id, douban_id)
        )
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_doulist_items_doulist ON qc_doulist_import_items(doulist_id)
      `);
      this.qcBooklogDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_doulist_items_douban ON qc_doulist_import_items(douban_id)
      `);
      // 旧库列迁移：加入书架状态 + 书单分类（买书/读书）
      try {
        const bookCols = this.qcBooklogDb.prepare('PRAGMA table_info(qc_doulist_books)').all().map((c) => c.name);
        if (!bookCols.includes('shelf_status')) {
          this.qcBooklogDb.exec("ALTER TABLE qc_doulist_books ADD COLUMN shelf_status TEXT DEFAULT 'pending'");
        }
        if (!bookCols.includes('shelved_at')) {
          this.qcBooklogDb.exec('ALTER TABLE qc_doulist_books ADD COLUMN shelved_at DATETIME');
        }
        const importCols = this.qcBooklogDb.prepare('PRAGMA table_info(qc_doulist_imports)').all().map((c) => c.name);
        // 旧分类字段 category（buy/read 单选）已废弃，改为 is_buy/is_read 双标志
        let importMigrated = false;
        if (!importCols.includes('is_buy')) {
          this.qcBooklogDb.exec('ALTER TABLE qc_doulist_imports ADD COLUMN is_buy INTEGER DEFAULT 1');
          importMigrated = true;
        }
        if (!importCols.includes('is_read')) {
          this.qcBooklogDb.exec('ALTER TABLE qc_doulist_imports ADD COLUMN is_read INTEGER DEFAULT 0');
          importMigrated = true;
        }
        // 一次性回填：按旧 category 值初始化双标志
        if (importMigrated && importCols.includes('category')) {
          this.qcBooklogDb.exec(`
            UPDATE qc_doulist_imports SET
              is_buy = CASE WHEN category = 'read' THEN 0 ELSE 1 END,
              is_read = CASE WHEN category = 'read' THEN 1 ELSE 0 END
            WHERE is_buy = 1 AND is_read = 0
          `);
        }
        if (!bookCols.includes('read_status')) {
          this.qcBooklogDb.exec("ALTER TABLE qc_doulist_books ADD COLUMN read_status TEXT DEFAULT 'unread'");
        }
      } catch (e) {
        console.warn('⚠️ 豆列表旧库列迁移失败:', e.message);
      }
      console.log('  ✅ 豆列书单表创建成功');

      // 初始化默认书源配置
      this.initDefaultBookSourceSettings();

      console.log('✅ QCBookLog 数据库表结构创建完成');
    } catch (error) {
      console.error('❌ 创建 QCBookLog 数据库表结构失败:', error.message);
      throw error;
    }
  }

  /**
   * 初始化默认书源设置
   * 仅插入记录，API Key 由用户在前端配置，不与环境变量同步
   */
  initDefaultBookSourceSettings() {
    if (!this.qcBooklogDb) return;

    const defaultSources = [
      {
        source_key: 'tanshu',
        source_name: '探数图书',
        is_required: 1,
        description: '探数图书 ISBN 查询 API，计费接口，填写后可在搜索结果中显示',
        sort_order: 1
      },
      {
        source_key: 'douban',
        source_name: '豆瓣图书',
        is_required: 1,
        description: '豆瓣图书 API（v2），需要 apikey，用于查询图书元数据和封面',
        sort_order: 2
      },
      {
        source_key: 'isbnWork',
        source_name: '公共图书',
        is_required: 1,
        description: 'ISBN 公共图书 API（data.isbn.work），需要 appKey',
        sort_order: 3
      }
    ];

    try {
      const insertStmt = this.qcBooklogDb.prepare(`
        INSERT OR IGNORE INTO qc_book_source_settings
        (source_key, source_name, api_key, is_required, description, sort_order, created_at, updated_at)
        VALUES (?, ?, '', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      const transaction = this.qcBooklogDb.transaction(() => {
        for (const source of defaultSources) {
          insertStmt.run(
            source.source_key,
            source.source_name,
            source.is_required,
            source.description,
            source.sort_order
          );
        }
      });

      transaction();
      console.log('  ✅ 书源默认设置初始化完成');
    } catch (error) {
      console.warn('  ⚠️ 初始化书源默认设置失败:', error.message);
    }
  }

  /**
   * 确保 qc_book_mapping 表有 library_uuid 字段（兼容旧数据库）
   */
  ensureLibraryUuidColumn() {
    if (!this.qcBooklogDb) {
      return;
    }

    try {
      const columns = this.qcBooklogDb.prepare("PRAGMA table_info(qc_book_mapping)").all();
      const columnNames = columns.map(col => col.name);

      if (!columnNames.includes('library_uuid')) {
        console.log('📝 检测到旧版 qc_book_mapping 表结构，开始迁移...');

        this.qcBooklogDb.pragma('foreign_keys = OFF');

        const existingData = this.qcBooklogDb.prepare('SELECT * FROM qc_book_mapping').all();

        this.qcBooklogDb.exec(`
          CREATE TABLE IF NOT EXISTS qc_book_mapping_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_uuid TEXT NOT NULL DEFAULT '',
            calibre_book_id INTEGER NOT NULL,
            talebook_book_id INTEGER,
            title TEXT,
            author TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(library_uuid, calibre_book_id)
          )
        `);

        const insertStmt = this.qcBooklogDb.prepare(`
          INSERT INTO qc_book_mapping_new (id, library_uuid, calibre_book_id, talebook_book_id, created_at, updated_at)
          VALUES (?, '', ?, ?, ?, ?)
        `);

        const migrateTransaction = this.qcBooklogDb.transaction(() => {
          for (const row of existingData) {
            insertStmt.run(
              row.id,
              row.calibre_book_id,
              row.talebook_book_id || row.calibre_book_id,
              row.created_at,
              row.updated_at
            );
          }
        });

        migrateTransaction();

        this.qcBooklogDb.exec(`
          DROP TABLE qc_book_mapping;
          ALTER TABLE qc_book_mapping_new RENAME TO qc_book_mapping;
        `);

        this.qcBooklogDb.exec(`
          CREATE INDEX IF NOT EXISTS idx_mapping_library ON qc_book_mapping(library_uuid);
          CREATE INDEX IF NOT EXISTS idx_mapping_calibre ON qc_book_mapping(calibre_book_id);
          CREATE INDEX IF NOT EXISTS idx_mapping_library_calibre ON qc_book_mapping(library_uuid, calibre_book_id);
        `);

        this.qcBooklogDb.pragma('foreign_keys = ON');

        console.log('✅ qc_book_mapping 表迁移完成，已添加 library_uuid 字段');
      }
    } catch (error) {
      console.warn('⚠️ 检查/迁移 qc_book_mapping 表时出错:', error.message);
    }
  }

  /**
   * 获取 Calibre 数据库实例
   */
  getCalibreDb() {
    return this.calibreDb;
  }

  /**
   * 获取 Talebook 数据库实例
   */
  getTalebookDb() {
    return this.talebookDb;
  }

  /**
   * 获取 QCBookLog 数据库实例
   */
  getQcBooklogDb() {
    return this.qcBooklogDb;
  }

  /**
   * 检查 Calibre 数据库是否可用
   */
  isCalibreAvailable() {
    return this.calibreDb !== null;
  }

  /**
   * 检查 Talebook 数据库是否可用
   */
  isTalebookAvailable() {
    return this.talebookDb !== null;
  }

  /**
   * 检查 QCBookLog 数据库是否可用
   */
  isQcBooklogAvailable() {
    return this.qcBooklogDb !== null;
  }

  getCalibreError() {
    return this.calibreError;
  }

  getTalebookError() {
    return this.talebookError;
  }

  getQcBooklogError() {
    return this.qcBooklogError;
  }

  /**
   * 重新加载配置
   */
  reloadConfig() {
    this.config = this.loadConfig();
    console.log('🔄 配置已重新加载');
  }

  /**
   * 重新连接数据库（当路径变化时）
   */
  async reconnect() {
    this.reloadConfig();
    
    this.calibreError = null;
    this.talebookError = null;
    this.qcBooklogError = null;
    // 路径可能变化，清空可用性缓存强制重新探测
    this._talebookUsable = null;
    
    if (this.calibreDb) {
      this.calibreDb.close();
      this.calibreDb = null;
    }
    if (this.talebookDb) {
      this.talebookDb.close();
      this.talebookDb = null;
    }
    if (this.qcBooklogDb) {
      this.qcBooklogDb.close();
      this.qcBooklogDb = null;
    }

    await this.init();
  }

  close() {
    if (this.calibreDb) {
      this.calibreDb.close();
      this.calibreDb = null;
    }
    if (this.talebookDb) {
      this.talebookDb.close();
      this.talebookDb = null;
    }
    if (this.qcBooklogDb) {
      this.qcBooklogDb.close();
      this.qcBooklogDb = null;
    }
    this.calibreError = null;
    this.talebookError = null;
    this.qcBooklogError = null;
    this._talebookUsable = null;
  }

  async createNewCalibreDatabase(dbPath, libraryName = 'My Library') {
    console.log('📝 开始创建新的 Calibre 数据库...');
    console.log('  数据库路径:', dbPath);
    console.log('  书库名称:', libraryName);

    if (!Database) {
      throw new Error('better-sqlite3 未安装，无法创建数据库');
    }

    const dbDir = path.dirname(dbPath);
    if (!fsSync.existsSync(dbDir)) {
      console.log('📂 创建数据库目录:', dbDir);
      fsSync.mkdirSync(dbDir, { recursive: true });
    }

    if (fsSync.existsSync(dbPath)) {
      throw new Error('数据库文件已存在: ' + dbPath);
    }

    let newDb = null;
    try {
      newDb = new Database(dbPath);
      newDb.pragma('journal_mode = WAL');
      newDb.pragma('foreign_keys = ON');

      console.log('📋 创建 Calibre 标准表结构...');
      this.createCalibreTables(newDb);

      const libraryUuid = crypto.randomUUID();
      console.log('🔑 生成 library_uuid:', libraryUuid);

      this.insertLibraryUuid(newDb, libraryUuid);

      this.insertDefaultPreferences(newDb, libraryName);

      newDb.close();
      newDb = null;

      console.log('✅ 新 Calibre 数据库创建成功:', dbPath);

      return {
        success: true,
        path: dbPath,
        libraryUuid: libraryUuid,
        message: 'Calibre 数据库创建成功'
      };
    } catch (error) {
      console.error('❌ 创建 Calibre 数据库失败:', error.message);
      if (newDb) {
        try {
          newDb.close();
        } catch (e) {
          // ignore
        }
      }
      if (fsSync.existsSync(dbPath)) {
        try {
          fsSync.unlinkSync(dbPath);
        } catch (e) {
          // ignore
        }
      }
      throw error;
    }
  }

  createCalibreTables(db) {
    console.log('  📝 创建 books 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        sort TEXT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        pubdate TEXT,
        series_index REAL DEFAULT 1.0,
        author_sort TEXT,
        isbn TEXT,
        lccn TEXT,
        path TEXT,
        uuid TEXT,
        has_cover INTEGER DEFAULT 0,
        last_modified TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('  📝 创建 authors 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort TEXT
      )
    `);

    console.log('  📝 创建 books_authors_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_authors_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        author INTEGER NOT NULL,
        UNIQUE(book, author)
      )
    `);

    console.log('  📝 创建 publishers 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS publishers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    console.log('  📝 创建 books_publishers_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_publishers_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        publisher INTEGER NOT NULL,
        UNIQUE(book, publisher)
      )
    `);

    console.log('  📝 创建 tags 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    console.log('  📝 创建 books_tags_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_tags_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        tag INTEGER NOT NULL,
        UNIQUE(book, tag)
      )
    `);

    console.log('  📝 创建 series 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    console.log('  📝 创建 books_series_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_series_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        series INTEGER NOT NULL,
        UNIQUE(book, series)
      )
    `);

    console.log('  📝 创建 ratings 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rating INTEGER NOT NULL CHECK(rating >= 0 AND rating <= 10)
      )
    `);

    console.log('  📝 创建 books_ratings_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_ratings_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        rating INTEGER NOT NULL,
        UNIQUE(book, rating)
      )
    `);

    console.log('  📝 创建 languages 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS languages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lang_code TEXT NOT NULL UNIQUE
      )
    `);

    console.log('  📝 创建 books_languages_link 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS books_languages_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        lang_code INTEGER NOT NULL,
        item_order INTEGER DEFAULT 1,
        UNIQUE(book, lang_code)
      )
    `);

    console.log('  📝 创建 identifiers 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS identifiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        type TEXT NOT NULL,
        val TEXT NOT NULL,
        UNIQUE(book, type, val)
      )
    `);

    console.log('  📝 创建 comments 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        text TEXT
      )
    `);

    console.log('  📝 创建 data 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book INTEGER NOT NULL,
        format TEXT NOT NULL,
        uncompressed_size INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        UNIQUE(book, format)
      )
    `);

    console.log('  📝 创建 library_id 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_id (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE
      )
    `);

    console.log('  📝 创建 preferences 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        val TEXT
      )
    `);

    console.log('  📝 创建 custom_columns 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        datatype TEXT NOT NULL,
        is_multiple INTEGER DEFAULT 0,
        is_editable INTEGER DEFAULT 1,
        display TEXT,
        normalized INTEGER DEFAULT 0
      )
    `);

    console.log('  📝 创建索引...');
    db.exec(`CREATE INDEX IF NOT EXISTS books_authors_link_aidx ON books_authors_link (author)`);
    db.exec(`CREATE INDEX IF NOT EXISTS books_publishers_link_aidx ON books_publishers_link (publisher)`);
    db.exec(`CREATE INDEX IF NOT EXISTS books_ratings_link_aidx ON books_ratings_link (rating)`);
    db.exec(`CREATE INDEX IF NOT EXISTS books_series_link_aidx ON books_series_link (series)`);
    db.exec(`CREATE INDEX IF NOT EXISTS books_tags_link_aidx ON books_tags_link (tag)`);
    db.exec(`CREATE INDEX IF NOT EXISTS books_languages_link_aidx ON books_languages_link (lang_code)`);
    db.exec(`CREATE INDEX IF NOT EXISTS identifiers_idx ON identifiers (book)`);
    db.exec(`CREATE INDEX IF NOT EXISTS comments_idx ON comments (book)`);
    db.exec(`CREATE INDEX IF NOT EXISTS data_idx ON data (book)`);

    console.log('  ✅ Calibre 表结构创建完成');
  }

  insertLibraryUuid(db, libraryUuid) {
    try {
      db.prepare(`INSERT INTO library_id (uuid) VALUES (?)`).run(libraryUuid);
      console.log('  ✅ library_uuid 已插入到 library_id 表');
    } catch (error) {
      console.warn('  ⚠️ 插入 library_id 失败，尝试使用 preferences 表:', error.message);
      try {
        db.prepare(`INSERT INTO preferences (key, val) VALUES ('library_uuid', ?)`).run(libraryUuid);
        console.log('  ✅ library_uuid 已插入到 preferences 表');
      } catch (e) {
        console.warn('  ⚠️ 插入 preferences 也失败:', e.message);
      }
    }
  }

  insertDefaultPreferences(db, libraryName) {
    const defaultPreferences = [
      ['library_uuid', crypto.randomUUID()],
      ['installation_uuid', crypto.randomUUID()],
      ['library_name', libraryName],
      ['calibre_version', '7.0.0'],
      ['default_language', 'zh'],
      ['output_format', 'EPUB'],
      ['input_format_order', 'EPUB, AZW3, MOBI, PDF'],
      ['use_primary_find_in_search', 'True'],
      ['limit_search_columns', 'True'],
      ['use_virtual_library_on_search', 'True']
    ];

    const insertStmt = db.prepare(`INSERT OR IGNORE INTO preferences (key, val) VALUES (?, ?)`);
    const insertMany = db.transaction((prefs) => {
      for (const [key, val] of prefs) {
        insertStmt.run(key, val);
      }
    });

    try {
      insertMany(defaultPreferences);
      console.log('  ✅ 默认配置已插入');
    } catch (error) {
      console.warn('  ⚠️ 插入默认配置失败:', error.message);
    }
  }

  async createNewTalebookDatabase(dbPath) {
    console.log('📝 开始创建新的 Talebook 数据库...');
    console.log('  数据库路径:', dbPath);

    if (!Database) {
      throw new Error('better-sqlite3 未安装，无法创建数据库');
    }

    const dbDir = path.dirname(dbPath);
    if (!fsSync.existsSync(dbDir)) {
      console.log('📂 创建数据库目录:', dbDir);
      fsSync.mkdirSync(dbDir, { recursive: true });
    }

    if (fsSync.existsSync(dbPath)) {
      throw new Error('数据库文件已存在: ' + dbPath);
    }

    let newDb = null;
    try {
      newDb = new Database(dbPath);
      newDb.pragma('journal_mode = WAL');
      newDb.pragma('foreign_keys = ON');

      console.log('📋 创建 Talebook 标准表结构...');
      this.createTalebookTables(newDb);

      newDb.close();
      newDb = null;

      console.log('✅ 新 Talebook 数据库创建成功:', dbPath);

      return {
        success: true,
        path: dbPath,
        message: 'Talebook 数据库创建成功'
      };
    } catch (error) {
      console.error('❌ 创建 Talebook 数据库失败:', error.message);
      if (newDb) {
        try {
          newDb.close();
        } catch (e) {
          // ignore
        }
      }
      if (fsSync.existsSync(dbPath)) {
        try {
          fsSync.unlinkSync(dbPath);
        } catch (e) {
          // ignore
        }
      }
      throw error;
    }
  }

  createTalebookTables(db) {
    console.log('  📝 创建 readers 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS readers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(256),
        password VARCHAR(256),
        salt VARCHAR(256),
        name VARCHAR(256),
        email VARCHAR(256),
        admin BOOLEAN DEFAULT 0,
        active BOOLEAN DEFAULT 1,
        permission TEXT,
        extra TEXT DEFAULT '{}',
        extra_data TEXT,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('  📝 创建 items 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        book_id INTEGER NOT NULL PRIMARY KEY,
        count_guest INTEGER NOT NULL DEFAULT 0,
        count_visit INTEGER NOT NULL DEFAULT 0,
        count_download INTEGER NOT NULL DEFAULT 0,
        website VARCHAR(255) NOT NULL DEFAULT '',
        collector_id INTEGER,
        sole BOOLEAN NOT NULL DEFAULT 0,
        book_type INTEGER NOT NULL DEFAULT 1,
        book_count INTEGER NOT NULL DEFAULT 0,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('  📝 创建 reading_state 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS reading_state (
        book_id INTEGER NOT NULL,
        reader_id INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER DEFAULT 0,
        favorite_date TEXT,
        wants INTEGER DEFAULT 0,
        wants_date TEXT,
        read_state INTEGER DEFAULT 0,
        read_date TEXT,
        online_read INTEGER DEFAULT 0,
        download INTEGER DEFAULT 0,
        PRIMARY KEY (book_id, reader_id)
      )
    `);

    console.log('  📝 创建 qc_bookdata 表...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_bookdata (
        book_id INTEGER PRIMARY KEY,
        page_count INTEGER DEFAULT 0,
        standard_price REAL DEFAULT 0,
        purchase_price REAL DEFAULT 0,
        purchase_date TEXT,
        binding1 INTEGER DEFAULT 0,
        binding2 INTEGER DEFAULT 0,
        paper1 INTEGER DEFAULT 0,
        edge1 INTEGER DEFAULT 0,
        edge2 INTEGER DEFAULT 0,
        note TEXT,
        book_type INTEGER DEFAULT 1,
        total_reading_time INTEGER DEFAULT 0,
        read_pages INTEGER DEFAULT 0,
        reading_count INTEGER DEFAULT 0,
        last_read_date DATE DEFAULT NULL,
        last_read_duration INTEGER DEFAULT 0
      )
    `);

    console.log('  📝 创建索引...');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reading_state_book ON reading_state(book_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reading_state_reader ON reading_state(reader_id)`);

    console.log('  📝 插入默认读者...');
    try {
      db.prepare(`
        INSERT INTO readers (id, username, password, salt, name, email, admin, active, permission, extra, create_time, update_time)
        VALUES (0, 'default', '', '', 'Default Reader', '', 0, 1, '', '{}', datetime('now'), datetime('now'))
      `).run();
      console.log('  ✅ 默认读者已创建 (id=0)');
    } catch (error) {
      console.warn('  ⚠️ 创建默认读者失败:', error.message);
    }

    console.log('  ✅ Talebook 表结构创建完成');
  }
}

export default DatabaseConnectionManager;
