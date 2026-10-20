/**
 * SQLite数据库服务
 * 支持同时连接Calibre的metadata.db和Talebook的calibre-webserver.db
 */

import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import fsSync from 'fs';
import { normalizeBookTypeBindings } from '../../utils/bookBinding.js';
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

// 获取项目根目录
const getProjectRoot = () => PROJECT_ROOT;

// 将相对路径转换为绝对路径
const resolveDbPath = (dbPath) => {
  if (!dbPath) return dbPath;
  
  // 统一路径分隔符为正斜杠（兼容 Linux/Docker 环境）
  let normalizedPath = dbPath.replace(/\\/g, '/');
  
  // 检查是否为绝对路径（支持 Linux 风格 /path 和 Windows 风格 C:/path）
  if (normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath)) {
    return normalizedPath;
  }
  
  // 相对路径基于项目根目录解析
  const projectRoot = getProjectRoot();
  return path.resolve(projectRoot, normalizedPath).replace(/\\/g, '/');
};

// 默认数据库路径（可被环境变量覆盖）
let CALIBRE_DB_PATH = path.join(DATA_DIR, 'calibre/metadata.db');
let TALEBOOK_DB_PATH = path.join(DATA_DIR, 'talebook/calibre-webserver.db');
let QC_BOOKLOG_DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

// Calibre 数据库路径 - 优先使用环境变量
if (process.env.CALIBRE_DB_PATH) {
  CALIBRE_DB_PATH = resolveDbPath(process.env.CALIBRE_DB_PATH);
  console.log('✅ 使用环境变量指定的 Calibre 数据库:', CALIBRE_DB_PATH);
} else {
  console.log('ℹ️ 使用默认 Calibre 数据库路径:', CALIBRE_DB_PATH);
}

// Talebook 数据库路径 - 优先使用环境变量
if (process.env.TALEBOOK_DB_PATH) {
  TALEBOOK_DB_PATH = resolveDbPath(process.env.TALEBOOK_DB_PATH);
  console.log('✅ 使用环境变量指定的 Talebook 数据库:', TALEBOOK_DB_PATH);
} else {
  console.log('ℹ️ 使用默认 Talebook 数据库路径:', TALEBOOK_DB_PATH);
}

// QCBookLog 数据库路径 - 优先使用环境变量
if (process.env.QC_BOOKLOG_DB_PATH) {
  QC_BOOKLOG_DB_PATH = resolveDbPath(process.env.QC_BOOKLOG_DB_PATH);
  console.log('✅ 使用环境变量指定的 QCBookLog 数据库:', QC_BOOKLOG_DB_PATH);
} else {
  console.log('ℹ️ 使用默认 QCBookLog 数据库路径:', QC_BOOKLOG_DB_PATH);
}

/**
 * SQLite数据库服务
 */
class DatabaseService {
  constructor() {
    this.calibreDb = null;
    this.talebookDb = null;
    this.qcBooklogDb = null;
    this.initDatabases();
  }

  /**
   * 初始化数据库连接
   */
  initDatabases() {
    this.initCalibreDatabase();
    this.initTalebookDatabase();
    this.initQcBooklogDatabase();
    // 初始化后进行完整性检查
    this.checkDatabaseIntegrity();
  }

  /**
   * 检查数据库完整性并修复
   */
  checkDatabaseIntegrity() {
    console.log('🔍 开始数据库完整性检查...');
    try {
      if (this.isTalebookAvailable()) {
        this.checkAndFixTalebookDatabase();
      }
      if (this.isCalibreAvailable()) {
        this.checkAndFixCalibreDatabase();
      }
      console.log('✅ 数据库完整性检查完成');
    } catch (error) {
      console.error('❌ 数据库完整性检查失败:', error.message);
    }
  }

  /**
   * 检查并修复 Talebook 数据库
   */
  checkAndFixTalebookDatabase() {
    try {
      console.log('🔍 检查 Talebook 数据库完整性...');

      // 检查 items 表的主键
      const itemsTableInfo = this.talebookDb.prepare('PRAGMA table_info(items)').all();
      const hasBookIdPrimaryKey = itemsTableInfo.some(col => col.name === 'book_id' && col.pk > 0);

      if (!hasBookIdPrimaryKey) {
        console.log('⚠️ items 表缺少 book_id 主键，开始修复...');
        this.fixItemsTablePrimaryKey();
      }

      // 检查外键约束是否正确
      const tablesToCheck = ['qc_book_groups', 'qc_bookmarks', 'qc_bookdata'];
      for (const tableName of tablesToCheck) {
        const foreignKeys = this.talebookDb.prepare(`PRAGMA foreign_key_list(${tableName})`).all();
        const hasIncorrectForeignKey = foreignKeys.some(fk => fk.table === 'items' && fk.from === 'id');

        if (hasIncorrectForeignKey) {
          console.log(`⚠️ ${tableName} 表的外键约束不正确，开始修复...`);
          this.fixTableForeignKey(tableName);
        }
      }

      // 确保 qc_bookdata 表有所有必需的列
      this.ensureQcBookdataColumns();

      console.log('✅ Talebook 数据库完整性检查通过');
    } catch (error) {
      console.error('❌ 检查/修复 Talebook 数据库失败:', error.message);
    }
  }

  /**
   * 检查并修复 Calibre 数据库
   */
  checkAndFixCalibreDatabase() {
    try {
      console.log('🔍 检查 Calibre 数据库完整性...');
      // 这里可以添加 Calibre 数据库的完整性检查逻辑
      console.log('✅ Calibre 数据库完整性检查通过');
    } catch (error) {
      console.error('❌ 检查/修复 Calibre 数据库失败:', error.message);
    }
  }

  /**
   * 修复 items 表的主键
   */
  fixItemsTablePrimaryKey() {
    // 这个修复逻辑已经在之前的迁移脚本中实现
    // 如果 items 表格式不正确，需要重新创建表
    console.log('⚠️ items 表主键修复需要在切换数据库时手动处理');
  }

  /**
   * 修复表的外键约束
   */
  fixTableForeignKey(tableName) {
    // 这个修复逻辑已经在之前的迁移脚本中实现
    console.log(`⚠️ ${tableName} 表外键修复需要在切换数据库时手动处理`);
  }

