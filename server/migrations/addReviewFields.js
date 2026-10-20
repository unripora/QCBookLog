import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DATA_DIR } from '../utils/paths.js';

const require = createRequire(import.meta.url);
let Database = null;

try {
  const module = require('better-sqlite3');
  Database = module.default || module;
} catch (error) {
  console.error('❌ better-sqlite3 未安装');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function up() {
  console.log('🔄 开始迁移：添加书评相关字段到 qc_comments 表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    const tableInfo = db.prepare("PRAGMA table_info(qc_comments)").all();
    const columnNames = tableInfo.map(col => col.name);

    const fieldsToAdd = [
      { name: 'uuid', sql: 'ALTER TABLE qc_comments ADD COLUMN uuid TEXT' },
      { name: 'title', sql: "ALTER TABLE qc_comments ADD COLUMN title TEXT DEFAULT ''" },
      { name: 'sync_status', sql: "ALTER TABLE qc_comments ADD COLUMN sync_status TEXT DEFAULT 'none'" },
      { name: 'last_synced_at', sql: 'ALTER TABLE qc_comments ADD COLUMN last_synced_at DATETIME' }
    ];

    for (const field of fieldsToAdd) {
      if (columnNames.includes(field.name)) {
        console.log(`✅ ${field.name} 字段已存在，跳过`);
      } else {
        console.log(`📝 添加字段: ${field.name}`);
        db.exec(field.sql);
      }
    }

    console.log('✅ 迁移完成！qc_comments 表已添加书评相关字段');
    console.log('');
    console.log('📋 说明:');
    console.log('  - uuid: 用于跨设备同步的唯一标识');
    console.log('  - title: 书评标题');
    console.log('  - sync_status: 同步状态 (none/pending/synced/failed)');
    console.log('  - last_synced_at: 最后同步时间');
    console.log('  - updated_at: 更新时间');

    db.close();
    return true;

  } catch (error) {
    console.error('❌ 迁移失败:', error);
    db.close();
    return false;
  }
}

export async function down() {
  console.log('🔄 回滚迁移：移除 qc_comments 表的书评相关字段...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('foreign_keys = OFF');

    const tableInfo = db.prepare("PRAGMA table_info(qc_comments)").all();
    const columnNames = tableInfo.map(col => col.name);

    const fieldsToRemove = ['uuid', 'title', 'sync_status', 'last_synced_at'];
    const hasFields = fieldsToRemove.some(f => columnNames.includes(f));

    if (!hasFields) {
      console.log('✅ 书评相关字段不存在，无需回滚');
      db.close();
      return true;
    }

    const existingData = db.prepare('SELECT * FROM qc_comments').all();

    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_comments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES qc_bookdata(book_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES qc_users(id) ON DELETE CASCADE
      );
    `);

    const insertStmt = db.prepare(`
      INSERT INTO qc_comments_new (id, book_id, user_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const migrateTransaction = db.transaction(() => {
      for (const row of existingData) {
        insertStmt.run(
          row.id,
          row.book_id,
          row.user_id,
          row.content,
          row.created_at
        );
      }
    });

    migrateTransaction();

    db.exec(`
      DROP TABLE qc_comments;
      ALTER TABLE qc_comments_new RENAME TO qc_comments;
    `);

    console.log('✅ 回滚完成');
    db.close();
    return true;

  } catch (error) {
    console.error('❌ 回滚失败:', error);
    db.close();
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
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
    console.log('用法: node addReviewFields.js [up|down]');
    process.exit(1);
  }
}

export default { up, down };
