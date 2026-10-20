/**
 * 豆列书单表迁移脚本
 * 创建 qc_doulist_books / qc_doulist_imports / qc_doulist_import_items
 * 正常情况下应用启动时 connection-manager.js 会自动建表（CREATE TABLE IF NOT EXISTS），
 * 本脚本供手动执行/运维使用。
 *
 * 用法: node server/migrations/addDoulistTables.js [up|down]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DATA_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function up() {
  console.log('🔄 开始创建豆列书单表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    console.log('📝 创建豆列书籍主表 (qc_doulist_books)...');
    db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_doulist_books_enrich ON qc_doulist_books(enrich_status);
    `);
    console.log('  ✅ qc_doulist_books 表创建成功');

    console.log('📝 创建豆列导入批次表 (qc_doulist_imports)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_doulist_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doulist_id TEXT NOT NULL,
        doulist_title TEXT,
        owner TEXT,
        owner_url TEXT,
        total_items INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running',
        category TEXT DEFAULT 'buy',
        last_start INTEGER DEFAULT 0,
        fetched_items INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(doulist_id)
      );

      CREATE INDEX IF NOT EXISTS idx_doulist_imports_status ON qc_doulist_imports(status);
    `);
    console.log('  ✅ qc_doulist_imports 表创建成功');

    console.log('📝 创建豆列关联表 (qc_doulist_import_items)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_doulist_import_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doulist_id TEXT NOT NULL,
        douban_id TEXT NOT NULL,
        added_at TEXT,
        remark TEXT,
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(doulist_id, douban_id)
      );

      CREATE INDEX IF NOT EXISTS idx_doulist_items_doulist ON qc_doulist_import_items(doulist_id);
      CREATE INDEX IF NOT EXISTS idx_doulist_items_douban ON qc_doulist_import_items(douban_id);
    `);
    console.log('  ✅ qc_doulist_import_items 表创建成功');

    console.log('🎉 豆列书单表创建完成!');
    console.log(`📁 数据库路径: ${DB_PATH}`);

    db.close();
    return true;
  } catch (error) {
    console.error('❌ 创建表失败:', error);
    db.close();
    return false;
  }
}

export async function down() {
  console.log('🔄 回滚: 删除豆列书单表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.exec('DROP TABLE IF EXISTS qc_doulist_import_items');
    db.exec('DROP TABLE IF EXISTS qc_doulist_imports');
    db.exec('DROP TABLE IF EXISTS qc_doulist_books');
    console.log('✅ 回滚完成');

    db.close();
    return true;
  } catch (error) {
    console.error('❌ 回滚失败:', error);
    db.close();
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const action = args[0] || 'up';

  if (action === 'up') {
    up().then(success => {
      process.exit(success ? 0 : 1);
    });
  } else if (action === 'down') {
    down().then(success => {
      process.exit(success ? 0 : 1);
    });
  } else {
    console.error('❌ 未知操作:', action);
    console.log('用法: node addDoulistTables.js [up|down]');
    process.exit(1);
  }
}

export default { up, down };