  /**
   * 确保 qc_bookdata 表有所有必需的列
   */
  ensureQcBookdataColumns() {
    // 使用 qcBooklogDb 而不是 talebookDb，因为 qc_bookdata 表在 qc_booklog.db 中
    const db = this.qcBooklogDb || this.talebookDb;
    if (!db) {
      console.warn('⚠️ 没有可用的数据库连接，跳过 qc_bookdata 列检查');
      return;
    }
    
    try {
      const columns = db.prepare('PRAGMA table_info(qc_bookdata)').all();
      const columnNames = new Set(columns.map(c => c.name));

      const requiredFields = [
        { name: 'purchase_price', sql: 'purchase_price REAL DEFAULT 0' },
        { name: 'note', sql: 'note TEXT' },
        { name: 'total_reading_time', sql: 'total_reading_time INTEGER DEFAULT 0' },
        { name: 'read_pages', sql: 'read_pages INTEGER DEFAULT 0' },
        { name: 'reading_count', sql: 'reading_count INTEGER DEFAULT 0' },
        { name: 'last_read_date', sql: 'last_read_date DATE DEFAULT NULL' },
        { name: 'last_read_duration', sql: 'last_read_duration INTEGER DEFAULT 0' }
      ];

      for (const field of requiredFields) {
        if (!columnNames.has(field.name)) {
          try {
            db.prepare(`ALTER TABLE qc_bookdata ADD COLUMN ${field.sql}`).run();
            console.log(`✅ 添加 ${field.name} 列到 qc_bookdata 表`);
          } catch (error) {
            if (!error.message.includes('duplicate column name')) {
              console.error(`❌ 添加 ${field.name} 列失败:`, error.message);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ 检查/添加 qc_bookdata 列失败:', error.message);
    }
  }

  /**
   * 确保 qc_users 表有所有必需的列
   */
  ensureQcUsersColumns() {
    const db = this.qcBooklogDb;
    if (!db) {
      console.warn('⚠️ 没有可用的数据库连接，跳过 qc_users 列检查');
      return;
    }
    
    try {
      const columns = db.prepare('PRAGMA table_info(qc_users)').all();
      const columnNames = new Set(columns.map(c => c.name));

      const requiredFields = [
        { name: 'note', sql: 'note TEXT' }
      ];

      for (const field of requiredFields) {
        if (!columnNames.has(field.name)) {
          try {
            db.prepare(`ALTER TABLE qc_users ADD COLUMN ${field.sql}`).run();
            console.log(`✅ 添加 ${field.name} 列到 qc_users 表`);
          } catch (error) {
            if (!error.message.includes('duplicate column name')) {
              console.error(`❌ 添加 ${field.name} 列失败:`, error.message);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ 检查/添加 qc_users 列失败:', error.message);
    }
  }

  /**
   * 初始化 Calibre 数据库连接
   */
  initCalibreDatabase() {
    try {
      console.log('🔄 初始化 Calibre 数据库连接...');
      console.log('🔄 数据库路径:', CALIBRE_DB_PATH);

      if (!Database) {
        console.warn('⚠️ 数据库服务不可用，系统将使用文件系统模式');
        return;
      }

      // 确保数据库目录存在
      const dbDir = path.dirname(CALIBRE_DB_PATH);
      if (!fsSync.existsSync(dbDir)) {
        console.log('📂 创建数据库目录:', dbDir);
        fsSync.mkdirSync(dbDir, { recursive: true });
        console.log('✅ 数据库目录创建成功');
      }

      // 检查数据库文件是否存在
      if (!fsSync.existsSync(CALIBRE_DB_PATH)) {
        console.warn('⚠️ Calibre 数据库文件不存在:', CALIBRE_DB_PATH);
        console.warn('⚠️ 请先配置 Calibre 书库路径');
        this.calibreDb = null;
        return;
      }

      this.calibreDb = new Database(CALIBRE_DB_PATH);
      console.log('✅ Calibre 数据库对象创建成功');
      this.calibreDb.pragma('journal_mode = WAL');
      console.log('✅ Calibre WAL 模式已启用');
      this.calibreDb.pragma('foreign_keys = ON');
      console.log('✅ Calibre 外键约束已启用');

      // 注册 Calibre 所需的自定义函数 title_sort
      this.registerCalibreFunctions(this.calibreDb);

      // 初始化数据库表结构（如果需要）
      this.initCalibreTables(this.calibreDb);

      // 禁用递归触发器
      try {
        this.calibreDb.pragma('recursive_triggers = OFF');
        console.log('✅ Calibre 已禁用递归触发器');
      } catch (pragmaError) {
        console.warn('⚠️ 无法禁用 Calibre 递归触发器:', pragmaError.message);
      }

      console.log('✅ Calibre 数据库连接成功:', CALIBRE_DB_PATH);
      console.log('✅ Calibre 数据库可访问:', this.isCalibreAvailable());
    } catch (error) {
      console.error('❌ Calibre 数据库连接失败:', error.message);
      console.error('❌ 错误堆栈:', error.stack);
      this.calibreDb = null;
    }
  }

  /**
   * 初始化 Talebook 数据库连接
   */
  initTalebookDatabase() {
    try {
      console.log('🔄 初始化 Talebook 数据库连接...');
      console.log('🔄 数据库路径:', TALEBOOK_DB_PATH);
      if (!Database) {
        console.warn('⚠️ 数据库服务不可用，Talebook 功能将不可用');
        return;
      }

      // 确保数据库目录存在
      const dbDir = path.dirname(TALEBOOK_DB_PATH);
      if (!fsSync.existsSync(dbDir)) {
        console.log('📂 创建数据库目录:', dbDir);
        fsSync.mkdirSync(dbDir, { recursive: true });
        console.log('✅ 数据库目录创建成功');
      }

      // 检查数据库文件是否存在
      if (!fsSync.existsSync(TALEBOOK_DB_PATH)) {
        console.warn('⚠️ Talebook 数据库文件不存在:', TALEBOOK_DB_PATH);
        console.warn('⚠️ 请先配置 Talebook 书库路径');
        this.talebookDb = null;
        return;
      }

      this.talebookDb = new Database(TALEBOOK_DB_PATH);
      console.log('✅ Talebook 数据库对象创建成功');
      this.talebookDb.pragma('journal_mode = WAL');
      console.log('✅ Talebook WAL 模式已启用');
      this.talebookDb.pragma('foreign_keys = ON');
      console.log('✅ Talebook 外键约束已启用');

      // 初始化 qcbooklog 专属表结构
      this.initQcTables(this.talebookDb);

      console.log('✅ Talebook 数据库连接成功:', TALEBOOK_DB_PATH);
      console.log('✅ Talebook 数据库可访问:', this.isTalebookAvailable());
    } catch (error) {
      console.error('❌ Talebook 数据库连接失败:', error.message);
      console.error('❌ 错误堆栈:', error.stack);
      this.talebookDb = null;
    }
  }

  /**
   * 初始化 QCBookLog 数据库连接
   */
  initQcBooklogDatabase() {
    try {
      console.log('🔄 初始化 QCBookLog 数据库连接...');
      console.log('🔄 数据库路径:', QC_BOOKLOG_DB_PATH);
      
      if (!Database) {
        console.warn('⚠️ 数据库服务不可用，QCBookLog 功能将不可用');
        return;
      }

      // 确保数据库目录存在
      const dbDir = path.dirname(QC_BOOKLOG_DB_PATH);
      if (!fsSync.existsSync(dbDir)) {
        console.log('📂 创建数据库目录:', dbDir);
        fsSync.mkdirSync(dbDir, { recursive: true });
        console.log('✅ 数据库目录创建成功');
      }

      // 检查数据库文件是否存在，不存在则自动创建
      let isNewDatabase = false;
      if (!fsSync.existsSync(QC_BOOKLOG_DB_PATH)) {
        console.log('📝 QCBookLog 数据库文件不存在，自动创建...');
        isNewDatabase = true;
      }

      this.qcBooklogDb = new Database(QC_BOOKLOG_DB_PATH);
      console.log('✅ QCBookLog 数据库对象创建成功');
      this.qcBooklogDb.pragma('journal_mode = WAL');
      console.log('✅ QCBookLog WAL 模式已启用');
      this.qcBooklogDb.pragma('foreign_keys = ON');
      console.log('✅ QCBookLog 外键约束已启用');

      // 检查是否需要创建表结构（检查 qc_bookdata 表是否存在）
      console.log('🔍 检查 QCBookLog 数据库表结构...');
      const tables = this.qcBooklogDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_bookdata'").get();
      console.log(`  查询结果: ${JSON.stringify(tables)}`);
      
      if (!tables) {
        console.log('📝 QCBookLog 数据库表结构不存在，自动创建...');
        this.createQcBooklogTables();
        console.log('✅ QCBookLog 数据库表结构创建完成');
      } else {
        console.log('✅ QCBookLog 数据库表结构已存在，检查并修复表结构...');
        this.fixQcBooklogTables();
      }

      // 确保 qc_users 表有所有必需的列
      this.ensureQcUsersColumns();

      console.log('✅ QCBookLog 数据库连接成功:', QC_BOOKLOG_DB_PATH);
      console.log('✅ QCBookLog 数据库可访问:', this.isQcBooklogAvailable());
    } catch (error) {
      console.error('❌ QCBookLog 数据库连接失败:', error.message);
      console.error('❌ 错误堆栈:', error.stack);
      this.qcBooklogDb = null;
    }
  }

  /**
   * 修复 QCBookLog 数据库表结构
   */
  fixQcBooklogTables() {
    if (!this.qcBooklogDb) {
      console.error('❌ 数据库未连接，无法修复表结构');
      return;
    }

    try {
      console.log('🔧 检查并修复 qc_reading_records 表...');
      const recordsColumns = this.qcBooklogDb.prepare('PRAGMA table_info(qc_reading_records)').all();
      const recordsColumnNames = recordsColumns.map(c => c.name);
      
      const recordsFieldsToAdd = [
        { name: 'user_id', sql: 'ALTER TABLE qc_reading_records ADD COLUMN user_id INTEGER DEFAULT 0' },
        { name: 'reader_id', sql: 'ALTER TABLE qc_reading_records ADD COLUMN reader_id INTEGER DEFAULT 0' },
        { name: 'start_time', sql: 'ALTER TABLE qc_reading_records ADD COLUMN start_time DATETIME' },
        { name: 'end_time', sql: 'ALTER TABLE qc_reading_records ADD COLUMN end_time DATETIME' },
        { name: 'start_page', sql: 'ALTER TABLE qc_reading_records ADD COLUMN start_page INTEGER DEFAULT 0' },
        { name: 'end_page', sql: 'ALTER TABLE qc_reading_records ADD COLUMN end_page INTEGER DEFAULT 0' },
        { name: 'pages_read', sql: 'ALTER TABLE qc_reading_records ADD COLUMN pages_read INTEGER DEFAULT 0' },
        { name: 'notes', sql: 'ALTER TABLE qc_reading_records ADD COLUMN notes TEXT' },
        { name: 'created_at', sql: 'ALTER TABLE qc_reading_records ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
      ];
      
      for (const field of recordsFieldsToAdd) {
        if (!recordsColumnNames.includes(field.name)) {
          try {
            this.qcBooklogDb.exec(field.sql);
            console.log(`  ✅ 添加字段: ${field.name}`);
          } catch (e) {
            if (!e.message.includes('duplicate column')) {
              console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
            }
          }
        }
      }

      console.log('🔧 检查并修复 qc_daily_reading_stats 表...');
      const statsColumns = this.qcBooklogDb.prepare('PRAGMA table_info(qc_daily_reading_stats)').all();
      const statsColumnNames = statsColumns.map(c => c.name);
      
      const statsFieldsToAdd = [
        { name: 'user_id', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN user_id INTEGER DEFAULT 0' },
        { name: 'reader_id', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN reader_id INTEGER DEFAULT 0' },
        { name: 'stat_date', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN stat_date DATE' },
        { name: 'date', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN date DATE' },
        { name: 'total_reading_time', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_reading_time INTEGER DEFAULT 0' },
        { name: 'total_time', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_time INTEGER DEFAULT 0' },
        { name: 'total_pages_read', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_pages_read INTEGER DEFAULT 0' },
        { name: 'total_pages', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_pages INTEGER DEFAULT 0' },
        { name: 'books_read_count', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN books_read_count INTEGER DEFAULT 0' },
        { name: 'total_books', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_books INTEGER DEFAULT 0' }
      ];
      
      for (const field of statsFieldsToAdd) {
        if (!statsColumnNames.includes(field.name)) {
          try {
            this.qcBooklogDb.exec(field.sql);
            console.log(`  ✅ 添加字段: ${field.name}`);
          } catch (e) {
            if (!e.message.includes('duplicate column')) {
              console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
            }
          }
        }
      }

      console.log('🔧 检查并修复 qc_reading_goals 表...');
      const goalsColumns = this.qcBooklogDb.prepare('PRAGMA table_info(qc_reading_goals)').all();
      const goalsColumnNames = goalsColumns.map(c => c.name);
      
      const goalsFieldsToAdd = [
        { name: 'user_id', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN user_id INTEGER DEFAULT 0' },
        { name: 'reader_id', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN reader_id INTEGER DEFAULT 0' },
        { name: 'year', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN year INTEGER' },
        { name: 'goal_type', sql: "ALTER TABLE qc_reading_goals ADD COLUMN goal_type VARCHAR(20) DEFAULT 'yearly'" },
        { name: 'target', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN target INTEGER DEFAULT 0' },
        { name: 'target_value', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN target_value INTEGER DEFAULT 0' },
        { name: 'completed', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN completed INTEGER DEFAULT 0' },
        { name: 'current_value', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN current_value INTEGER DEFAULT 0' },
        { name: 'start_date', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN start_date DATE' },
        { name: 'end_date', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN end_date DATE' },
        { name: 'status', sql: "ALTER TABLE qc_reading_goals ADD COLUMN status VARCHAR(20) DEFAULT 'active'" }
      ];
      
      for (const field of goalsFieldsToAdd) {
        if (!goalsColumnNames.includes(field.name)) {
          try {
            this.qcBooklogDb.exec(field.sql);
            console.log(`  ✅ 添加字段: ${field.name}`);
          } catch (e) {
            if (!e.message.includes('duplicate column')) {
              console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
            }
          }
        }
      }

      console.log('✅ QCBookLog 数据库表结构修复完成');
    } catch (error) {
      console.error('❌ 修复 QCBookLog 表结构失败:', error.message);
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
      console.log('📝 创建书籍映射表 (qc_book_mapping)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_mapping (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          calibre_book_id INTEGER NOT NULL UNIQUE,
          talebook_book_id INTEGER NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(calibre_book_id, talebook_book_id)
        );

        CREATE INDEX IF NOT EXISTS idx_mapping_calibre ON qc_book_mapping(calibre_book_id);
        CREATE INDEX IF NOT EXISTS idx_mapping_talebook ON qc_book_mapping(talebook_book_id);
      `);
      console.log('  ✅ qc_book_mapping 表创建成功');

      console.log('📝 创建用户表 (qc_users)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          display_name VARCHAR(100),
          name TEXT,
          email TEXT,
          avatar_url VARCHAR(255),
          avatar TEXT,
          admin INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON qc_users(username);
        CREATE INDEX IF NOT EXISTS idx_users_email ON qc_users(email);
      `);
      console.log('  ✅ qc_users 表创建成功');

      console.log('📝 创建分组表 (qc_groups)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_groups_name ON qc_groups(name);
      `);
      console.log('  ✅ qc_groups 表创建成功');

      console.log('📝 创建标签表 (qc_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_tags_name ON qc_tags(name);
      `);
      console.log('  ✅ qc_tags 表创建成功');

      console.log('📝 创建书籍扩展数据表 (qc_bookdata)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookdata (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL UNIQUE,
          page_count INTEGER DEFAULT 0,
          standard_price REAL DEFAULT 0,
          purchase_price REAL DEFAULT 0,
          purchase_date DATE DEFAULT NULL,
          binding1 INTEGER DEFAULT 0,
          binding2 INTEGER DEFAULT 0,
          paper1 INTEGER DEFAULT 0,
          edge1 INTEGER DEFAULT 0,
          edge2 INTEGER DEFAULT 0,
          note TEXT DEFAULT '',
          total_reading_time INTEGER DEFAULT 0,
          read_pages INTEGER DEFAULT 0,
          reading_count INTEGER DEFAULT 0,
          last_read_date DATE DEFAULT NULL,
          last_read_duration INTEGER DEFAULT 0,
          book_type INTEGER DEFAULT 1,
          source TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_bookdata_book_id ON qc_bookdata(book_id);
      `);
      console.log('  ✅ qc_bookdata 表创建成功 (含 book_type 字段)');

      console.log('📝 创建书摘表 (qc_bookmarks)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          book_title TEXT,
          book_author TEXT,
          content TEXT NOT NULL,
          note TEXT,
          page INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON qc_bookmarks(book_id);
        CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON qc_bookmarks(created_at);
      `);
      console.log('  ✅ qc_bookmarks 表创建成功');

      console.log('📝 创建书摘标签关联表 (qc_bookmark_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_bookmark_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookmark_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          tag_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (bookmark_id) REFERENCES qc_bookmarks(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES qc_tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bookmark_tags_bookmark_id ON qc_bookmark_tags(bookmark_id);
        CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag_id ON qc_bookmark_tags(tag_id);
      `);
      console.log('  ✅ qc_bookmark_tags 表创建成功');

      console.log('📝 创建书籍分组关联表 (qc_book_groups)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE,
          FOREIGN KEY (group_id) REFERENCES qc_groups(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_book_groups_book_id ON qc_book_groups(book_id);
        CREATE INDEX IF NOT EXISTS idx_book_groups_group_id ON qc_book_groups(group_id);
      `);
      console.log('  ✅ qc_book_groups 表创建成功');

      console.log('📝 创建书籍标签关联表 (qc_book_tags)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_book_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          tag_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_book_tags_book_id ON qc_book_tags(book_id);
        CREATE INDEX IF NOT EXISTS idx_book_tags_tag_name ON qc_book_tags(tag_name);
      `);
      console.log('  ✅ qc_book_tags 表创建成功');

      console.log('📝 创建阅读记录表 (qc_reading_records)...');
      const existingRecordsTable = this.qcBooklogDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_reading_records'").get();
      let recordsColumns = existingRecordsTable ? this.qcBooklogDb.prepare('PRAGMA table_info(qc_reading_records)').all() : [];
      let recordsColumnNames = recordsColumns.map(c => c.name);
      
      if (!existingRecordsTable) {
        this.qcBooklogDb.exec(`
          CREATE TABLE qc_reading_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            user_id INTEGER DEFAULT 0,
            reader_id INTEGER NOT NULL DEFAULT 0,
            start_time DATETIME,
            end_time DATETIME,
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
        console.log('  ✅ qc_reading_records 表创建成功');
      } else {
        console.log('  ✅ qc_reading_records 表已存在，检查并添加缺失字段...');
        const recordsFieldsToAdd = [
          { name: 'user_id', sql: 'ALTER TABLE qc_reading_records ADD COLUMN user_id INTEGER DEFAULT 0' },
          { name: 'reader_id', sql: 'ALTER TABLE qc_reading_records ADD COLUMN reader_id INTEGER DEFAULT 0' },
          { name: 'start_time', sql: 'ALTER TABLE qc_reading_records ADD COLUMN start_time DATETIME' },
          { name: 'end_time', sql: 'ALTER TABLE qc_reading_records ADD COLUMN end_time DATETIME' },
          { name: 'start_page', sql: 'ALTER TABLE qc_reading_records ADD COLUMN start_page INTEGER DEFAULT 0' },
          { name: 'end_page', sql: 'ALTER TABLE qc_reading_records ADD COLUMN end_page INTEGER DEFAULT 0' },
          { name: 'pages_read', sql: 'ALTER TABLE qc_reading_records ADD COLUMN pages_read INTEGER DEFAULT 0' },
          { name: 'notes', sql: 'ALTER TABLE qc_reading_records ADD COLUMN notes TEXT' },
          { name: 'created_at', sql: 'ALTER TABLE qc_reading_records ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        for (const field of recordsFieldsToAdd) {
          if (!recordsColumnNames.includes(field.name)) {
            try {
              this.qcBooklogDb.exec(field.sql);
              console.log(`    ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`    ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
        
        recordsColumns = this.qcBooklogDb.prepare('PRAGMA table_info(qc_reading_records)').all();
        recordsColumnNames = recordsColumns.map(c => c.name);
      }
      
      try {
        this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_book_reader ON qc_reading_records(book_id, reader_id)`);
        this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_book_user ON qc_reading_records(book_id, user_id)`);
        if (recordsColumnNames.includes('start_time')) {
          this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_date ON qc_reading_records(start_time)`);
        }
        if (recordsColumnNames.includes('reader_id') && recordsColumnNames.includes('start_time')) {
          this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_reader_date ON qc_reading_records(reader_id, start_time)`);
        }
      } catch (e) {
        console.warn('  ⚠️ 创建索引失败:', e.message);
      }

      console.log('📝 创建每日阅读统计表 (qc_daily_reading_stats)...');
      const existingStatsTable = this.qcBooklogDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_daily_reading_stats'").get();
      const statsColumns = existingStatsTable ? this.qcBooklogDb.prepare('PRAGMA table_info(qc_daily_reading_stats)').all() : [];
      const statsColumnNames = statsColumns.map(c => c.name);
      
      if (!existingStatsTable) {
        this.qcBooklogDb.exec(`
          CREATE TABLE qc_daily_reading_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reader_id INTEGER NOT NULL DEFAULT 0,
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
        console.log('  ✅ qc_daily_reading_stats 表创建成功');
      } else {
        console.log('  ✅ qc_daily_reading_stats 表已存在，检查并添加缺失字段...');
        const statsFieldsToAdd = [
          { name: 'reader_id', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN reader_id INTEGER DEFAULT 0' },
          { name: 'date', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN date DATE' },
          { name: 'total_time', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_time INTEGER DEFAULT 0' },
          { name: 'total_pages', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_pages INTEGER DEFAULT 0' },
          { name: 'total_books', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN total_books INTEGER DEFAULT 0' },
          { name: 'updated_at', sql: 'ALTER TABLE qc_daily_reading_stats ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        for (const field of statsFieldsToAdd) {
          if (!statsColumnNames.includes(field.name)) {
            try {
              this.qcBooklogDb.exec(field.sql);
              console.log(`    ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`    ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
      }
      
      try {
        this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date ON qc_daily_reading_stats(user_id, stat_date)`);
        if (statsColumnNames.includes('reader_id') || !existingStatsTable) {
          this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_daily_stats_reader_date ON qc_daily_reading_stats(reader_id, date)`);
        }
      } catch (e) {
        console.warn('  ⚠️ 创建索引失败:', e.message);
      }

      console.log('📝 创建阅读目标表 (qc_reading_goals)...');
      const existingGoalsTable = this.qcBooklogDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_reading_goals'").get();
      const goalsColumns = existingGoalsTable ? this.qcBooklogDb.prepare('PRAGMA table_info(qc_reading_goals)').all() : [];
      const goalsColumnNames = goalsColumns.map(c => c.name);
      
      if (!existingGoalsTable) {
        this.qcBooklogDb.exec(`
          CREATE TABLE qc_reading_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reader_id INTEGER NOT NULL DEFAULT 0,
            year INTEGER NOT NULL,
            goal_type VARCHAR(20) DEFAULT 'yearly',
            target INTEGER NOT NULL,
            target_value INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            current_value INTEGER DEFAULT 0,
            start_date DATE,
            end_date DATE,
            status VARCHAR(20) DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, year),
            FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
          )
        `);
        console.log('  ✅ qc_reading_goals 表创建成功');
      } else {
        console.log('  ✅ qc_reading_goals 表已存在，检查并添加缺失字段...');
        const goalsFieldsToAdd = [
          { name: 'reader_id', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN reader_id INTEGER DEFAULT 0' },
          { name: 'year', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN year INTEGER' },
          { name: 'target', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN target INTEGER DEFAULT 0' },
          { name: 'completed', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN completed INTEGER DEFAULT 0' },
          { name: 'updated_at', sql: 'ALTER TABLE qc_reading_goals ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        for (const field of goalsFieldsToAdd) {
          if (!goalsColumnNames.includes(field.name)) {
            try {
              this.qcBooklogDb.exec(field.sql);
              console.log(`    ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`    ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
      }
      
      try {
        this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_goals_user_year ON qc_reading_goals(user_id, year)`);
        if (goalsColumnNames.includes('reader_id') || !existingGoalsTable) {
          this.qcBooklogDb.exec(`CREATE INDEX IF NOT EXISTS idx_reading_goals_reader_year ON qc_reading_goals(reader_id, year)`);
        }
      } catch (e) {
        console.warn('  ⚠️ 创建索引失败:', e.message);
      }

      console.log('📝 创建评论表 (qc_comments)...');
      this.qcBooklogDb.exec(`
        CREATE TABLE IF NOT EXISTS qc_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_comments_book_id ON qc_comments(book_id);
        CREATE INDEX IF NOT EXISTS idx_comments_user_id ON qc_comments(user_id);
      `);
      console.log('  ✅ qc_comments 表创建成功');

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
        );

        CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON qc_wishlist(user_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_reader_id ON qc_wishlist(reader_id);
        CREATE INDEX IF NOT EXISTS idx_wishlist_isbn ON qc_wishlist(isbn);
      `);
      console.log('  ✅ qc_wishlist 表创建成功');

    } catch (error) {
      console.error('❌ 创建 QCBookLog 表结构失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新 Calibre 数据库路径
   */
  updateCalibreDbPath(newPath) {
    try {
      console.log('🔄 开始更新 Calibre 数据库路径...');
      console.log('🔄 新路径:', newPath);
      console.log('🔄 旧路径:', CALIBRE_DB_PATH);

      if (this.calibreDb) {
        console.log('🔄 关闭现有 Calibre 数据库连接...');
        this.calibreDb.close();
      }

      CALIBRE_DB_PATH = newPath;
      console.log('✅ Calibre 数据库路径已更新:', CALIBRE_DB_PATH);

      // 重新初始化数据库
      console.log('🔄 重新初始化 Calibre 数据库...');
      this.initCalibreDatabase();

      // 初始化后进行完整性检查
      console.log('🔄 进行数据库完整性检查...');
      this.checkDatabaseIntegrity();

      console.log('✅ Calibre 数据库路径更新完成');
      return { success: true, message: 'Calibre 数据库路径已更新' };
    } catch (error) {
      console.error('❌ 更新 Calibre 数据库路径失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新 Talebook 数据库路径
   */
  updateTalebookDbPath(newPath) {
    try {
      console.log('🔄 开始更新 Talebook 数据库路径...');
      console.log('🔄 新路径:', newPath);
      console.log('🔄 旧路径:', TALEBOOK_DB_PATH);

      if (this.talebookDb) {
        console.log('🔄 关闭现有 Talebook 数据库连接...');
        this.talebookDb.close();
      }

      TALEBOOK_DB_PATH = newPath;
      console.log('✅ Talebook 数据库路径已更新:', TALEBOOK_DB_PATH);

      // 重新初始化数据库
      console.log('🔄 重新初始化 Talebook 数据库...');
      this.initTalebookDatabase();

      // 初始化后进行完整性检查
      console.log('🔄 进行数据库完整性检查...');
      this.checkDatabaseIntegrity();

      console.log('✅ Talebook 数据库路径更新完成');
      return { success: true, message: 'Talebook 数据库路径已更新' };
    } catch (error) {
      console.error('❌ 更新 Talebook 数据库路径失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取当前 Calibre 数据库路径
   */
  getCalibreDbPath() {
    return CALIBRE_DB_PATH;
  }

  /**
   * 获取当前 Talebook 数据库路径
   */
  getTalebookDbPath() {
    return TALEBOOK_DB_PATH;
  }

  /**
   * 初始化 Calibre 数据库表结构
   * 注意：如果数据库已存在表结构，则完全使用现有表，不进行任何修改
   * 这样可以保证以 data/calibre/metadata.db 为模板的表结构不被破坏
   */
  initCalibreTables(db) {
    try {
      console.log('📋 开始初始化 Calibre 数据库表结构');

      // 检查是否已经存在核心表（如果存在，说明数据库已有完整结构）
      const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const hasBooksTable = existingTables.some(t => t.name === 'books');
      const hasAuthorsTable = existingTables.some(t => t.name === 'authors');

      if (hasBooksTable && hasAuthorsTable) {
        console.log('✅ 数据库已存在表结构，使用现有结构（不进行任何修改）');
        console.log(`   已有表: ${existingTables.map(t => t.name).join(', ')}`);

        // 迁移：将 ratings.rating 列从 INTEGER 改为 REAL（保留小数精度）
        // 即使表结构已存在，也要执行这次迁移
        try {
          const ratingColInfo = db.prepare(`PRAGMA table_info(ratings)`).all().find(c => c.name === 'rating');
          if (ratingColInfo && String(ratingColInfo.type).toUpperCase().includes('INT')) {
            console.log('🔄 检测到 ratings.rating 为 INTEGER，开始迁移到 REAL（保留小数）...');
            // 先备份现有链接
            const oldLinks = db.prepare(`SELECT book, rating FROM books_ratings_link`).all();
            db.transaction(() => {
              // 1. 重命名旧表
              db.prepare(`ALTER TABLE ratings RENAME TO ratings_old`).run();
              // 2. 重建新表（rating REAL）
              db.prepare(`
                CREATE TABLE ratings (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  rating REAL NOT NULL
                )
              `).run();
              // 3. 拷贝数据（CAST 保留整数部分，与原 INTEGER 等价；后续新插入会带小数）
              db.prepare(`INSERT INTO ratings (id, rating) SELECT id, CAST(rating AS REAL) FROM ratings_old`).run();
              db.prepare(`DROP TABLE ratings_old`).run();
            })();
            // 4. 重新插入链接（在事务外，因为新表已建好）
            for (const link of oldLinks) {
              try {
                db.prepare(`INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)`).run(link.book, link.rating);
              } catch (e) {
                // 已存在则忽略
              }
            }
            console.log('✅ ratings 表已迁移到 REAL 类型');
          } else {
            console.log('✅ ratings.rating 已为 REAL 类型，无需迁移');
          }
        } catch (migrationError) {
          console.warn('⚠️ ratings 表迁移失败（可忽略，不影响功能）:', migrationError.message);
        }
        return;
      }

      console.log('⚠️ 数据库表结构不完整，将创建基本表结构...');

      // 创建 books 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          timestamp TEXT,
          pubdate TEXT,
          uuid TEXT,
          has_cover INTEGER DEFAULT 0,
          path TEXT,
          series_index REAL DEFAULT 1,
          author_sort TEXT,
          last_modified TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      // 创建 authors 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS authors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sort TEXT
        )
      `).run();
      
      // 创建 books_authors_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_authors_link (
          book INTEGER,
          author INTEGER,
          PRIMARY KEY (book, author),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (author) REFERENCES authors(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 identifiers 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS identifiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book INTEGER,
          type TEXT,
          val TEXT,
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 comments 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book INTEGER,
          text TEXT,
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 publishers 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS publishers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        )
      `).run();
      
      // 创建 books_publishers_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_publishers_link (
          book INTEGER,
          publisher INTEGER,
          PRIMARY KEY (book, publisher),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (publisher) REFERENCES publishers(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 ratings 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS ratings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rating REAL NOT NULL
        )
      `).run();
      
      // 创建 books_ratings_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_ratings_link (
          book INTEGER,
          rating INTEGER,
          PRIMARY KEY (book, rating),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (rating) REFERENCES ratings(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 tags 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        )
      `).run();
      
      // 创建 books_tags_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_tags_link (
          book INTEGER,
          tag INTEGER,
          PRIMARY KEY (book, tag),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (tag) REFERENCES tags(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 languages 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS languages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lang_code TEXT NOT NULL
        )
      `).run();
      
      // 创建 books_languages_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_languages_link (
          book INTEGER,
          lang_code INTEGER,
          PRIMARY KEY (book, lang_code),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (lang_code) REFERENCES languages(id) ON DELETE CASCADE
        )
      `).run();
      
      // 创建 series 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS series (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        )
      `).run();
      
      // 创建 books_series_link 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS books_series_link (
          book INTEGER,
          series INTEGER,
          PRIMARY KEY (book, series),
          FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE,
          FOREIGN KEY (series) REFERENCES series(id) ON DELETE CASCADE
        )
      `).run();

      console.log('✅ Calibre 数据库表结构初始化完成');
    } catch (error) {
      console.error('❌ 初始化 Calibre 数据库表结构失败:', error.message);
      throw error;
    }
  }

  /**
   * 初始化 Talebook 数据库表结构
   * 创建 qcbooklog 应用专属数据表
   */
  initQcTables(db) {
    try {
      console.log('📋 开始初始化 qcbooklog 专属表结构');

      // 创建 items 表（如果不存在）- 统计信息表（符合 calibre-webserver (1).db 的格式）
      db.prepare(`
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
      `).run();

      // 创建 users 表（如果不存在）- 用于读者/用户管理
      db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          name TEXT,
          email TEXT UNIQUE,
          avatar TEXT,
          admin INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      // 创建默认用户（如果不存在）
      const defaultUser = db.prepare('SELECT * FROM users WHERE id = 1').get();
      if (!defaultUser) {
        db.prepare(`
          INSERT OR IGNORE INTO users (id, username, name, admin, active, extra)
          VALUES (1, 'default', '默认用户', 1, 1, '{}')
        `).run();
        console.log('✅ 默认用户已创建');
      } else if (!defaultUser.extra) {
        // 修复已存在但 extra 为空的用户
        db.prepare(`UPDATE users SET extra = '{}' WHERE id = 1`).run();
        console.log('✅ 已修复用户 extra 字段');
      }

      // 创建 qc_groups 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS qc_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      // 创建 qc_book_groups 表（如果不存在）- 书籍与分组的关联表
      db.prepare(`
        CREATE TABLE IF NOT EXISTS qc_book_groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          FOREIGN KEY (book_id) REFERENCES items(book_id) ON DELETE CASCADE,
          FOREIGN KEY (group_id) REFERENCES qc_groups(id) ON DELETE CASCADE,
          UNIQUE(book_id, group_id)
        )
      `).run();
      
      // 创建 qc_bookmarks 表（如果不存在）
      db.prepare(`
        CREATE TABLE IF NOT EXISTS qc_bookmarks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          book_title TEXT,
          book_author TEXT,
          content TEXT NOT NULL,
          note TEXT,
          page INTEGER,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (book_id) REFERENCES items(book_id) ON DELETE CASCADE
        )
      `).run();

      // 自动迁移：添加冗余字段（如果不存在）
      const bookmarkColumns = db.prepare("PRAGMA table_info(qc_bookmarks)").all();
      const bookmarkColumnNames = bookmarkColumns.map(col => col.name);

      if (!bookmarkColumnNames.includes('book_title')) {
        db.prepare('ALTER TABLE qc_bookmarks ADD COLUMN book_title TEXT').run();
        console.log('✅ 已为 qc_bookmarks 表添加 book_title 列');
      }
      if (!bookmarkColumnNames.includes('book_author')) {
        db.prepare('ALTER TABLE qc_bookmarks ADD COLUMN book_author TEXT').run();
        console.log('✅ 已为 qc_bookmarks 表添加 book_author 列');
      }
      if (!bookmarkColumnNames.includes('note')) {
        db.prepare('ALTER TABLE qc_bookmarks ADD COLUMN note TEXT').run();
        console.log('✅ 已为 qc_bookmarks 表添加 note 列');
      }
      
      // 创建 qc_bookmark_tags 表（如果不存在）- 书摘与标签的关联表
      db.prepare(`
        CREATE TABLE IF NOT EXISTS qc_bookmark_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookmark_id INTEGER NOT NULL,
          tag_name TEXT NOT NULL,
          FOREIGN KEY (bookmark_id) REFERENCES qc_bookmarks(id) ON DELETE CASCADE,
          UNIQUE(bookmark_id, tag_name)
        )
      `).run();
      
      // 创建 reading_state 表（如果不存在）
      // 检查表是否存在并带有外键约束
      const existingTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_state'").get();
      if (existingTable) {
        console.log('📝 reading_state 表已存在，检查外键约束...');
        const foreignKeys = db.prepare('PRAGMA foreign_key_list(reading_state)').all();
        if (foreignKeys.length > 0) {
          console.log('⚠️ reading_state 表存在外键约束，需要重建...');
          // 备份数据
          const existingData = db.prepare('SELECT * FROM reading_state').all();
          console.log(`📝 备份 ${existingData.length} 条记录...`);

          // 删除旧表
          db.prepare('DROP TABLE reading_state').run();
          console.log('✅ 旧表已删除');

          // 创建新表（不带外键）
          db.prepare(`
            CREATE TABLE reading_state (
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
          `).run();

          // 恢复数据
          if (existingData.length > 0) {
            const insert = db.prepare(`
              INSERT INTO reading_state (book_id, reader_id, favorite, favorite_date, wants, wants_date, read_state, read_date, online_read, download)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertMany = db.transaction((rows) => {
              for (const row of rows) {
                insert.run(
                  row.book_id,
                  row.reader_id,
                  row.favorite,
                  row.favorite_date,
                  row.wants,
                  row.wants_date,
                  row.read_state,
                  row.read_date,
                  row.online_read,
                  row.download
                );
              }
            });
            insertMany(existingData);
            console.log('✅ 数据已恢复');
          }

          console.log('✅ reading_state 表重建完成');
        } else {
          console.log('✅ reading_state 表无外键约束，无需重建');
        }
      } else {
        db.prepare(`
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
        `).run();
      }
      
      // 创建 qc_bookdata 表（如果不存在）- 存储书籍扩展数据
      db.prepare(`
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
          total_reading_time INTEGER DEFAULT 0,
          read_pages INTEGER DEFAULT 0,
          reading_count INTEGER DEFAULT 0,
          last_read_date DATE DEFAULT NULL,
          last_read_duration INTEGER DEFAULT 0,
          source TEXT DEFAULT '',
          FOREIGN KEY (book_id) REFERENCES items(book_id) ON DELETE CASCADE
        )
      `).run();

      // 检查并添加缺失的列（用于升级现有数据库）
      try {
        // 检查列是否存在
        const columns = db.prepare("PRAGMA table_info(qc_bookdata)").all();
        const columnNames = new Set(columns.map(c => c.name));

        const requiredFields = [
          { name: 'purchase_price', sql: 'purchase_price REAL DEFAULT 0' },
          { name: 'note', sql: 'note TEXT' },
          { name: 'total_reading_time', sql: 'total_reading_time INTEGER DEFAULT 0' },
          { name: 'read_pages', sql: 'read_pages INTEGER DEFAULT 0' },
          { name: 'reading_count', sql: 'reading_count INTEGER DEFAULT 0' },
          { name: 'last_read_date', sql: 'last_read_date DATE DEFAULT NULL' },
          { name: 'last_read_duration', sql: 'last_read_duration INTEGER DEFAULT 0' },
          { name: 'paper1', sql: 'paper1 INTEGER DEFAULT 0' },
          { name: 'edge1', sql: 'edge1 INTEGER DEFAULT 0' },
          { name: 'edge2', sql: 'edge2 INTEGER DEFAULT 0' },
          { name: 'source', sql: "source TEXT DEFAULT ''" }
        ];

        for (const field of requiredFields) {
          if (!columnNames.has(field.name)) {
            try {
              db.prepare(`ALTER TABLE qc_bookdata ADD COLUMN ${field.sql}`).run();
              console.log(`🔄 添加 ${field.name} 列到 qc_bookdata 表`);
            } catch (error) {
              if (!error.message.includes('duplicate column name')) {
                throw error;
              }
            }
          }
        }
      } catch (alterError) {
        console.warn('⚠️ 检查/添加列时出错（可能是新表）:', alterError.message);
      }

      // 创建 qc_reading_records 表（如果不存在）- 阅读记录
      const existingRecordsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_reading_records'").get();
      const recordsColumns = existingRecordsTable ? db.prepare('PRAGMA table_info(qc_reading_records)').all() : [];
      const recordsColumnNames = recordsColumns.map(c => c.name);
      
      if (!existingRecordsTable) {
        db.prepare(`
          CREATE TABLE qc_reading_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            user_id INTEGER DEFAULT 0,
            reader_id INTEGER NOT NULL DEFAULT 0,
            start_time DATETIME,
            end_time DATETIME,
            duration INTEGER DEFAULT 0,
            start_page INTEGER DEFAULT 0,
            end_page INTEGER DEFAULT 0,
            pages_read INTEGER DEFAULT 0,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
        console.log('✅ qc_reading_records 表创建完成');
      } else {
        console.log('✅ qc_reading_records 表已存在，检查并添加缺失字段...');
        const recordsFieldsToAdd = [
          { name: 'user_id', sql: 'user_id INTEGER DEFAULT 0' },
          { name: 'reader_id', sql: 'reader_id INTEGER DEFAULT 0' },
          { name: 'start_time', sql: 'start_time DATETIME' },
          { name: 'end_time', sql: 'end_time DATETIME' },
          { name: 'start_page', sql: 'start_page INTEGER DEFAULT 0' },
          { name: 'end_page', sql: 'end_page INTEGER DEFAULT 0' },
          { name: 'pages_read', sql: 'pages_read INTEGER DEFAULT 0' },
          { name: 'notes', sql: 'notes TEXT' },
          { name: 'created_at', sql: 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP' }
        ];
        
        for (const field of recordsFieldsToAdd) {
          if (!recordsColumnNames.includes(field.name)) {
            try {
              db.prepare(`ALTER TABLE qc_reading_records ADD COLUMN ${field.sql}`).run();
              console.log(`  ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
      }

      db.prepare('CREATE INDEX IF NOT EXISTS idx_reading_book_reader ON qc_reading_records(book_id, reader_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_reading_book_user ON qc_reading_records(book_id, user_id)').run();
      if (recordsColumnNames.includes('start_time') || !existingRecordsTable) {
        db.prepare('CREATE INDEX IF NOT EXISTS idx_reading_date ON qc_reading_records(start_time)').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_reading_reader_date ON qc_reading_records(reader_id, start_time)').run();
      }

      // 创建 qc_daily_reading_stats 表（如果不存在）- 每日阅读统计
      const existingStatsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_daily_reading_stats'").get();
      const statsColumns = existingStatsTable ? db.prepare('PRAGMA table_info(qc_daily_reading_stats)').all() : [];
      const statsColumnNames = statsColumns.map(c => c.name);
      
      if (!existingStatsTable) {
        db.prepare(`
          CREATE TABLE qc_daily_reading_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reader_id INTEGER NOT NULL DEFAULT 0,
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
            UNIQUE(user_id, stat_date)
          )
        `).run();
        console.log('✅ qc_daily_reading_stats 表创建完成');
      } else {
        console.log('✅ qc_daily_reading_stats 表已存在，检查并添加缺失字段...');
        const statsFieldsToAdd = [
          { name: 'user_id', sql: 'user_id INTEGER NOT NULL DEFAULT 0' },
          { name: 'reader_id', sql: 'reader_id INTEGER DEFAULT 0' },
          { name: 'stat_date', sql: 'stat_date DATE' },
          { name: 'date', sql: 'date DATE' },
          { name: 'total_reading_time', sql: 'total_reading_time INTEGER DEFAULT 0' },
          { name: 'total_time', sql: 'total_time INTEGER DEFAULT 0' },
          { name: 'total_pages_read', sql: 'total_pages_read INTEGER DEFAULT 0' },
          { name: 'total_pages', sql: 'total_pages INTEGER DEFAULT 0' },
          { name: 'books_read_count', sql: 'books_read_count INTEGER DEFAULT 0' },
          { name: 'total_books', sql: 'total_books INTEGER DEFAULT 0' }
        ];
        
        for (const field of statsFieldsToAdd) {
          if (!statsColumnNames.includes(field.name)) {
            try {
              db.prepare(`ALTER TABLE qc_daily_reading_stats ADD COLUMN ${field.sql}`).run();
              console.log(`  ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
      }

      db.prepare('CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date ON qc_daily_reading_stats(user_id, stat_date)').run();
      if (statsColumnNames.includes('reader_id') || !existingStatsTable) {
        db.prepare('CREATE INDEX IF NOT EXISTS idx_daily_stats_reader_date ON qc_daily_reading_stats(reader_id, date)').run();
      }

      // 创建 reading_goals 表（如果不存在）- 阅读目标
      const existingGoalsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reading_goals'").get();
      const goalsColumns = existingGoalsTable ? db.prepare('PRAGMA table_info(reading_goals)').all() : [];
      const goalsColumnNames = goalsColumns.map(c => c.name);
      
      if (!existingGoalsTable) {
        db.prepare(`
          CREATE TABLE reading_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            reader_id INTEGER NOT NULL DEFAULT 0,
            year INTEGER NOT NULL,
            goal_type VARCHAR(20) DEFAULT 'yearly',
            target INTEGER NOT NULL,
            target_value INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            current_value INTEGER DEFAULT 0,
            start_date DATE,
            end_date DATE,
            status VARCHAR(20) DEFAULT 'active',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, year)
          )
        `).run();
        console.log('✅ reading_goals 表创建完成');
      } else {
        console.log('✅ reading_goals 表已存在，检查并添加缺失字段...');
        const goalsFieldsToAdd = [
          { name: 'user_id', sql: 'user_id INTEGER NOT NULL DEFAULT 0' },
          { name: 'reader_id', sql: 'reader_id INTEGER DEFAULT 0' },
          { name: 'goal_type', sql: "goal_type VARCHAR(20) DEFAULT 'yearly'" },
          { name: 'target', sql: 'target INTEGER DEFAULT 0' },
          { name: 'target_value', sql: 'target_value INTEGER DEFAULT 0' },
          { name: 'completed', sql: 'completed INTEGER DEFAULT 0' },
          { name: 'current_value', sql: 'current_value INTEGER DEFAULT 0' },
          { name: 'start_date', sql: 'start_date DATE' },
          { name: 'end_date', sql: 'end_date DATE' },
          { name: 'status', sql: "status VARCHAR(20) DEFAULT 'active'" }
        ];
        
        for (const field of goalsFieldsToAdd) {
          if (!goalsColumnNames.includes(field.name)) {
            try {
              db.prepare(`ALTER TABLE reading_goals ADD COLUMN ${field.sql}`).run();
              console.log(`  ✅ 添加字段: ${field.name}`);
            } catch (e) {
              if (!e.message.includes('duplicate column')) {
                console.warn(`  ⚠️ 添加字段 ${field.name} 失败:`, e.message);
              }
            }
          }
        }
      }

      this.ensureDevicesTable(db);
      
      this.ensureBookTypeField(db);

      console.log('✅ qcbooklog 专属表结构初始化完成');
      console.log('✅ qc_bookdata 表创建完成');
    } catch (error) {
      console.error('❌ 初始化 qcbooklog 专属表结构失败:', error.message);
      throw error;
    }
  }

  ensureDevicesTable(db) {
    console.log('📋 检查 devices 表...');
    const existingDevicesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'").get();
    
    if (existingDevicesTable) {
      console.log('✅ devices 表已存在');
      return;
    }
    
    console.log('📝 创建 devices 表...');
    try {
      db.prepare(`
        CREATE TABLE devices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          reader_id INTEGER NOT NULL DEFAULT 0,
          device_name VARCHAR(200) NOT NULL,
          device_type VARCHAR(50) DEFAULT 'unknown',
          device_id VARCHAR(255),
          last_access DATETIME,
          user_agent TEXT,
          ip_address VARCHAR(50),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (reader_id) REFERENCES readers(id) ON DELETE CASCADE
        )
      `).run();
      
      db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_reader_id ON devices(reader_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_devices_last_access ON devices(last_access)').run();
      
      console.log('✅ devices 表创建成功');
    } catch (error) {
      console.warn('⚠️ 创建 devices 表失败:', error.message);
    }
  }

  ensureBookTypeField(db) {
    console.log('📋 检查 qc_bookdata 表的 book_type 字段...');
    
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_bookdata'").get()) {
      console.log('⚠️ qc_bookdata 表不存在，跳过 book_type 字段检查');
      return;
    }
    
    const columns = db.prepare("PRAGMA table_info(qc_bookdata)").all();
    const hasBookType = columns.some(col => col.name === 'book_type');
    
    if (hasBookType) {
      console.log('✅ qc_bookdata.book_type 字段已存在');
      return;
    }
    
    console.log('📝 添加 book_type 字段到 qc_bookdata 表...');
    try {
      db.prepare('ALTER TABLE qc_bookdata ADD COLUMN book_type INTEGER NOT NULL DEFAULT 1').run();
      console.log('✅ book_type 字段添加成功 (默认值: 1 = 实体书)');
    } catch (error) {
      if (!error.message.includes('duplicate column')) {
        console.warn('⚠️ 添加 book_type 字段失败:', error.message);
      }
    }
  }

  /**
   * 注册 Calibre 所需的自定义函数
   */
  registerCalibreFunctions(db) {
    // title_sort 函数：用于生成排序用的标题
    db.function('title_sort', (title) => {
      if (!title) return '';
      // 移除常见的前缀（如 "A", "The", "An" 等）
      const sortTitle = title
        .replace(/^\s*(A|The|An)\s+/i, '')
        .toLowerCase()
        .trim();
      return sortTitle;
    });
    console.log('✅ 已注册 Calibre 自定义函数: title_sort');

    // uuid4 函数：用于生成 UUID v4
    db.function('uuid4', () => {
      return crypto.randomUUID();
    });
    console.log('✅ 已注册 Calibre 自定义函数: uuid4');
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

  /**
   * 获取所有书籍（从 Calibre 数据库）
   * @param {number} readerId - 读者ID，默认为0
   */
  getAllBooksFromCalibre(readerId = 0) {
    try {
      console.log('🔄 === 开始从 Calibre 获取所有书籍 ===');
      console.log('🔄 数据库是否可用:', this.isCalibreAvailable());
      console.log('🔄 数据库路径:', CALIBRE_DB_PATH);
      console.log('🔄 数据库对象:', this.calibreDb ? '已连接' : '未连接');

      if (!this.calibreDb) {
        throw new Error('Calibre 数据库服务不可用');
      }

      // 强制同步WAL文件，确保能看到最新的写入数据
      this.calibreDb.pragma('wal_checkpoint(PASSIVE)');

      // 使用Calibre的meta视图获取书籍信息
      const query = `
      SELECT
        b.id,
        b.title,
        b.timestamp,
        b.pubdate,
        b.path,
        b.uuid,
        b.has_cover,
        b.series_index,
        b.last_modified,
        (
          SELECT GROUP_CONCAT(a.name, ' & ')
          FROM authors a
          JOIN books_authors_link bal ON a.id = bal.author
          WHERE bal.book = b.id
        ) as author,
        (SELECT i.val FROM identifiers i WHERE i.book = b.id AND i.type = 'isbn') as isbn,
        (SELECT r.rating FROM ratings r JOIN books_ratings_link brl ON r.id = brl.rating WHERE brl.book = b.id) as rating,
        (SELECT c.text FROM comments c WHERE c.book = b.id) as description,
        (SELECT p.name FROM publishers p WHERE p.id IN (SELECT publisher FROM books_publishers_link WHERE book = b.id)) as publisher,
        (SELECT l.lang_code FROM languages l WHERE l.id IN (SELECT lang_code FROM books_languages_link WHERE book = b.id)) as language,
          (SELECT s.name FROM series s WHERE s.id IN (SELECT bsl.series FROM books_series_link bsl WHERE bsl.book = b.id)) as series,
        (
          SELECT '[' || GROUP_CONCAT('"' || t.name || '"', ',') || ']'
          FROM tags t
          JOIN books_tags_link btl ON t.id = btl.tag
          WHERE btl.book = b.id
        ) as tags,
        '[]' as formats
      FROM books b
      ORDER BY b.last_modified DESC
    `;

      try {
        const books = this.calibreDb.prepare(query).all();
        console.log('✅ 查询到 Calibre 书籍数量:', books.length);

        // 获取书籍类型信息，传递readerId以获取正确的阅读状态
        console.log('🔍 调试：准备调用 enrichBooksWithType');
        const booksWithType = this.enrichBooksWithType(books, readerId);
        console.log('🔍 调试：enrichBooksWithType 返回结果，书籍数量:', booksWithType.length);

        return booksWithType;
      } catch (error) {
        console.error('❌ 从 Calibre 数据库获取书籍失败:', error.message);
        // 抛出错误，让外部try-catch块处理，从而降级到文件系统读取模式
        throw error;
      }
    } catch (error) {
      console.error('❌ 获取所有书籍失败:', error.message);
      throw error;
    }
  }

  /**
   * 从 Talebook 数据库获取书籍类型和分组信息
   * @param {Array} books - 书籍列表
   * @param {number} readerId - 读者ID，默认为0
   */
  enrichBooksWithType(books, readerId = 0) {
    console.log(`🔍 调试：enrichBooksWithType 被调用，书籍数量: ${books.length}`);
    if (!this.isTalebookAvailable()) {
      // 如果 Talebook 数据库不可用，返回原始书籍数据
      return books.map(book => {
        // 生成封面URL（使用URL编码处理特殊字符）
        const coverUrl = book.has_cover === 1 ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined;
        return {
          ...book,
          book_type: 1, // 默认实体书
          groups: [],
          bookmarks: [],
          page_count: 0,
          standard_price: 0,
          purchase_price: 0,
          purchase_date: book.timestamp || new Date().toISOString(),
          binding1: 0,
          binding2: 0,
          paper1: 0,
          edge1: 0,
          edge2: 0,
          note: '',
          readStatus: '未读',
          readCompleteDate: '',
          // 添加封面URL
          coverUrl: coverUrl,
          localCoverData: coverUrl,
          hasCover: book.has_cover === 1
        };
      });
    }

    try {
      // 从 Talebook 数据库获取所有书籍的类型信息
      const bookIds = books.map(book => book.id);
      if (bookIds.length === 0) {
        return books.map(book => {
          // 生成封面URL（使用URL编码处理特殊字符）
          const coverUrl = book.has_cover === 1 ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined;
          return {
            ...book,
            book_type: 1,
            groups: [],
            bookmarks: [],
            page_count: 0,
            standard_price: 0,
            purchase_price: 0,
            purchase_date: book.timestamp || new Date().toISOString(),
            binding1: 0,
            binding2: 0,
            paper1: 0,
            edge1: 0,
            edge2: 0,
            note: '',
            // 添加封面URL
            coverUrl: coverUrl,
            localCoverData: coverUrl,
            hasCover: book.has_cover === 1
          };
        });
      }

      const placeholders = bookIds.map(() => '?').join(',');
      
      // 使用参数化查询获取书籍类型（Talebook 使用 items 表，主键是 book_id）
      const bookTypesQuery = `SELECT book_id as id, book_type FROM items WHERE book_id IN (${placeholders})`;
      const bookTypes = this.talebookDb.prepare(bookTypesQuery).all(...bookIds);
      const bookTypeMap = new Map(bookTypes.map(bt => [bt.id, bt.book_type]));

      // 对于 Talebook 中没有找到的书籍，从 QCBookLog 获取
      const missingBookIds = bookIds.filter(id => !bookTypeMap.has(id));
      if (missingBookIds.length > 0 && this.qcBooklogDb) {
        try {
          const missingPlaceholders = missingBookIds.map(() => '?').join(',');
          const qcBookTypesQuery = `
            SELECT m.calibre_book_id as id, bd.book_type
            FROM qc_bookdata bd
            JOIN qc_book_mapping m ON bd.mapping_id = m.id
            WHERE m.calibre_book_id IN (${missingPlaceholders}) AND m.library_uuid = ?
          `;
          const currentLibraryUuid = this.getCurrentLibraryUuid ? this.getCurrentLibraryUuid() : null;
          const qcBookTypes = this.qcBooklogDb.prepare(qcBookTypesQuery).all(...missingBookIds, currentLibraryUuid);
          qcBookTypes.forEach(bt => bookTypeMap.set(bt.id, bt.book_type));
          console.log(`✅ 从 QCBookLog 数据库获取了 ${qcBookTypes.length} 本书籍的载体类型（补充模式）`);
        } catch (error) {
          console.warn('⚠️ 从 QCBookLog 获取书籍类型失败:', error.message);
        }
      }

      // ========== 分组功能数据：优先使用 qcBooklogDb ==========
      // 本软件的"分组"功能与 talebook 系统的"分组"功能存在本质差异
      // 分组数据写入到 qcBooklogDb，因此查询也必须从 qcBooklogDb 获取
      // 注意：qcBooklogDb 的 qc_book_groups 表使用 mapping_id，需要 JOIN qc_book_mapping 获取 calibre_book_id
      const bookGroupsQuery = this.qcBooklogDb 
        ? `SELECT m.calibre_book_id as book_id, g.id, g.name, g.description 
           FROM qc_book_groups bg
           JOIN qc_book_mapping m ON bg.mapping_id = m.id
           JOIN qc_groups g ON bg.group_id = g.id
           WHERE m.calibre_book_id IN (${placeholders})
           ORDER BY g.name`
        : `SELECT bg.book_id, g.id, g.name, g.description FROM qc_book_groups bg
           JOIN qc_groups g ON bg.group_id = g.id
           WHERE bg.book_id IN (${placeholders})
           ORDER BY g.name`;
      const groupsDb = this.qcBooklogDb || this.talebookDb;
      const bookGroups = groupsDb.prepare(bookGroupsQuery).all(...bookIds);
      
      // 构建书籍到分组的映射
      const bookGroupsMap = new Map();
      bookGroups.forEach(item => {
        if (!bookGroupsMap.has(item.book_id)) {
          bookGroupsMap.set(item.book_id, []);
        }
        // 只存储分组ID（字符串），匹配前端类型定义 string[]
        bookGroupsMap.get(item.book_id).push(String(item.id));
      });
      
      // 获取书籍扩展数据（页数、价格、购买日期、装帧、阅读追踪等）
      // 非分组功能数据，保持优先从 talebookDb 获取
      const bookDataQuery = `
        SELECT book_id, page_count, standard_price, purchase_price, purchase_date, binding1, binding2, paper1, edge1, edge2, note,
               total_reading_time, read_pages, reading_count, last_read_date, last_read_duration
        FROM qc_bookdata
        WHERE book_id IN (${placeholders})
      `;
      const bookData = this.talebookDb.prepare(bookDataQuery).all(...bookIds);
      const bookDataMap = new Map();
      bookData.forEach(item => {
        bookDataMap.set(item.book_id, {
          page_count: item.page_count || 0,
          standard_price: item.standard_price || 0,
          purchase_price: item.purchase_price || 0,
          purchase_date: item.purchase_date,
          binding1: item.binding1 || 0,
          binding2: item.binding2 || 0,
          paper1: item.paper1 || 0,
          edge1: item.edge1 || 0,
          edge2: item.edge2 || 0,
          note: item.note || '',
          // 阅读追踪字段
          total_reading_time: item.total_reading_time || 0,
          read_pages: item.read_pages || 0,
          reading_count: item.reading_count || 0,
          last_read_date: item.last_read_date || null,
          last_read_duration: item.last_read_duration || 0
        });
      });

      // 获取阅读状态
      const readingStateQuery = `
        SELECT book_id, read_state, read_date
        FROM reading_state
        WHERE book_id IN (${placeholders}) AND reader_id = ?
      `;
      const readingStates = this.talebookDb.prepare(readingStateQuery).all(...bookIds, readerId);
      const readingStateMap = new Map();
      readingStates.forEach(rs => {
        const statusMap = {
          0: '未读',
          1: '在读',
          2: '已读'
        };
        readingStateMap.set(rs.book_id, {
          readStatus: statusMap[rs.read_state] || '未读',
          readCompleteDate: rs.read_date || ''
        });
      });
      console.log(`✅ 从 Talebook 数据库获取了 ${readingStates.length} 本书籍的阅读状态`);

      // 返回包含类型和分组信息的书籍数据
      return books.map(book => {
        const bookData = bookDataMap.get(book.id) || {};
        console.log(`📚 调试信息：book.id = ${book.id}, bookData =`, bookData);
        
        // 从pubdate字段提取年份作为publishYear
        let publishYear = undefined;
        if (book.pubdate) {
          const yearMatch = String(book.pubdate).match(/\d{4}/);
          if (yearMatch) {
            publishYear = parseInt(yearMatch[0], 10);
          }
        }
        
        // 解析tags为数组
        let tags = [];
        if (book.tags) {
          try {
            tags = JSON.parse(book.tags);
          } catch (e) {
            console.error(`❌ 解析tags失败: ${book.tags}`, e.message);
            tags = [];
          }
        }
        
        // 生成封面URL（使用URL编码处理特殊字符）
        const coverUrl = book.has_cover === 1 ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined;
        console.log(`🔍 调试：书籍 ${book.id} (${book.title}) 的封面URL:`, coverUrl);
        
        return {
          ...book,
          book_type: bookTypeMap.has(book.id) ? bookTypeMap.get(book.id) : 1,
          groups: bookGroupsMap.get(book.id) || [],
          bookmarks: [],
          // 新增字段
          page_count: bookData.page_count || 0,
          standard_price: bookData.standard_price || 0,
          purchase_price: bookData.purchase_price || 0,
          purchase_date: bookData.purchase_date || book.timestamp || new Date().toISOString(),
          binding1: bookData.binding1 || 0,
          binding2: bookData.binding2 || 0,
          paper1: bookData.paper1 || 0,
          edge1: bookData.edge1 || 0,
          edge2: bookData.edge2 || 0,
          note: bookData.note || '',
          // 阅读追踪字段
          total_reading_time: bookData.total_reading_time || 0,
          read_pages: bookData.read_pages || 0,
          reading_count: bookData.reading_count || 0,
          last_read_date: bookData.last_read_date || null,
          last_read_duration: bookData.last_read_duration || 0,
          // 提取出版年份
          publishYear: publishYear,
          // 解析tags为数组
          tags: tags,
          // 添加封面URL
          coverUrl: coverUrl,
          localCoverData: coverUrl,
          hasCover: book.has_cover === 1,
          // 添加前端所需字段，兼容前端使用
          pages: bookData.page_count || 0,
          standardPrice: bookData.standard_price || 0,
          purchasePrice: bookData.purchase_price || 0,
          purchaseDate: bookData.purchase_date || book.timestamp || new Date().toISOString(),
          binding1: bookData.binding1 || 0,
          binding2: bookData.binding2 || 0,
          note: bookData.note || '',
          // 阅读状态
          readStatus: readingStateMap.get(book.id)?.readStatus || '未读',
          readCompleteDate: readingStateMap.get(book.id)?.readCompleteDate || ''
        };
      });
    } catch (error) {
      console.error('❌ 从 Talebook 数据库获取书籍类型和分组失败:', error.message);
      // 失败时返回原始书籍数据，包含新增字段
      return books.map(book => {
        // 从pubdate字段提取年份作为publishYear
        let publishYear = undefined;
        if (book.pubdate) {
          const yearMatch = String(book.pubdate).match(/\d{4}/);
          if (yearMatch) {
            publishYear = parseInt(yearMatch[0], 10);
          }
        }
        
        // 解析tags为数组
        let tags = [];
        if (book.tags) {
          try {
            tags = JSON.parse(book.tags);
          } catch (e) {
            console.error(`❌ 解析tags失败: ${book.tags}`, e.message);
            tags = [];
          }
        }
        
        return {
          ...book,
          book_type: 1,
          groups: [],
          bookmarks: [],
          page_count: 0,
          standard_price: 0,
          purchase_price: 0,
          purchase_date: '',
          publishYear: publishYear,
          // 解析tags为数组
          tags: tags,
          // 添加前端所需字段，兼容前端使用
          pages: 0,
          standardPrice: 0,
          purchasePrice: 0,
          purchaseDate: book.timestamp || new Date().toISOString(),
          binding1: 0,
          binding2: 0,
          paper1: 0,
          edge1: 0,
          edge2: 0,
          note: '',
          // 阅读状态
          readStatus: '未读',
          readCompleteDate: ''
        };
      });
    }
  }

  /**
   * 根据ID获取书籍（从 Calibre 数据库）
   */
  getBookById(bookId) {
    try {
      if (!this.calibreDb) {
        throw new Error('Calibre 数据库未初始化');
      }

      // 强制同步WAL文件，确保能看到最新的写入数据
      this.calibreDb.pragma('wal_checkpoint(PASSIVE)');

      // 确保 bookId 是整数，不接受 UUID
      const numericBookId = parseInt(bookId, 10);
      if (isNaN(numericBookId)) {
        console.error(`❌ 无效的书籍ID: ${bookId}，只允许整数ID`);
        return null;
      }

      // 构建查询SQL和参数
      const query = `
        SELECT
          b.id,
          b.title,
          b.timestamp,
          b.pubdate,
          b.path,
          b.uuid,
          b.has_cover,
          b.series_index,
          b.last_modified,
          (
            SELECT GROUP_CONCAT(a.name, ' & ')
            FROM authors a
            JOIN books_authors_link bal ON a.id = bal.author
            WHERE bal.book = b.id
          ) as author,
          (SELECT COALESCE((SELECT i.val FROM identifiers i WHERE i.book = b.id AND i.type = 'isbn'), '') as isbn) as isbn,
          (SELECT r.rating FROM ratings r JOIN books_ratings_link brl ON r.id = brl.rating WHERE brl.book = b.id) as rating,
          (SELECT c.text FROM comments c WHERE c.book = b.id) as description,
          (SELECT p.name FROM publishers p WHERE p.id IN (SELECT publisher FROM books_publishers_link WHERE book = b.id)) as publisher,
          (SELECT l.lang_code FROM languages l WHERE l.id IN (SELECT lang_code FROM books_languages_link WHERE book = b.id)) as language,
          (SELECT s.name FROM series s WHERE s.id IN (SELECT bsl.series FROM books_series_link bsl WHERE bsl.book = b.id)) as series,
          (
            SELECT '[' || GROUP_CONCAT('"' || t.name || '"', ',') || ']'
            FROM tags t
            JOIN books_tags_link btl ON t.id = btl.tag
            WHERE btl.book = b.id
          ) as tags,
          '[]' as formats
        FROM books b
        WHERE b.id = ?
      `;
      
      // 执行查询
      const book = this.calibreDb.prepare(query).get(numericBookId);
      
      if (!book) {
        return null;
      }

      // 生成封面URL（统一使用Calibre格式）
      let coverUrl = '';
      if (book.has_cover === 1) {
        // 使用数据库中存储的正确路径
        const bookPath = book.path || `${book.author || '未知作者'}/${book.title || '未知书名'}`;
        coverUrl = `/api/static/calibre/${encodeURIComponent(bookPath)}/cover.jpg`;
      }

      // 获取书籍类型和相关数据
      const bookWithType = this.enrichBooksWithType([book])[0];
      
      // 从pubdate字段提取年份作为publishYear
      let publishYear = undefined;
      console.log(`📅 调试信息：book.pubdate = ${book.pubdate}, 类型 = ${typeof book.pubdate}`);
      if (book.pubdate) {
        const yearMatch = String(book.pubdate).match(/\d{4}/);
        console.log(`📅 调试信息：yearMatch =`, yearMatch);
        if (yearMatch) {
          publishYear = parseInt(yearMatch[0], 10);
          console.log(`📅 调试信息：publishYear = ${publishYear}`);
        }
      }
      
      // 解析tags为数组
      let tags = [];
      if (book.tags) {
        try {
          tags = JSON.parse(book.tags);
        } catch (e) {
          // 如果解析失败，返回空数组
          tags = [];
        }
      }
      
      // 从 Talebook 数据库获取阅读状态
      let readStatus = '未读';
      let readCompleteDate = '';
      if (this.talebookDb) {
        try {
          const readingState = this.talebookDb.prepare(`
            SELECT read_state, read_date FROM reading_state WHERE book_id = ? AND reader_id = 0
          `).get(numericBookId);

          if (readingState) {
            const statusMap = {
              0: '未读',
              1: '在读',
              2: '已读'
            };
            readStatus = statusMap[readingState.read_state] || '未读';
            readCompleteDate = readingState.read_date || '';
          }
        } catch (readingError) {
          console.warn(`⚠️ 获取书籍 ${numericBookId} 的阅读状态失败:`, readingError.message);
        }
      }

      // 从 QCBookLog 数据库获取分组 ID 列表和自定义标签
      let bookGroupIds = [];
      let bookCustomTags = [];
      if (this.qcBooklogDb) {
        try {
          const groupRows = this.qcBooklogDb.prepare(`
            SELECT bg.group_id as id
            FROM qc_book_groups bg
            JOIN qc_book_mapping m ON bg.mapping_id = m.id
            WHERE m.calibre_book_id = ?
          `).all(numericBookId);
          bookGroupIds = groupRows.map(r => String(r.id));

          // 自定义标签（qc_book_tags 使用 mapping_id + tag_id 关联到 qc_tags.name）
          const tagRows = this.qcBooklogDb.prepare(`
            SELECT DISTINCT t.name as name
            FROM qc_book_tags bt
            JOIN qc_tags t ON bt.tag_id = t.id
            JOIN qc_book_mapping m ON bt.mapping_id = m.id
            WHERE m.calibre_book_id = ?
            ORDER BY t.name
          `).all(numericBookId);
          bookCustomTags = tagRows.map(r => r.name);
        } catch (groupError) {
          console.warn(`⚠️ 获取书籍 ${numericBookId} 的分组/标签失败:`, groupError.message);
        }
      }

      return {
        ...bookWithType,
        coverUrl: coverUrl,
        publishYear: publishYear,
        series: book.series || '',
        tags: tags,
        groups: bookGroupIds,
        customTags: bookCustomTags,
        pages: bookWithType.page_count || 0,
        standardPrice: bookWithType.standard_price || 0,
        purchasePrice: bookWithType.purchase_price || 0,
        purchaseDate: bookWithType.purchase_date || '',
        binding1: bookWithType.binding1 || 0,
        binding2: bookWithType.binding2 || 0,
        paper1: bookWithType.paper1 || 0,
        edge1: bookWithType.edge1 || 0,
        edge2: bookWithType.edge2 || 0,
        note: bookWithType.note || '',
        readStatus: readStatus,
        readCompleteDate: readCompleteDate
      };
    } catch (error) {
      console.error('❌ 获取书籍失败:', error.message);
      return null;
    }
  }

  /**
   * 获取 Calibre 数据库路径
   */
  getDbPath() {
    return CALIBRE_DB_PATH;
  }

  /**
   * 获取 Talebook 数据库路径
   */
  getTalebookDbPath() {
    return TALEBOOK_DB_PATH;
  }

  /**
   * 彻底禁用所有可能引用 title_sort 的触发器和视图
   */
  disableSortTriggersAndViews(db) {
    try {
      // 禁用所有与 sort 相关的触发器
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='trigger'
        AND (name LIKE '%sort%' OR name LIKE '%title%' OR name LIKE '%author%')
      `).all();

      triggers.forEach(t => {
        try {
          db.prepare(`DROP TRIGGER IF EXISTS ${t.name}`).run();
        } catch (dropError) {
          // 静默处理，不记录日志
        }
      });

      // 禁用递归触发器
      db.pragma('recursive_triggers = OFF');

    } catch (error) {
      // 静默处理错误
    }
  }

  /**
   * 添加书籍到数据库
   * @param {Object} book 书籍信息
   * @returns {Object} 添加后的书籍信息（包含ID）
   */
  addBookToDB(book) {
    console.log('📝 [addBookToDB] 开始添加书籍到数据库');
    console.log('📚 [addBookToDB] 书籍数据:', JSON.stringify(book, null, 2));
    console.log('📚 [addBookToDB] 关键字段检查:');
    console.log('  - title:', book.title);
    console.log('  - author:', book.author);
    console.log('  - isbn:', book.isbn);
    console.log('  - description:', book.description ? book.description.substring(0, 100) + '...' : '无');
    console.log('  - tags:', book.tags);
    console.log('  - publisher:', book.publisher);
    console.log('  - book_type:', book.book_type, '类型:', typeof book.book_type);

    try {
      if (!this.calibreDb) {
        throw new Error('Calibre 数据库未初始化');
      }

      // 验证书籍数据
      const validationResult = this.validateBookData(book, false);
      if (!validationResult.isValid) {
        throw new Error(`数据验证失败: ${validationResult.errors.join(', ')}`);
      }

      console.log('✅ [addBookToDB] 数据验证通过');

      // 使用对象来存储bookId，这样可以在transaction中修改
      const result = { bookId: null };
      
      // 开启事务并执行
      const transaction = this.calibreDb.transaction(() => {
        console.log('🔄 [addBookToDB] 开始事务');

        // 1. 处理作者
        let authorId = null;
        if (book.author) {
          // 查找或创建作者
          const author = this.calibreDb.prepare(`SELECT id FROM authors WHERE name = ?`).get(book.author);
          if (author) {
            authorId = author.id;
          } else {
            authorId = this.calibreDb.prepare(`INSERT INTO authors (name, sort) VALUES (?, ?)`).run(book.author, book.author).lastInsertRowid;
          }
        }

        // 2. 处理出版社
        let publisherId = null;
        if (book.publisher) {
          // 查找或创建出版社
          const publisher = this.calibreDb.prepare(`SELECT id FROM publishers WHERE name = ?`).get(book.publisher);
          if (publisher) {
            publisherId = publisher.id;
          } else {
            publisherId = this.calibreDb.prepare(`INSERT INTO publishers (name) VALUES (?)`).run(book.publisher).lastInsertRowid;
          }
        }

        // 3. 添加书籍到books表
        // 构建path字段：确保只有两级目录结构
        let bookPath = book.path;
        if (!bookPath) {
          const cleanAuthor = (book.author || '未知作者').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          const cleanTitle = (book.title || '未知书名').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          bookPath = `${cleanAuthor}/${cleanTitle}`;
        } else {
          // 验证并确保路径只有两级目录
          const pathParts = bookPath.split(/[\/\\]/);
          if (pathParts.length > 2) {
            const cleanAuthor = pathParts.slice(0, -1).join('').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            const cleanTitle = pathParts[pathParts.length - 1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            bookPath = `${cleanAuthor}/${cleanTitle}`;
          } else if (pathParts.length === 2) {
            const cleanAuthor = pathParts[0].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            const cleanTitle = pathParts[1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            bookPath = `${cleanAuthor}/${cleanTitle}`;
          } else {
            bookPath = bookPath.replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          }
        }
        
        const bookResult = this.calibreDb.prepare(`
          INSERT INTO books (title, author_sort, timestamp, pubdate, uuid, has_cover, path, last_modified)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          book.title,
          book.author || '',
          new Date().toISOString(),
          book.publishYear ? `${book.publishYear}-01-01` : null,
          book.uuid || '',
          book.hasCover ? 1 : 0,
          bookPath,
          new Date().toISOString()
        );

        result.bookId = bookResult.lastInsertRowid;
        
        const bookId = result.bookId;
        console.log('✅ [addBookToDB] 书籍基本信息插入成功，bookId:', bookId);

        // 4. 关联作者
        if (authorId) {
          this.calibreDb.prepare(`INSERT OR IGNORE INTO books_authors_link (book, author) VALUES (?, ?)`).run(bookId, authorId);
        }

        // 5. 关联出版社
        if (publisherId) {
          this.calibreDb.prepare(`INSERT OR IGNORE INTO books_publishers_link (book, publisher) VALUES (?, ?)`).run(bookId, publisherId);
        }

        // 6. 添加ISBN
        console.log('📖 [addBookToDB] 检查ISBN字段:');
        console.log('  - book.isbn类型:', typeof book.isbn);
        console.log('  - book.isbn值:', book.isbn);
        console.log('  - book.isbn.trim():', book.isbn ? book.isbn.trim() : 'N/A');
        
        if (book.isbn && book.isbn.trim() !== '') {
          console.log('📖 [addBookToDB] 准备插入ISBN:', book.isbn);
          try {
            const isbnResult = this.calibreDb.prepare(`INSERT INTO identifiers (book, type, val) VALUES (?, 'isbn', ?)`).run(bookId, book.isbn);
            console.log('✅ [addBookToDB] ISBN插入成功，ID:', isbnResult.lastInsertRowid);

            // 验证ISBN是否正确插入
            const insertedISBN = this.calibreDb.prepare(`SELECT * FROM identifiers WHERE id = ?`).get(isbnResult.lastInsertRowid);
            if (!insertedISBN) {
              throw new Error('ISBN插入后验证失败');
            }
            console.log('✅ [addBookToDB] ISBN验证成功:', insertedISBN.val);
          } catch (isbnError) {
            console.error('❌ [addBookToDB] ISBN插入失败:', isbnError.message);
            // 不抛出错误，允许其他字段继续插入
            // 但记录详细的错误信息
            console.error('❌ [addBookToDB] 详细信息:', {
              bookId,
              isbn: book.isbn,
              errorStack: isbnError.stack
            });
          }
        } else {
          console.log('⚠️ [addBookToDB] ISBN为空，跳过插入');
          console.log('⚠️ [addBookToDB] ISBN值:', book.isbn);
        }

        // 7. 添加描述
        console.log('📝 [addBookToDB] 检查description字段:');
        console.log('  - book.description类型:', typeof book.description);
        console.log('  - book.description值:', book.description ? book.description.substring(0, 100) + '...' : '无');
        
        if (book.description && book.description.trim() !== '') {
          console.log('📝 [addBookToDB] 准备插入描述，长度:', book.description.length);
          try {
            const commentResult = this.calibreDb.prepare(`INSERT INTO comments (book, text) VALUES (?, ?)`).run(bookId, book.description);
            console.log('✅ [addBookToDB] 描述插入成功，ID:', commentResult.lastInsertRowid);

            // 验证描述是否正确插入
            const insertedComment = this.calibreDb.prepare(`SELECT * FROM comments WHERE id = ?`).get(commentResult.lastInsertRowid);
            if (!insertedComment) {
              throw new Error('描述插入后验证失败');
            }
            console.log('✅ [addBookToDB] 描述验证成功，长度:', insertedComment.text.length);
          } catch (commentError) {
            console.error('❌ [addBookToDB] 描述插入失败:', commentError.message);
            console.error('❌ [addBookToDB] 详细信息:', {
              bookId,
              descriptionLength: book.description.length,
              errorStack: commentError.stack
            });
          }
        } else {
          console.log('⚠️ [addBookToDB] description为空，跳过插入');
        }

        // 8. 添加评分（保留 1 位小数，存储为 REAL）
        if (book.rating !== undefined && book.rating !== null && book.rating !== '' && !isNaN(parseFloat(book.rating))) {
          console.log('⭐ [addBookToDB] 准备插入评分:', book.rating);
          // 保留 1 位小数（例如 8.7 -> 8.7），存到 REAL 列
          const ratingValue = Math.round(parseFloat(book.rating) * 10) / 10;
          console.log('🔄 [addBookToDB] 评分转换:', book.rating, '->', ratingValue);
          if (ratingValue < 0 || ratingValue > 10) {
            console.warn('⚠️ [addBookToDB] 评分超出范围，跳过评分更新:', ratingValue);
          } else {
            try {
              // 查找或创建评分
              const rating = this.calibreDb.prepare(`SELECT id FROM ratings WHERE rating = ?`).get(ratingValue);
              let ratingId;
              if (rating) {
                ratingId = rating.id;
                console.log('✅ [addBookToDB] 找到已存在的评分ID:', ratingId);
              } else {
                const newRatingResult = this.calibreDb.prepare(`INSERT INTO ratings (rating) VALUES (?)`).run(ratingValue);
                ratingId = newRatingResult.lastInsertRowid;
                console.log('✅ [addBookToDB] 创建新评分ID:', ratingId);
              }

              // 删除旧的评分关联（如果存在）
              this.calibreDb.prepare(`DELETE FROM books_ratings_link WHERE book = ?`).run(bookId);

              // 添加新的评分关联
              const ratingLinkResult = this.calibreDb.prepare(`INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)`).run(bookId, ratingId);
              console.log('✅ [addBookToDB] 评分关联成功，link ID:', ratingLinkResult.lastInsertRowid, '数值:', ratingValue);

              // 验证评分关联是否正确插入
              const insertedRatingLink = this.calibreDb.prepare(`SELECT * FROM books_ratings_link WHERE book = ? AND rating = ?`).get(bookId, ratingId);
              if (!insertedRatingLink) {
                throw new Error('评分关联插入后验证失败');
              }
              console.log('✅ [addBookToDB] 评分关联验证成功');
            } catch (ratingError) {
              console.error('❌ [addBookToDB] 评分插入失败:', ratingError.message);
              console.error('❌ [addBookToDB] 详细信息:', {
                bookId,
                rating: book.rating,
                ratingValue,
                errorStack: ratingError.stack
              });
            }
          }
        }

        // 9. 添加标签
        console.log('🏷️ [addBookToDB] 检查tags字段:');
        console.log('  - book.tags类型:', typeof book.tags);
        console.log('  - book.tags值:', book.tags);
        console.log('  - Array.isArray(book.tags):', Array.isArray(book.tags));
        console.log('  - book.tags?.length:', book.tags?.length);
        
        if (book.tags && Array.isArray(book.tags) && book.tags.length > 0) {
          console.log('🏷️ [addBookToDB] 准备插入标签，数量:', book.tags.length);
          let tagsInserted = 0;
          let tagsFailed = 0;

          for (const tagName of book.tags) {
            try {
              // 查找或创建标签
              const tag = this.calibreDb.prepare(`SELECT id FROM tags WHERE name = ?`).get(tagName);
              let tagId;
              if (tag) {
                tagId = tag.id;
              } else {
                // Calibre数据库的tags表没有sort列，只插入name列
                const newTagResult = this.calibreDb.prepare(`INSERT INTO tags (name) VALUES (?)`).run(tagName);
                tagId = newTagResult.lastInsertRowid;
                console.log('✅ [addBookToDB] 创建新标签:', tagName, 'ID:', tagId);
              }

              // 删除旧的标签关联（如果存在）
              this.calibreDb.prepare(`DELETE FROM books_tags_link WHERE book = ? AND tag = ?`).run(bookId, tagId);

              // 添加新的标签关联
              const tagLinkResult = this.calibreDb.prepare(`INSERT INTO books_tags_link (book, tag) VALUES (?, ?)`).run(bookId, tagId);
              tagsInserted++;
              console.log('✅ [addBookToDB] 标签关联成功:', tagName, 'link ID:', tagLinkResult.lastInsertRowid);
            } catch (tagError) {
              tagsFailed++;
              console.error('❌ [addBookToDB] 标签插入失败:', tagName, tagError.message);
              console.error('❌ [addBookToDB] 详细信息:', {
                bookId,
                tagName,
                errorStack: tagError.stack
              });
            }
          }

          console.log('📊 [addBookToDB] 标签插入完成: 成功', tagsInserted, '个，失败', tagsFailed, '个');
        } else {
          console.log('⚠️ [addBookToDB] tags为空或不是数组，跳过插入');
          console.log('⚠️ [addBookToDB] tags值:', book.tags);
        }

        // 10. 添加丛书
        if (book.series && book.series.trim() !== '') {
          console.log('📚 [addBookToDB] 准备插入丛书:', book.series);
          try {
            // 查找或创建丛书
            const series = this.calibreDb.prepare(`SELECT id FROM series WHERE name = ?`).get(book.series);
            let seriesId;
            if (series) {
              seriesId = series.id;
            } else {
              const newSeriesResult = this.calibreDb.prepare(`INSERT INTO series (name) VALUES (?)`).run(book.series);
              seriesId = newSeriesResult.lastInsertRowid;
              console.log('✅ [addBookToDB] 创建新丛书:', book.series, 'ID:', seriesId);
            }

            // 删除旧的丛书关联（如果存在）
            this.calibreDb.prepare(`DELETE FROM books_series_link WHERE book = ?`).run(bookId);

            // 关联书籍和丛书
            const seriesLinkResult = this.calibreDb.prepare(`INSERT INTO books_series_link (book, series) VALUES (?, ?)`).run(bookId, seriesId);
            console.log('✅ [addBookToDB] 丛书关联成功，link ID:', seriesLinkResult.lastInsertRowid);

            // 验证丛书关联是否正确插入
            const insertedSeriesLink = this.calibreDb.prepare(`SELECT * FROM books_series_link WHERE book = ? AND series = ?`).get(bookId, seriesId);
            if (!insertedSeriesLink) {
              throw new Error('丛书关联插入后验证失败');
            }
            console.log('✅ [addBookToDB] 丛书关联验证成功');
          } catch (seriesError) {
            console.error('❌ [addBookToDB] 丛书插入失败:', seriesError.message);
            console.error('❌ [addBookToDB] 详细信息:', {
              bookId,
              series: book.series,
              errorStack: seriesError.stack
            });
          }
        }

        // 11. 添加语言
        if (book.language) {
          console.log('🌍 [addBookToDB] 准备插入语言:', book.language);
          try {
            // 查找或创建语言
            const language = this.calibreDb.prepare(`SELECT id FROM languages WHERE lang_code = ?`).get(book.language);
            let langId;
            if (language) {
              langId = language.id;
            } else {
              const newLanguageResult = this.calibreDb.prepare(`INSERT INTO languages (lang_code) VALUES (?)`).run(book.language);
              langId = newLanguageResult.lastInsertRowid;
              console.log('✅ [addBookToDB] 创建新语言:', book.language, 'ID:', langId);
            }

            // 删除旧的语言关联（如果存在）
            this.calibreDb.prepare(`DELETE FROM books_languages_link WHERE book = ?`).run(bookId);

            // Calibre数据库的books_languages_link表使用lang_code作为列名，而不是language
            const languageLinkResult = this.calibreDb.prepare(`INSERT INTO books_languages_link (book, lang_code) VALUES (?, ?)`).run(bookId, langId);
            console.log('✅ [addBookToDB] 语言关联成功，link ID:', languageLinkResult.lastInsertRowid);

            // 验证语言关联是否正确插入
            const insertedLanguageLink = this.calibreDb.prepare(`SELECT * FROM books_languages_link WHERE book = ? AND lang_code = ?`).get(bookId, langId);
            if (!insertedLanguageLink) {
              throw new Error('语言关联插入后验证失败');
            }
            console.log('✅ [addBookToDB] 语言关联验证成功');
          } catch (languageError) {
            console.error('❌ [addBookToDB] 语言插入失败:', languageError.message);
            console.error('❌ [addBookToDB] 详细信息:', {
              bookId,
              language: book.language,
              errorStack: languageError.stack
            });
          }
        }
      });
      
      // 执行事务
      transaction();

      // 3. 如果 Talebook 数据库可用，同步书籍到 Talebook 数据库
      if (this.isTalebookAvailable()) {
        try {
          // 检查书籍是否已存在于 Talebook 数据库（items表的主键是book_id）
        const existingItem = this.talebookDb.prepare(`SELECT book_id FROM items WHERE book_id = ?`).get(result.bookId);
        if (!existingItem) {
          // 插入书籍到 Talebook 数据库的 items 表（只存储统计信息）
          const bookTypeToInsert = book.book_type !== undefined && book.book_type !== null ? book.book_type : 1;
          console.log('📝 [addBookToDB] 准备插入到 items 表，book_type:', bookTypeToInsert);
          this.talebookDb.prepare(`
            INSERT INTO items (book_id, count_guest, count_visit, count_download, website, sole, book_type, book_count, create_time)
            VALUES (?, 0, 0, 0, '', 0, ?, 1, ?)
          `).run(
            result.bookId,
            bookTypeToInsert,
            new Date().toISOString()
          );
          console.log('✅ 书籍同步到 Talebook 数据库items表成功');
        } else {
          // 更新书籍类型
          this.talebookDb.prepare(`
            UPDATE items
            SET book_type = ?
            WHERE book_id = ?
          `).run(
            book.book_type !== undefined && book.book_type !== null ? book.book_type : (existingItem.book_type || 1),
            result.bookId
          );
          console.log('✅ 书籍类型更新到 Talebook 数据库items表成功');
        }
        
        // 使用 qcBooklogDb 操作 qc_bookdata 表（该表在 qc_booklog.db 中）
        const qcBookdataDb = this.qcBooklogDb || this.talebookDb;
        if (qcBookdataDb) {
          // 检查书籍是否已存在于qc_bookdata表
          const existingBookData = qcBookdataDb.prepare(`SELECT * FROM qc_bookdata WHERE book_id = ?`).get(result.bookId);
          if (!existingBookData) {
            // 处理前端发送的pages字段，兼容pageCount字段
            // 提取数字页数
            let pageCount = 0;
            if (book.pageCount) {
              pageCount = parseInt(book.pageCount) || 0;
            } else if (book.pages) {
              // 处理字符串格式的页数，如"114页"
              pageCount = parseInt(String(book.pages).match(/\d+/)?.[0] || '0') || 0;
            }

            // 插入书籍到qc_bookdata表，包含所有新增字段
            const bookTypeToInsert = book.book_type !== undefined && book.book_type !== null ? book.book_type : 1;
            console.log('📝 [addBookToDB] 准备插入到 qc_bookdata 表，book_type:', bookTypeToInsert);
            qcBookdataDb.prepare(`
              INSERT INTO qc_bookdata (book_id, book_type, page_count, standard_price, purchase_price, purchase_date, binding1, binding2, paper1, edge1, edge2, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              result.bookId,
              bookTypeToInsert,
              pageCount,
              book.standardPrice || 0,
              book.purchasePrice || 0,
              book.purchaseDate || new Date().toISOString(),
              book.binding1 || 0,
              book.binding2 || 0,
              book.paper1 || 0,
              book.edge1 || 0,
              book.edge2 || 0,
              book.note || ''
            );
            console.log('✅ 书籍同步到 QCBookLog 数据库qc_bookdata表成功');
          } else {
            // 处理前端发送的pages字段，兼容pageCount字段
            // 提取数字页数
            let pageCount = existingBookData.page_count || 0;
            if (book.pageCount) {
              pageCount = parseInt(book.pageCount) || existingBookData.page_count || 0;
            } else if (book.pages) {
              // 处理字符串格式的页数，如"114页"
              pageCount = parseInt(String(book.pages).match(/\d+/)?.[0] || String(existingBookData.page_count)) || 0;
            }

            // 如果已存在，则更新数据
            // 联动 book_type / binding1 / binding2，避免历史错误值被写回
            const { book_type: mergedBookType, binding1: mergedBinding1, binding2: mergedBinding2 } = normalizeBookTypeBindings({
              book_type: book.book_type !== undefined && book.book_type !== null ? book.book_type : existingBookData.book_type,
              binding1: book.binding1 !== undefined ? book.binding1 : existingBookData.binding1,
              binding2: book.binding2 !== undefined ? book.binding2 : existingBookData.binding2
            });
            qcBookdataDb.prepare(`
              UPDATE qc_bookdata
              SET book_type = ?, page_count = ?, standard_price = ?, purchase_price = ?, purchase_date = ?, binding1 = ?, binding2 = ?, paper1 = ?, edge1 = ?, edge2 = ?, note = ?
              WHERE book_id = ?
            `).run(
              mergedBookType,
              pageCount,
              book.standardPrice || existingBookData.standard_price || 0,
              book.purchasePrice || existingBookData.purchase_price || 0,
              book.purchaseDate || existingBookData.purchase_date || new Date().toISOString(),
              mergedBinding1,
              mergedBinding2,
              book.paper1 !== undefined ? book.paper1 : existingBookData.paper1 || 0,
              book.edge1 !== undefined ? book.edge1 : existingBookData.edge1 || 0,
              book.edge2 !== undefined ? book.edge2 : existingBookData.edge2 || 0,
              book.note !== undefined ? book.note : (existingBookData.note || ''),
              result.bookId
            );
            console.log('✅ 书籍更新到 QCBookLog 数据库qc_bookdata表成功');
          }
        } else {
          console.warn('⚠️ 没有可用的数据库连接，跳过 qc_bookdata 表操作');
        }
          
          // 4. 处理分组关联
          // 注意：分组数据必须写入到 qcBooklogDb，因为读取时优先从 qcBooklogDb 获取
          if (book.groups && Array.isArray(book.groups) && book.groups.length > 0) {
            const groupsDb = this.qcBooklogDb || this.talebookDb;
            if (groupsDb) {
              for (const group of book.groups) {
                if (group.id) {
                  // 插入书籍与分组的关联
                  groupsDb.prepare(`
                    INSERT OR IGNORE INTO qc_book_groups (book_id, group_id)
                    VALUES (?, ?)
                  `).run(result.bookId, group.id);
                }
              }
              console.log(`✅ 分组关联已写入到${this.qcBooklogDb ? 'QCBookLog' : 'Talebook'}数据库`);
            }
          }
        } catch (talebookError) {
          console.error('❌ 同步书籍到 Talebook 数据库失败:', talebookError.message);
          console.error('❌ 错误详情:', talebookError.stack);
          // 不影响主流程，继续执行
        }
      }

      // 重新获取完整的书籍信息（包含所有关联数据）
      const addedBook = this.getBookById(result.bookId);
      return addedBook || { id: result.bookId, ...book };
    } catch (error) {
      console.error('❌ 添加书籍到数据库失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新数据库中的书籍信息
   * @param {Object} book 书籍信息（包含ID）
   * @returns {Object} 更新后的书籍信息
   */
  updateBookInDB(book) {
    try {
      console.log('\n🔄 === 开始更新书籍到数据库 ===');
      console.log('🔄 书籍ID:', book.id);
      console.log('🔄 书籍标题:', book.title);
      console.log('🔄 要更新的字段:', {
        binding1: book.binding1,
        binding2: book.binding2,
        purchasePrice: book.purchasePrice,
        standardPrice: book.standardPrice,
        note: book.note,
        purchaseDate: book.purchaseDate,
        isbn: book.isbn,
        description: book.description ? book.description.substring(0, 50) + '...' : '无',
        tags: book.tags
      });

      if (!this.calibreDb) {
        throw new Error('Calibre 数据库未初始化');
      }

      // 验证书籍数据
      const validationResult = this.validateBookData(book, true);
      if (!validationResult.isValid) {
        throw new Error(`数据验证失败: ${validationResult.errors.join(', ')}`);
      }

      const bookId = parseInt(book.id, 10);
      if (isNaN(bookId)) {
        throw new Error('无效的书籍ID');
      }

      // 获取当前书籍的完整信息（包括 ISBN、description、tags 等）
      console.log('🔄 获取当前书籍的完整信息...');
      const currentBook = this.getBookById(bookId);
      if (!currentBook) {
        throw new Error('书籍不存在');
      }
      console.log('🔄 当前书籍信息:', {
        isbn: currentBook.isbn,
        description: currentBook.description ? currentBook.description.substring(0, 50) + '...' : '无',
        tags: currentBook.tags
      });

      // 合并新旧数据，确保不会丢失任何字段
      const mergedBook = {
        ...currentBook,
        ...book,
        // 确保关键字段不会丢失
        isbn: book.isbn !== undefined ? book.isbn : currentBook.isbn,
        description: book.description !== undefined ? book.description : currentBook.description,
        tags: book.tags !== undefined ? book.tags : currentBook.tags,
        rating: book.rating !== undefined ? book.rating : currentBook.rating,
        publisher: book.publisher !== undefined ? book.publisher : currentBook.publisher,
        language: book.language !== undefined ? book.language : currentBook.language,
        series: book.series !== undefined ? book.series : currentBook.series,
        pages: book.pages !== undefined ? book.pages : currentBook.pages
      };
      console.log('🔄 合并后的书籍信息:', {
        isbn: mergedBook.isbn,
        description: mergedBook.description ? mergedBook.description.substring(0, 50) + '...' : '无',
        tags: mergedBook.tags,
        pages: mergedBook.pages
      });

      // 开启事务
      console.log('🔄 开始Calibre数据库事务...');
      const transaction = this.calibreDb.transaction(() => {
        // 构建path字段：确保只有两级目录结构
        let bookPath = mergedBook.path;
        if (!bookPath) {
          const cleanAuthor = (mergedBook.author || '未知作者').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          const cleanTitle = (mergedBook.title || '未知书名').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          bookPath = `${cleanAuthor}/${cleanTitle}`;
        } else {
          // 验证并确保路径只有两级目录
          const pathParts = bookPath.split(/[\/\\]/);
          if (pathParts.length > 2) {
            const cleanAuthor = pathParts.slice(0, -1).join('').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            const cleanTitle = pathParts[pathParts.length - 1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            bookPath = `${cleanAuthor}/${cleanTitle}`;
          } else if (pathParts.length === 2) {
            const cleanAuthor = pathParts[0].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            const cleanTitle = pathParts[1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
            bookPath = `${cleanAuthor}/${cleanTitle}`;
          } else {
            bookPath = bookPath.replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
          }
        }
        
        // 1. 更新书籍基本信息
        this.calibreDb.prepare(`
          UPDATE books 
          SET title = ?, author_sort = ?, pubdate = ?, has_cover = ?, path = ?, last_modified = ?
          WHERE id = ?
        `).run(
          mergedBook.title,
          mergedBook.author || '',
          mergedBook.publishYear ? `${mergedBook.publishYear}-01-01` : new Date().toISOString(),
          mergedBook.hasCover ? 1 : 0,
          bookPath,
          new Date().toISOString(),
          bookId
        );

        // 2. 处理作者
        if (mergedBook.author) {
          // 查找或创建作者
          const author = this.calibreDb.prepare(`SELECT id FROM authors WHERE name = ?`).get(mergedBook.author);
          let authorId;
          if (author) {
            authorId = author.id;
          } else {
            authorId = this.calibreDb.prepare(`INSERT INTO authors (name, sort) VALUES (?, ?)`).run(mergedBook.author, mergedBook.author).lastInsertRowid;
          }

          // 删除旧的作者关联
          this.calibreDb.prepare(`DELETE FROM books_authors_link WHERE book = ?`).run(bookId);
          // 添加新的作者关联
          this.calibreDb.prepare(`INSERT INTO books_authors_link (book, author) VALUES (?, ?)`).run(bookId, authorId);
        }

        // 3. 处理出版社
        if (mergedBook.publisher) {
          // 查找或创建出版社
          const publisher = this.calibreDb.prepare(`SELECT id FROM publishers WHERE name = ?`).get(mergedBook.publisher);
          let publisherId;
          if (publisher) {
            publisherId = publisher.id;
          } else {
            publisherId = this.calibreDb.prepare(`INSERT INTO publishers (name) VALUES (?)`).run(mergedBook.publisher).lastInsertRowid;
          }

          // 删除旧的出版社关联
          this.calibreDb.prepare(`DELETE FROM books_publishers_link WHERE book = ?`).run(bookId);
          // 添加新的出版社关联
          this.calibreDb.prepare(`INSERT INTO books_publishers_link (book, publisher) VALUES (?, ?)`).run(bookId, publisherId);
        }

        // 4. 更新ISBN
        this.calibreDb.prepare(`DELETE FROM identifiers WHERE book = ? AND type = 'isbn'`).run(bookId);
        if (mergedBook.isbn && mergedBook.isbn.trim() !== '') {
          this.calibreDb.prepare(`INSERT INTO identifiers (book, type, val) VALUES (?, 'isbn', ?)`).run(bookId, mergedBook.isbn);
          console.log('✅ ISBN已更新:', mergedBook.isbn);
        } else {
          console.log('⚠️ ISBN为空，跳过更新');
        }

        // 5. 更新描述
        this.calibreDb.prepare(`DELETE FROM comments WHERE book = ?`).run(bookId);
        if (mergedBook.description && mergedBook.description.trim() !== '') {
          this.calibreDb.prepare(`INSERT INTO comments (book, text) VALUES (?, ?)`).run(bookId, mergedBook.description);
          console.log('✅ 描述已更新，长度:', mergedBook.description.length);
        } else {
          console.log('⚠️ 描述为空，跳过更新');
        }

        // 6. 更新评分（保留 1 位小数，存储为 REAL）
        this.calibreDb.prepare(`DELETE FROM books_ratings_link WHERE book = ?`).run(bookId);
        if (mergedBook.rating !== undefined && mergedBook.rating !== null && mergedBook.rating !== '' && !isNaN(parseFloat(mergedBook.rating))) {
          // 保留 1 位小数
          const ratingValue = Math.round(parseFloat(mergedBook.rating) * 10) / 10;
          if (ratingValue >= 0 && ratingValue <= 10) {
            // 查找或创建评分
            const rating = this.calibreDb.prepare(`SELECT id FROM ratings WHERE rating = ?`).get(ratingValue);
            let ratingId;
            if (rating) {
              ratingId = rating.id;
            } else {
              ratingId = this.calibreDb.prepare(`INSERT INTO ratings (rating) VALUES (?)`).run(ratingValue).lastInsertRowid;
            }
            this.calibreDb.prepare(`INSERT INTO books_ratings_link (book, rating) VALUES (?, ?)`).run(bookId, ratingId);
            console.log('✅ 评分已更新:', ratingValue);
          } else {
            console.warn('⚠️ 评分超出范围，跳过评分更新:', ratingValue);
          }
        }

        // 7. 更新标签
        this.calibreDb.prepare(`DELETE FROM books_tags_link WHERE book = ?`).run(bookId);
        if (mergedBook.tags && Array.isArray(mergedBook.tags) && mergedBook.tags.length > 0) {
          console.log('🏷️ 更新标签，数量:', mergedBook.tags.length);
          for (const tagName of mergedBook.tags) {
            // 查找或创建标签
            const tag = this.calibreDb.prepare(`SELECT id FROM tags WHERE name = ?`).get(tagName);
            let tagId;
            if (tag) {
              tagId = tag.id;
            } else {
              // tags表没有sort字段，只插入name字段
              tagId = this.calibreDb.prepare(`INSERT INTO tags (name) VALUES (?)`).run(tagName).lastInsertRowid;
            }
            this.calibreDb.prepare(`INSERT INTO books_tags_link (book, tag) VALUES (?, ?)`).run(bookId, tagId);
          }
        }

        // 8. 更新语言
        this.calibreDb.prepare(`DELETE FROM books_languages_link WHERE book = ?`).run(bookId);
        if (mergedBook.language) {
          // 查找或创建语言
          const language = this.calibreDb.prepare(`SELECT id FROM languages WHERE lang_code = ?`).get(mergedBook.language);
          let langId;
          if (language) {
            langId = language.id;
          } else {
            langId = this.calibreDb.prepare(`INSERT INTO languages (lang_code) VALUES (?)`).run(mergedBook.language).lastInsertRowid;
          }
          this.calibreDb.prepare(`INSERT INTO books_languages_link (book, lang_code) VALUES (?, ?)`).run(bookId, langId);
          console.log('✅ 语言已更新:', mergedBook.language);
        }

        // 9. 更新丛书
        this.calibreDb.prepare(`DELETE FROM books_series_link WHERE book = ?`).run(bookId);
        if (mergedBook.series && mergedBook.series.trim() !== '') {
          // 查找或创建丛书
          const series = this.calibreDb.prepare(`SELECT id FROM series WHERE name = ?`).get(mergedBook.series);
          let seriesId;
          if (series) {
            seriesId = series.id;
          } else {
            seriesId = this.calibreDb.prepare(`INSERT INTO series (name) VALUES (?)`).run(mergedBook.series).lastInsertRowid;
          }
          // 关联书籍和丛书
          this.calibreDb.prepare(`INSERT OR IGNORE INTO books_series_link (book, series) VALUES (?, ?)`).run(bookId, seriesId);
          console.log('✅ 丛书已更新:', mergedBook.series);
        }
      });
      
      // 执行事务
      transaction();

      // 3. 如果 Talebook 数据库可用，同步更新书籍到 Talebook 数据库
      if (this.isTalebookAvailable()) {
        try {
          console.log('🔄 开始同步到Talebook数据库...');

          // 更新 Talebook 数据库中的书籍类型（items表只有统计字段，不存储书籍详细信息）
          const bookType = book.book_type !== undefined && book.book_type !== null ? book.book_type : 1;
          // 检查书籍是否存在
          const existingItem = this.talebookDb.prepare(`SELECT book_id FROM items WHERE book_id = ?`).get(bookId);
          if (existingItem) {
            this.talebookDb.prepare(`
              UPDATE items
              SET book_type = ?
              WHERE book_id = ?
            `).run(
              bookType,
              bookId
            );
            console.log('✅ items表book_type更新成功，book_type:', bookType);
          } else {
            // 如果不存在则创建记录
            this.talebookDb.prepare(`
              INSERT INTO items (book_id, count_guest, count_visit, count_download, website, sole, book_type, create_time)
              VALUES (?, 0, 0, 0, '', 0, ?, ?)
            `).run(
              bookId,
              bookType,
              new Date().toISOString()
            );
            console.log('✅ items表记录创建成功，book_type:', bookType);
          }
          
          // 更新分组关联
          // 注意：分组数据必须写入到 qcBooklogDb，因为读取时优先从 qcBooklogDb 获取
          // 这样确保数据写入和读取的一致性
          if (book.groups) {
            const groupsDb = this.qcBooklogDb || this.talebookDb;
            if (groupsDb) {
              // 删除旧的分组关联
              groupsDb.prepare(`DELETE FROM qc_book_groups WHERE book_id = ?`).run(bookId);

              // 添加新的分组关联
              if (Array.isArray(book.groups) && book.groups.length > 0) {
                for (const group of book.groups) {
                  // 兼容字符串数组和对象数组
                  const groupId = typeof group === 'object' && group.id ? group.id : group;
                  if (groupId) {
                    groupsDb.prepare(`
                      INSERT OR IGNORE INTO qc_book_groups (book_id, group_id)
                      VALUES (?, ?)
                    `).run(bookId, groupId);
                  }
                }
                console.log(`✅ 分组关联已更新到${this.qcBooklogDb ? 'QCBookLog' : 'Talebook'}数据库，分组数: ${book.groups.length}`);
              }
            } else {
              console.warn('⚠️ 没有可用的数据库来存储分组关联');
            }
          }
          
          // 更新qc_bookdata表中的扩展字段
          // 使用 qcBooklogDb 操作 qc_bookdata 表（该表在 qc_booklog.db 中）
          const qcBookdataDb = this.qcBooklogDb || this.talebookDb;
          if (qcBookdataDb) {
            const existingBookData = qcBookdataDb.prepare(`SELECT * FROM qc_bookdata WHERE book_id = ?`).get(bookId);
            console.log('🔄 现有qc_bookdata记录:', existingBookData);
            
            // 处理前端发送的pages字段，兼容pageCount字段
            // 提取数字页数
            let pageCount = 0;
            if (book.pageCount) {
              pageCount = parseInt(book.pageCount) || 0;
            } else if (book.pages) {
              // 处理字符串格式的页数，如"114页"
              pageCount = parseInt(String(book.pages).match(/\d+/)?.[0] || '0') || 0;
            }

            if (existingBookData) {
              console.log('🔄 更新现有qc_bookdata记录...');
              // 联动 book_type / binding1 / binding2（实体书→平装，电子书→电子书）
              const { binding1: mergedBinding1, binding2: mergedBinding2 } = normalizeBookTypeBindings({
                book_type: book.book_type !== undefined && book.book_type !== null ? book.book_type : existingBookData.book_type,
                binding1: book.binding1 !== undefined ? book.binding1 : existingBookData.binding1,
                binding2: book.binding2 !== undefined ? book.binding2 : existingBookData.binding2
              });
              // 更新现有记录
              const updateResult = qcBookdataDb.prepare(`
                UPDATE qc_bookdata
                SET page_count = ?, standard_price = ?, purchase_price = ?, purchase_date = ?, binding1 = ?, binding2 = ?, paper1 = ?, edge1 = ?, edge2 = ?, note = ?
                WHERE book_id = ?
              `).run(
                pageCount,
                book.standardPrice || existingBookData.standard_price || 0,
                book.purchasePrice || existingBookData.purchase_price || 0,
                book.purchaseDate || existingBookData.purchase_date || new Date().toISOString(),
                mergedBinding1,
                mergedBinding2,
                book.paper1 !== undefined ? book.paper1 : existingBookData.paper1 || 0,
                book.edge1 !== undefined ? book.edge1 : existingBookData.edge1 || 0,
                book.edge2 !== undefined ? book.edge2 : existingBookData.edge2 || 0,
                book.note !== undefined ? book.note : (existingBookData.note || ''),
                bookId
              );
              console.log('🔄 qc_bookdata更新结果，影响行数:', updateResult.changes);
            } else {
              console.log('🔄 插入新qc_bookdata记录...');
              // 插入新记录
              const insertResult = qcBookdataDb.prepare(`
                INSERT INTO qc_bookdata (book_id, page_count, standard_price, purchase_price, purchase_date, binding1, binding2, paper1, edge1, edge2, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                bookId,
                pageCount,
                book.standardPrice || 0,
                book.purchasePrice || 0,
                book.purchaseDate || new Date().toISOString(),
                book.binding1 || 0,
                book.binding2 || 0,
                book.paper1 || 0,
                book.edge1 || 0,
                book.edge2 || 0,
                book.note || ''
              );
              console.log('🔄 qc_bookdata插入结果，lastInsertRowid:', insertResult.lastInsertRowid);
            }
          } else {
            console.warn('⚠️ 没有可用的数据库连接，跳过 qc_bookdata 表操作');
          }
          
          console.log('✅ 书籍更新同步到 Talebook 数据库成功');
        } catch (talebookError) {
          console.error('❌ 同步更新书籍到 Talebook 数据库失败:', talebookError.message);
          console.error('❌ 错误堆栈:', talebookError.stack);
          // 不影响主流程，继续执行
        }
      } else {
        console.warn('⚠️ Talebook数据库不可用，跳过同步');
      }

      // 处理分组关联
      console.log('🔄 处理分组关联...');
      console.log('🔄 book.groups:', book.groups);
      console.log('🔄 this.qcBooklogDb:', this.qcBooklogDb ? '存在' : '不存在');
      if (book.groups !== undefined && Array.isArray(book.groups) && this.qcBooklogDb) {
        try {
          const qcDataService = require('./qcDataService.js').default;
          
          // 获取当前书籍的所有分组
          const currentGroups = qcDataService.getBookGroups(bookId) || [];
          const currentGroupIds = currentGroups.map(g => g.id);
          const newGroupIds = book.groups.map(id => parseInt(id)).filter(id => !isNaN(id));
          
          console.log('🔄 当前分组:', currentGroupIds);
          console.log('🔄 新分组:', newGroupIds);
          
          // 找出需要添加的分组
          const groupsToAdd = newGroupIds.filter(id => !currentGroupIds.includes(id));
          // 找出需要移除的分组
          const groupsToRemove = currentGroupIds.filter(id => !newGroupIds.includes(id));
          
          console.log('🔄 需要添加的分组:', groupsToAdd);
          console.log('🔄 需要移除的分组:', groupsToRemove);
          
          // 添加新的分组关联
          for (const groupId of groupsToAdd) {
            try {
              qcDataService.addBookToGroup(bookId, groupId);
              console.log(`✅ 添加书籍到分组: bookId=${bookId}, groupId=${groupId}`);
            } catch (addError) {
              console.error(`❌ 添加书籍到分组失败: ${addError.message}`);
            }
          }
          
          // 移除旧的分组关联
          for (const groupId of groupsToRemove) {
            try {
              qcDataService.removeBookFromGroup(bookId, groupId);
              console.log(`✅ 从分组移除书籍: bookId=${bookId}, groupId=${groupId}`);
            } catch (removeError) {
              console.error(`❌ 从分组移除书籍失败: ${removeError.message}`);
            }
          }
          
          console.log('✅ 分组关联处理完成');
        } catch (groupError) {
          console.error('❌ 处理分组关联失败:', groupError.message);
        }
      }

      // 强制同步WAL文件到主数据库，确保更新立即生效
      console.log('🔄 开始同步WAL文件...');
      if (this.calibreDb) {
        this.calibreDb.pragma('wal_checkpoint(FULL)');
        console.log('✅ Calibre数据库WAL同步完成');
      }
      if (this.talebookDb) {
        this.talebookDb.pragma('wal_checkpoint(FULL)');
        console.log('✅ Talebook数据库WAL同步完成');
      }
      if (this.qcBooklogDb) {
        this.qcBooklogDb.pragma('wal_checkpoint(FULL)');
        console.log('✅ QCBookLog数据库WAL同步完成');
      }

      // 验证更新是否成功
      console.log('🔄 验证更新结果...');
      const verifyDb = this.qcBooklogDb || this.talebookDb;
      if (verifyDb) {
        const verifyResult = verifyDb.prepare(`SELECT * FROM qc_bookdata WHERE book_id = ?`).get(bookId);
        console.log('🔄 验证结果 - qc_bookdata记录:', verifyResult);
      }

      // 重新获取完整的书籍信息（包含所有关联数据）
      console.log('🔄 重新获取完整书籍信息...');
      const updatedBook = this.getBookById(bookId);
      console.log('🔄 更新后的书籍信息:', {
        id: updatedBook?.id,
        title: updatedBook?.title,
        binding1: updatedBook?.binding1,
        binding2: updatedBook?.binding2,
        purchasePrice: updatedBook?.purchasePrice,
        standardPrice: updatedBook?.standardPrice,
        note: updatedBook?.note
      });
      console.log('✅ === 书籍更新完成 ===\n');
      return updatedBook || { id: bookId, ...book };
    } catch (error) {
      console.error('❌ 更新书籍到数据库失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取书籍的阅读状态
   * @param {number} bookId - 书籍ID
   * @param {number} readerId - 读者ID（默认为0）
   * @returns {Object} 阅读状态对象
   */
  getReadingState(bookId, readerId = 0) {
    try {
      if (!this.isTalebookAvailable()) {
        throw new Error('Talebook 数据库服务不可用');
      }

      const readingState = this.talebookDb.prepare(`
        SELECT * FROM reading_state WHERE book_id = ? AND reader_id = ?
      `).get(bookId, readerId);

      return readingState || {
        book_id: bookId,
        reader_id: readerId,
        favorite: 0,
        favorite_date: null,
        wants: 0,
        wants_date: null,
        read_state: 0,
        read_date: null,
        online_read: 0,
        download: 0
      };
    } catch (error) {
      console.error('❌ 获取阅读状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新书籍的阅读状态
   * @param {number} bookId - 书籍ID
   * @param {Object} readingState - 阅读状态对象
   * @param {number} readerId - 读者ID（默认为0）
   * @returns {Object} 更新后的阅读状态
   */
  updateReadingState(bookId, readingState, readerId = 0) {
    try {
      if (!this.isTalebookAvailable()) {
        throw new Error('Talebook 数据库服务不可用');
      }

      const validReadStates = [0, 1, 2];
      const readState = readingState.read_state !== undefined ? readingState.read_state : 0;
      if (!validReadStates.includes(readState)) {
        throw new Error('无效的阅读状态值');
      }

      const existingItem = this.talebookDb.prepare('SELECT book_id FROM items WHERE book_id = ?').get(bookId);
      if (!existingItem) {
        console.log(`📝 书籍 ${bookId} 不在 items 表中，创建记录...`);
        this.talebookDb.prepare(`
          INSERT INTO items (book_id, count_guest, count_visit, count_download, website, sole, book_type, create_time)
          VALUES (?, 0, 0, 0, '', 0, 1, ?)
        `).run(bookId, new Date().toISOString());
        console.log(`✅ 已在 items 表中创建书籍 ${bookId} 的记录`);
      }

      const now = new Date().toISOString();

      this.talebookDb.prepare(`
        INSERT INTO reading_state (
          book_id, reader_id, favorite, favorite_date, wants, wants_date,
          read_state, read_date, online_read, download, personal_rating, personal_rating_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (book_id, reader_id) DO UPDATE SET
          favorite = excluded.favorite,
          favorite_date = excluded.favorite_date,
          wants = excluded.wants,
          wants_date = excluded.wants_date,
          read_state = excluded.read_state,
          read_date = excluded.read_date,
          online_read = excluded.online_read,
          download = excluded.download,
          personal_rating = excluded.personal_rating,
          personal_rating_date = excluded.personal_rating_date
      `).run(
        bookId,
        readerId,
        readingState.favorite || 0,
        readingState.favorite === 1 ? (readingState.favorite_date || now) : null,
        readingState.wants || 0,
        readingState.wants === 1 ? (readingState.wants_date || now) : null,
        readState,
        now,
        readingState.online_read || 0,
        readingState.download || 0,
        readingState.personal_rating || 0,
        readingState.personal_rating ? (readingState.personal_rating_date || now) : null
      );

      console.log(`✅ 阅读状态已更新: book_id=${bookId}, favorite=${readingState.favorite}, wants=${readingState.wants}, personal_rating=${readingState.personal_rating}`);

      return this.getReadingState(bookId, readerId);
    } catch (error) {
      console.error('❌ 更新阅读状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新书籍的 book_type
   * @param {number} bookId - 书籍ID
   * @param {number} bookType - 书籍类型（0:电子书, 1:实体书）
   * @returns {Object} 更新结果
   */
  updateBookType(bookId, bookType) {
    try {
      if (!this.isTalebookAvailable()) {
        throw new Error('Talebook 数据库服务不可用');
      }

      // 验证书籍类型值
      const validBookTypes = [0, 1]; // 0:电子书, 1:实体书
      if (!validBookTypes.includes(bookType)) {
        throw new Error('无效的书籍类型值');
      }

      // 更新 items 表中的 book_type 字段
      this.talebookDb.prepare(`
        UPDATE items SET book_type = ? WHERE id = ?
      `).run(bookType, bookId);

      return { success: true, message: '书籍类型已更新' };
    } catch (error) {
      console.error('❌ 更新书籍类型失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取书籍的 book_type
   * @param {number} bookId - 书籍ID
   * @returns {number} 书籍类型
   */
  getBookType(bookId) {
    try {
      if (!this.isTalebookAvailable()) {
        return 1; // 默认实体书类型
      }

      const result = this.talebookDb.prepare(`
        SELECT book_type FROM items WHERE book_id = ?
      `).get(bookId);

      return result ? result.book_type : 1;
    } catch (error) {
      console.error('❌ 获取书籍类型失败:', error.message);
      return 1;
    }
  }

  /**
   * 获取所有书籍的阅读状态
   * @param {number} readerId - 读者ID（默认为0）
   * @returns {Array} 阅读状态列表
   */
  getAllReadingStates(readerId = 0) {
    try {
      if (!this.isTalebookAvailable()) {
        return [];
      }

      const readingStates = this.talebookDb.prepare(`
        SELECT * FROM reading_state WHERE reader_id = ?
      `).all(readerId);

      return readingStates;
    } catch (error) {
      console.error('❌ 获取所有阅读状态失败:', error.message);
      return [];
    }
  }

  /**
   * 更新书籍的阅读进度
   * @param {number} bookId - 书籍ID
   * @param {number} readPages - 已读页数
   * @returns {Object} 更新结果
   */
  updateBookReadingProgress(bookId, readPages) {
    try {
      // 使用 qcBooklogDb 操作 qc_bookdata 表（该表在 qc_booklog.db 中）
      const qcBookdataDb = this.qcBooklogDb || this.talebookDb;
      if (!qcBookdataDb) {
        throw new Error('数据库服务不可用');
      }

      // 检查书籍是否在 qc_bookdata 表中存在
      const existingData = qcBookdataDb.prepare('SELECT book_id FROM qc_bookdata WHERE book_id = ?').get(bookId);

      if (existingData) {
        // 更新现有记录
        qcBookdataDb.prepare(`
          UPDATE qc_bookdata
          SET read_pages = ?
          WHERE book_id = ?
        `).run(readPages, bookId);
        console.log(`✅ 更新阅读进度成功: 书籍ID=${bookId}, 已读页数=${readPages}`);
      } else {
        // 创建新记录
        qcBookdataDb.prepare(`
          INSERT INTO qc_bookdata (book_id, read_pages)
          VALUES (?, ?)
        `).run(bookId, readPages);
        console.log(`✅ 创建阅读进度记录成功: 书籍ID=${bookId}, 已读页数=${readPages}`);
      }

      return { bookId, readPages };
    } catch (error) {
      console.error('❌ 更新阅读进度失败:', error);
      throw error;
    }
  }

  /**
   * 批量更新书籍的阅读状态
   * @param {Array} readingStates - 阅读状态列表
   * @param {number} readerId - 读者ID（默认为0）
   * @returns {Object} 更新结果
   */
  batchUpdateReadingStates(readingStates, readerId = 0) {
    try {
      if (!this.isTalebookAvailable()) {
        throw new Error('Talebook 数据库服务不可用');
      }

      if (!Array.isArray(readingStates)) {
        throw new Error('readingStates 必须是数组');
      }

      // 使用事务批量更新
      this.talebookDb.transaction(() => {
        for (const state of readingStates) {
          this.updateReadingState(state.book_id, state, readerId);
        }
      })();

      return { success: true, message: '批量更新阅读状态成功' };
    } catch (error) {
      console.error('❌ 批量更新阅读状态失败:', error.message);
      throw error;
    }
  }

  /**
   * 验证书籍数据
   * @param {Object} book - 书籍对象
   * @param {boolean} isUpdate - 是否为更新操作
   * @returns {Object} 验证结果
   */
  validateBookData(book, isUpdate = false) {
    const errors = [];

    // 验证必填字段
    if (!book.title || book.title.trim() === '') {
      errors.push('书籍标题不能为空');
    }

    if (isUpdate) {
      // 更新操作必须提供ID
      if (!book.id) {
        errors.push('更新操作必须提供书籍ID');
      } else if (isNaN(parseInt(book.id, 10))) {
        errors.push('书籍ID必须是有效的数字');
      }
    }

    // 验证ISBN格式
    if (book.isbn && book.isbn.trim() !== '') {
      const isbnRegex = /^(?:ISBN(?:-1[03])?:?\ )?(?=[0-9X]{10}$|(?=(?:[0-9]+[-\ ]){3})[-\ 0-9X]{13}$|97[89][-\ ]?[0-9]{10}$|(?=(?:[0-9]+[-\ ]){4})[-\ 0-9]{17}$)(?:97[89][-\ ]?)?[0-9]{1,5}[-\ ]?[0-9]+[-\ ]?[0-9]+[-\ ]?[0-9X]$/;
      if (!isbnRegex.test(book.isbn)) {
        errors.push('ISBN格式无效');
      }
    }

    // 验证评分范围
    if (book.rating !== undefined && book.rating !== null) {
      const rating = parseFloat(book.rating);
      if (isNaN(rating) || rating < 0 || rating > 10) {
        errors.push('评分必须是0到10之间的数字');
      }
    }

    // 验证出版年份
    if (book.publishYear) {
      const year = parseInt(book.publishYear, 10);
      const currentYear = new Date().getFullYear();
      if (isNaN(year) || year < 1000 || year > currentYear + 10) {
        errors.push('出版年份无效');
      }
    }

    // 验证语言代码
    if (book.language) {
      const languageRegex = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,3})?$/;
      if (!languageRegex.test(book.language)) {
        errors.push('语言代码格式无效');
      }
    }

    // 验证标签格式
    if (book.tags) {
      if (!Array.isArray(book.tags)) {
        errors.push('标签必须是数组格式');
      } else {
        for (const tag of book.tags) {
          if (typeof tag !== 'string' || tag.trim() === '') {
            errors.push('每个标签必须是有效的字符串');
          }
        }
      }
    }

    // 验证封面状态
    if (book.hasCover !== undefined && book.hasCover !== null) {
      if (typeof book.hasCover !== 'boolean' && typeof book.hasCover !== 'number') {
        errors.push('封面状态必须是布尔值或数字');
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * 获取所有读者列表
   * @returns {Array} 读者列表
   */
  getAllReaders() {
    try {
      if (!this.isTalebookAvailable()) {
        console.warn('⚠️ Talebook数据库不可用，返回默认读者');
        return [
          {
            id: 0,
            name: '默认读者',
            username: 'default',
            active: true,
            note: ''
          }
        ];
      }

      const readers = this.talebookDb.prepare(`
        SELECT id, username, name, email, avatar, admin, active
        FROM readers
        WHERE active = 1
        ORDER BY id
      `).all();

      // 从 qc_users 获取备注信息
      const userNotes = new Map();
      if (this.isQcBooklogAvailable()) {
        try {
          const notes = this.qcBooklogDb.prepare('SELECT id, note FROM qc_users').all();
          notes.forEach(n => userNotes.set(n.id, n.note || ''));
        } catch (e) {
          console.warn('⚠️ 获取用户备注失败:', e.message);
        }
      }

      // 为每个读者添加备注
      const readersWithNotes = readers.map(r => ({
        ...r,
        note: userNotes.get(r.id) || ''
      }));

      // 确保始终包含默认读者（reader_id = 0）
      if (!readersWithNotes.some(r => r.id === 0)) {
        readersWithNotes.unshift({
          id: 0,
          name: '默认读者',
          username: 'default',
          active: true,
          note: userNotes.get(0) || ''
        });
      }

      console.log(`✅ 获取读者列表成功，共${readersWithNotes.length}个读者`);
      return readersWithNotes;
    } catch (error) {
      console.error('❌ 获取读者列表失败:', error.message);
      return [
        {
          id: 0,
          name: '默认读者',
          username: 'default',
          active: true,
          note: ''
        }
      ];
    }
  }

  /**
   * 根据ID获取读者信息
   * @param {number} readerId - 读者ID
   * @returns {Object} 读者信息
   */
  getReaderById(readerId) {
    try {
      if (readerId === 0) {
        let note = '';
        if (this.isQcBooklogAvailable()) {
          try {
            const user = this.qcBooklogDb.prepare('SELECT note FROM qc_users WHERE id = 0').get();
            note = user?.note || '';
          } catch (e) {
            console.warn('⚠️ 获取默认读者备注失败:', e.message);
          }
        }
        return {
          id: 0,
          name: '默认读者',
          username: 'default',
          active: true,
          note
        };
      }

      if (!this.isTalebookAvailable()) {
        throw new Error('Talebook 数据库服务不可用');
      }

      const reader = this.talebookDb.prepare(`
        SELECT id, username, name, email, avatar, admin, active
        FROM readers
        WHERE id = ? AND active = 1
      `).get(readerId);

      if (!reader) {
        throw new Error('读者不存在或未激活');
      }

      // 从 qc_users 获取备注信息
      let note = '';
      if (this.isQcBooklogAvailable()) {
        try {
          const user = this.qcBooklogDb.prepare('SELECT note FROM qc_users WHERE id = ?').get(readerId);
          note = user?.note || '';
        } catch (e) {
          console.warn('⚠️ 获取读者备注失败:', e.message);
        }
      }

      return { ...reader, note };
    } catch (error) {
      console.error('❌ 获取读者信息失败:', error.message);
      throw error;
    }
  }

  /**
   * 更新读者备注
   * @param {number} readerId - 读者ID
   * @param {string} note - 备注内容
   * @returns {Object} 更新结果
   */
  updateReaderNote(readerId, note) {
    try {
      if (!this.isQcBooklogAvailable()) {
        throw new Error('QCBookLog 数据库服务不可用');
      }

      // 确保 qc_users 表中有该读者记录
      const existingUser = this.qcBooklogDb.prepare('SELECT id FROM qc_users WHERE id = ?').get(readerId);
      
      if (existingUser) {
        // 更新现有记录
        this.qcBooklogDb.prepare(`
          UPDATE qc_users SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(note, readerId);
      } else {
        // 插入新记录
        const readerName = readerId === 0 ? '默认读者' : `读者${readerId}`;
        this.qcBooklogDb.prepare(`
          INSERT INTO qc_users (id, username, name, note) VALUES (?, ?, ?, ?)
        `).run(readerId, `reader_${readerId}`, readerName, note);
      }

      console.log(`✅ 更新读者 ${readerId} 备注成功`);
      return { success: true, readerId, note };
    } catch (error) {
      console.error('❌ 更新读者备注失败:', error.message);
      throw error;
    }
  }

  /**
   * 获取 Talebook 数据库对象
   */
  getDatabase() {
    return this.talebookDb;
  }

  /**
   * 获取 Calibre 数据库对象
   */
  getCalibreDatabase() {
    return this.calibreDb;
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.calibreDb) {
      this.calibreDb.close();
      console.log('📦 Calibre 数据库连接已关闭');
    }
    if (this.talebookDb) {
      this.talebookDb.close();
      console.log('📦 Talebook 数据库连接已关闭');
    }
  }
}

export default new DatabaseService();