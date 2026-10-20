/**
 * 数据库迁移脚本
 * 更新 QCBookLog 数据库结构
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { DATA_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function migrate() {
  console.log('🔄 开始更新 QCBookLog 数据库结构...');

  if (!fs.existsSync(DB_PATH)) {
    console.log('⚠️ 数据库文件不存在，请先运行 createQcBooklogDb.js');
    return false;
  }

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    // 检查并添加 qc_wishlist 表
    const wishlistTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='qc_wishlist'
    `).get();

    if (!wishlistTableExists) {
      console.log('📝 添加愿望清单表 (qc_wishlist)...');
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
      console.log('  ✅ qc_wishlist 表添加成功');
    } else {
      console.log('  ✓ qc_wishlist 表已存在');
    }

    // 检查并添加 qc_bookmarks 表的缺失字段
    const bookmarksInfo = db.pragma('table_info(qc_bookmarks)');
    const bookmarksColumns = bookmarksInfo.map(col => col.name);

    if (!bookmarksColumns.includes('chapter')) {
      console.log('📝 添加 qc_bookmarks.chapter 字段...');
      db.exec('ALTER TABLE qc_bookmarks ADD COLUMN chapter TEXT');
      console.log('  ✅ chapter 字段添加成功');
    }

    if (!bookmarksColumns.includes('user_id')) {
      console.log('📝 添加 qc_bookmarks.user_id 字段...');
      db.exec('ALTER TABLE qc_bookmarks ADD COLUMN user_id INTEGER');
      console.log('  ✅ user_id 字段添加成功');
    }

    // 检查 page 字段是否需要重命名为 page_number
    if (bookmarksColumns.includes('page') && !bookmarksColumns.includes('page_number')) {
      console.log('📝 重命名 qc_bookmarks.page 为 page_number...');
      db.exec('ALTER TABLE qc_bookmarks RENAME COLUMN page TO page_number');
      console.log('  ✅ 字段重命名成功');
    }

    // 检查并添加 qc_bookdata 表的 source 字段
    const bookdataInfo = db.pragma('table_info(qc_bookdata)');
    const bookdataColumns = bookdataInfo.map(col => col.name);

    if (!bookdataColumns.includes('source')) {
      console.log('📝 添加 qc_bookdata.source 字段...');
      db.exec("ALTER TABLE qc_bookdata ADD COLUMN source TEXT DEFAULT ''");
      console.log('  ✅ source 字段添加成功');
    } else {
      console.log('  ✓ qc_bookdata.source 字段已存在');
    }

    console.log('🎉 QCBookLog 数据库更新完成!');

    db.close();
    return true;

  } catch (error) {
    console.error('❌ 更新数据库失败:', error);
    db.close();
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(success => {
    process.exit(success ? 0 : 1);
  });
}

export default { migrate };