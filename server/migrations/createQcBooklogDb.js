import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DATA_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function up() {
  console.log('🔄 开始创建 QCBookLog 独立数据库...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    console.log('📝 创建书籍映射表 (qc_book_mapping)...');
    db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_mapping_library ON qc_book_mapping(library_uuid);
      CREATE INDEX IF NOT EXISTS idx_mapping_calibre ON qc_book_mapping(calibre_book_id);
      CREATE INDEX IF NOT EXISTS idx_mapping_library_calibre ON qc_book_mapping(library_uuid, calibre_book_id);
    `);
    console.log('  ✅ qc_book_mapping 表创建成功');

    console.log('📝 创建用户表 (qc_users)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        name TEXT,
        email TEXT,
        avatar TEXT,
        admin INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON qc_users(username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON qc_users(email);
    `);
    console.log('  ✅ qc_users 表创建成功');

    console.log('📝 创建分组表 (qc_groups)...');
    db.exec(`
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
    db.exec(`
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
    db.exec(`
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
    console.log('  ✅ qc_bookdata 表创建成功 (含 book_type 与 source 字段)');

    console.log('📝 创建书摘表 (qc_bookmarks)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        book_title TEXT,
        book_author TEXT,
        content TEXT NOT NULL,
        note TEXT,
        page_number INTEGER,
        chapter TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON qc_bookmarks(book_id);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON qc_bookmarks(created_at);
    `);
    console.log('  ✅ qc_bookmarks 表创建成功');

    console.log('📝 创建书摘标签关联表 (qc_bookmark_tags)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_bookmark_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bookmark_id INTEGER NOT NULL,
        tag_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bookmark_id) REFERENCES qc_bookmarks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_bookmark_tags_bookmark_id ON qc_bookmark_tags(bookmark_id);
      CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag_id ON qc_bookmark_tags(tag_id);
    `);
    console.log('  ✅ qc_bookmark_tags 表创建成功');

    console.log('📝 创建书籍分组关联表 (qc_book_groups)...');
    db.exec(`
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
    db.exec(`
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_reading_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        reader_id INTEGER NOT NULL DEFAULT 0,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        duration INTEGER NOT NULL,
        start_page INTEGER NOT NULL DEFAULT 0,
        end_page INTEGER NOT NULL DEFAULT 0,
        pages_read INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE,
        FOREIGN KEY (reader_id) REFERENCES qc_users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_reading_book_reader ON qc_reading_records(book_id, reader_id);
      CREATE INDEX IF NOT EXISTS idx_reading_date ON qc_reading_records(start_time);
      CREATE INDEX IF NOT EXISTS idx_reading_reader_date ON qc_reading_records(reader_id, start_time);
    `);
    console.log('  ✅ qc_reading_records 表创建成功');

    console.log('📝 创建每日阅读统计表 (qc_daily_reading_stats)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_daily_reading_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id INTEGER NOT NULL DEFAULT 0,
        date DATE NOT NULL,
        total_books INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        total_time INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reader_id, date),
        FOREIGN KEY (reader_id) REFERENCES qc_users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_daily_stats_reader_date ON qc_daily_reading_stats(reader_id, date);
    `);
    console.log('  ✅ qc_daily_reading_stats 表创建成功');

    console.log('📝 创建阅读目标表 (qc_reading_goals)...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_reading_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id INTEGER NOT NULL DEFAULT 0,
        year INTEGER NOT NULL,
        target INTEGER NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reader_id, year),
        FOREIGN KEY (reader_id) REFERENCES qc_users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_reading_goals_reader_year ON qc_reading_goals(reader_id, year);
    `);
    console.log('  ✅ qc_reading_goals 表创建成功');

    console.log('📝 创建评论表 (qc_comments)...');
    db.exec(`
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_wishlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reader_id INTEGER NOT NULL DEFAULT 0,
        isbn TEXT NOT NULL,
        title TEXT,
        author TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(reader_id, isbn)
      );

      CREATE INDEX IF NOT EXISTS idx_wishlist_reader_id ON qc_wishlist(reader_id);
      CREATE INDEX IF NOT EXISTS idx_wishlist_isbn ON qc_wishlist(isbn);
    `);
    console.log('  ✅ qc_wishlist 表创建成功');

    console.log('🎉 QCBookLog 独立数据库创建完成!');
    console.log(`📁 数据库路径: ${DB_PATH}`);

    db.close();
    return true;

  } catch (error) {
    console.error('❌ 创建数据库失败:', error);
    db.close();
    return false;
  }
}

export async function down() {
  console.log('🔄 回滚: 删除 QCBookLog 独立数据库...');

  try {
    const fs = await import('fs');
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
      console.log('✅ 数据库已删除');
      return true;
    } else {
      console.log('⚠️ 数据库不存在');
      return true;
    }
  } catch (error) {
    console.error('❌ 删除数据库失败:', error);
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
    console.log('用法: node createQcBooklogDb.js [up|down]');
    process.exit(1);
  }
}

export default { up, down };