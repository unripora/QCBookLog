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
  console.log('🔄 开始迁移：添加 library_uuid 字段到 qc_book_mapping 表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    const tableInfo = db.prepare("PRAGMA table_info(qc_book_mapping)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (columnNames.includes('library_uuid')) {
      console.log('✅ library_uuid 字段已存在，跳过迁移');
      db.close();
      return true;
    }

    console.log('📝 步骤 1: 备份现有数据...');
    const existingData = db.prepare('SELECT * FROM qc_book_mapping').all();
    console.log(`  找到 ${existingData.length} 条现有映射记录`);

    console.log('📝 步骤 2: 创建新的映射表结构...');
    db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_mapping_new_library ON qc_book_mapping_new(library_uuid);
      CREATE INDEX IF NOT EXISTS idx_mapping_new_calibre ON qc_book_mapping_new(calibre_book_id);
    `);

    console.log('📝 步骤 3: 迁移现有数据（标记为未知库）...');
    const insertStmt = db.prepare(`
      INSERT INTO qc_book_mapping_new (id, library_uuid, calibre_book_id, talebook_book_id, created_at, updated_at)
      VALUES (?, '', ?, ?, ?, ?)
    `);

    const migrateTransaction = db.transaction(() => {
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
    console.log(`  已迁移 ${existingData.length} 条记录`);

    console.log('📝 步骤 4: 替换旧表...');
    db.exec(`
      DROP TABLE qc_book_mapping;
      ALTER TABLE qc_book_mapping_new RENAME TO qc_book_mapping;
    `);

    console.log('📝 步骤 5: 创建索引...');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mapping_library ON qc_book_mapping(library_uuid);
      CREATE INDEX IF NOT EXISTS idx_mapping_calibre ON qc_book_mapping(calibre_book_id);
      CREATE INDEX IF NOT EXISTS idx_mapping_library_calibre ON qc_book_mapping(library_uuid, calibre_book_id);
    `);

    console.log('📝 步骤 6: 更新 qc_bookdata 表的外键约束...');
    try {
      const bookdataExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qc_bookdata'").get();
      if (bookdataExists) {
        const bookdataInfo = db.prepare('PRAGMA table_info(qc_bookdata)').all();
        console.log(`  qc_bookdata 表存在，共 ${bookdataInfo.length} 个字段`);
      }
    } catch (e) {
      console.log('  ⚠️ 检查 qc_bookdata 表时出错:', e.message);
    }

    console.log('✅ 迁移完成！qc_book_mapping 表已添加 library_uuid 字段');
    console.log('');
    console.log('📋 说明:');
    console.log('  - 现有数据的 library_uuid 默认为空字符串');
    console.log('  - 首次连接 Calibre 库时，会自动更新 library_uuid');
    console.log('  - 切换不同的 Calibre 库时，数据将自动隔离');

    db.close();
    return true;

  } catch (error) {
    console.error('❌ 迁移失败:', error);
    db.close();
    return false;
  }
}

export async function down() {
  console.log('🔄 回滚迁移：移除 library_uuid 字段...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('foreign_keys = OFF');

    const existingData = db.prepare('SELECT * FROM qc_book_mapping').all();

    db.exec(`
      CREATE TABLE IF NOT EXISTS qc_book_mapping_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calibre_book_id INTEGER NOT NULL UNIQUE,
        talebook_book_id INTEGER NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const insertStmt = db.prepare(`
      INSERT INTO qc_book_mapping_old (id, calibre_book_id, talebook_book_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const migrateTransaction = db.transaction(() => {
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

    db.exec(`
      DROP TABLE qc_book_mapping;
      ALTER TABLE qc_book_mapping_old RENAME TO qc_book_mapping;
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
    console.log('用法: node addLibraryUuid.js [up|down]');
    process.exit(1);
  }
}

export default { up, down };
