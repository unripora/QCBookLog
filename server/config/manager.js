import { EventEmitter } from 'events';
import path from 'path';
import fsSync from 'fs';
import { createRequire } from 'module';
import { PROJECT_ROOT, DATA_DIR } from '../utils/paths.js';

const require = createRequire(import.meta.url);
let Database = null;
try {
  const module = require('better-sqlite3');
  Database = module.default || module;
} catch (error) {
  // better-sqlite3 未安装，数据库配置读取不可用
}

const ENV_MAPPING = {
  calibrePath: 'CALIBRE_DB_PATH',
  talebookPath: 'TALEBOOK_DB_PATH',
  qcBooklogPath: 'QCBOOKLOG_DB_PATH',
  calibreDir: 'CALIBRE_DIR',
  talebookDir: 'TALEBOOK_DIR',
  tanshuApiKey: 'TANSHU_API_KEY',
  doubanApiKey: 'DOUBAN_API_KEY',
  isbnWorkApiKey: 'ISBN_WORK_API_KEY',
  syncInterval: 'SYNC_INTERVAL',
  port: 'PORT',
  nodeEnv: 'NODE_ENV'
};

class ConfigManager extends EventEmitter {
  constructor() {
    super();
    this._config = null;
  }

  loadConfig() {
    this._config = {
      calibrePath: process.env.CALIBRE_DB_PATH || null,
      talebookPath: process.env.TALEBOOK_DB_PATH || null,
      qcBooklogPath: process.env.QCBOOKLOG_DB_PATH || null,
      calibreDir: process.env.CALIBRE_DIR || null,
      talebookDir: process.env.TALEBOOK_DIR || null,
      tanshuApiKey: process.env.TANSHU_API_KEY || '',
      doubanApiKey: process.env.DOUBAN_API_KEY || '',
      isbnWorkApiKey: process.env.ISBN_WORK_API_KEY || '',
      syncInterval: parseInt(process.env.SYNC_INTERVAL) || 300000,
      port: parseInt(process.env.PORT) || 7401,
      nodeEnv: process.env.NODE_ENV || 'production'
    };

    // 从 QCBookLog 数据库读取书源 key，优先级高于环境变量
    const dbKeys = this.loadBookSourceKeysFromDb();
    for (const [key, value] of Object.entries(dbKeys)) {
      if (value && value.trim && value.trim() !== '') {
        this._config[key] = value;
      }
    }

    return this._config;
  }

  loadConfigSync() {
    return this.loadConfig();
  }

  async saveConfig(newConfig) {
    const oldConfig = { ...this._config };

    this._config = { ...this._config, ...newConfig };

    // 持久化书源 API Key 到数据库
    const sourceKeyFields = ['tanshuApiKey', 'doubanApiKey', 'isbnWorkApiKey'];
    const sourceKeys = {};
    for (const key of sourceKeyFields) {
      if (newConfig[key] !== undefined) {
        sourceKeys[key] = newConfig[key] || '';
      }
    }
    if (Object.keys(sourceKeys).length > 0) {
      this.saveBookSourceKeysToDb(sourceKeys);
    }

    this.emit('configChanged', {
      oldConfig,
      newConfig: this._config,
      changes: this._getChanges(oldConfig, newConfig)
    });

    console.log('✅ 配置已更新（运行时）');
    return this._config;
  }

  _getChanges(oldConfig, newConfig) {
    const changes = [];
    for (const key of Object.keys(newConfig)) {
      if (oldConfig[key] !== newConfig[key]) {
        changes.push({ key, oldValue: oldConfig[key], newValue: newConfig[key] });
      }
    }
    return changes;
  }

  get config() {
    return this._config || this.loadConfigSync();
  }

  /**
   * 获取 QCBookLog 数据库路径
   */
  getQcBooklogPath() {
    const config = this.config;
    const projectRoot = PROJECT_ROOT;
    const defaultPath = path.join(DATA_DIR, 'qc_booklog.db');
    let dbPath = config.qcBooklogPath || process.env.QCBOOKLOG_DB_PATH || defaultPath;
    if (!path.isAbsolute(dbPath)) {
      dbPath = path.resolve(projectRoot, dbPath);
    }
    return dbPath;
  }

  /**
   * 从 QCBookLog 数据库读取书源 API Key
   */
  loadBookSourceKeysFromDb() {
    if (!Database) return {};

    try {
      const dbPath = this.getQcBooklogPath();
      if (!fsSync.existsSync(dbPath)) {
        return {};
      }

      const db = new Database(dbPath);
      // 检查表是否存在
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='qc_book_source_settings'"
      ).get();
      if (!tableInfo) {
        db.close();
        return {};
      }

      const rows = db.prepare(
        'SELECT source_key, api_key FROM qc_book_source_settings WHERE api_key IS NOT NULL AND api_key != \'\''
      ).all();
      db.close();

      const keys = {};
      const keyMap = {
        tanshu: 'tanshuApiKey',
        douban: 'doubanApiKey',
        isbnWork: 'isbnWorkApiKey'
      };
      for (const row of rows) {
        const configKey = keyMap[row.source_key];
        if (configKey) {
          keys[configKey] = row.api_key;
        }
      }
      return keys;
    } catch (error) {
      console.warn('⚠️ 从数据库读取书源 API Key 失败:', error.message);
      return {};
    }
  }

  /**
   * 保存书源 API Key 到 QCBookLog 数据库
   */
  saveBookSourceKeysToDb(keys) {
    if (!Database) return false;

    try {
      const dbPath = this.getQcBooklogPath();
      if (!fsSync.existsSync(dbPath)) {
        console.warn('⚠️ QCBookLog 数据库文件不存在，无法保存书源设置');
        return false;
      }

      const db = new Database(dbPath);
      const keyMap = {
        tanshuApiKey: 'tanshu',
        doubanApiKey: 'douban',
        isbnWorkApiKey: 'isbnWork'
      };

      const stmt = db.prepare(`
        INSERT INTO qc_book_source_settings (source_key, source_name, api_key, is_required, description, sort_order, updated_at)
        VALUES (?, ?, ?, 1, '', 0, CURRENT_TIMESTAMP)
        ON CONFLICT(source_key) DO UPDATE SET
          api_key = excluded.api_key,
          updated_at = CURRENT_TIMESTAMP
      `);

      const sourceNameMap = {
        tanshu: '探数图书',
        douban: '豆瓣图书',
        isbnWork: '公共图书'
      };

      const transaction = db.transaction(() => {
        for (const [configKey, sourceKey] of Object.entries(keyMap)) {
          if (keys[configKey] !== undefined) {
            stmt.run(sourceKey, sourceNameMap[sourceKey], keys[configKey] || '');
          }
        }
      });

      transaction();
      db.close();
      return true;
    } catch (error) {
      console.error('❌ 保存书源 API Key 到数据库失败:', error.message);
      return false;
    }
  }

  getCalibrePath() {
    return this.config?.calibrePath || process.env.CALIBRE_DB_PATH || null;
  }

  getTalebookPath() {
    return this.config?.talebookPath || process.env.TALEBOOK_DB_PATH || null;
  }

  getQcBooklogPath() {
    return this.config?.qcBooklogPath || process.env.QCBOOKLOG_DB_PATH || null;
  }

  getApiKey(type) {
    const keyMap = { tanshu: 'tanshuApiKey', douban: 'doubanApiKey', isbnWork: 'isbnWorkApiKey' };
    return this.config?.[keyMap[type]] || '';
  }
}

export const configManager = new ConfigManager();
export default configManager;
