import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DATA_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function up() {
  console.log('🔄 开始创建用户设置和图片表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    console.log('📝 创建用户设置表 (qc_user_settings)...');
    db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_user_settings_user_id ON qc_user_settings(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_settings_key ON qc_user_settings(setting_key);
      CREATE INDEX IF NOT EXISTS idx_user_settings_priority ON qc_user_settings(priority);
    `);
    console.log('  ✅ qc_user_settings 表创建成功');

    console.log('📝 创建用户图片表 (qc_user_images)...');
    db.exec(`
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
      );

      CREATE INDEX IF NOT EXISTS idx_user_images_user_id ON qc_user_images(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_images_type ON qc_user_images(image_type);
      CREATE INDEX IF NOT EXISTS idx_user_images_sort ON qc_user_images(user_id, image_type, sort_order);
    `);
    console.log('  ✅ qc_user_images 表创建成功');

    console.log('🎉 用户设置和图片表创建完成!');
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
  console.log('🔄 回滚: 删除用户设置和图片表...');

  const db = new Database(DB_PATH);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    console.log('🗑️  删除用户图片表...');
    db.exec('DROP TABLE IF EXISTS qc_user_images');
    console.log('  ✅ qc_user_images 表已删除');

    console.log('🗑️  删除用户设置表...');
    db.exec('DROP TABLE IF EXISTS qc_user_settings');
    console.log('  ✅ qc_user_settings 表已删除');

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
    console.log('用法: node addUserSettingsTables.js [up|down]');
    process.exit(1);
  }
}

export default { up, down };
