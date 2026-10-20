import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DATA_DIR } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TALEBOOK_DB_PATH = path.join(DATA_DIR, 'talebook/calibre-webserver.db');
const QC_BOOKLOG_DB_PATH = path.join(DATA_DIR, 'qc_booklog.db');

export async function migrate() {
  console.log('🔄 开始数据迁移...');

  const talebookDb = new Database(TALEBOOK_DB_PATH);
  const qcBooklogDb = new Database(QC_BOOKLOG_DB_PATH);

  try {
    talebookDb.pragma('foreign_keys = OFF');
    qcBooklogDb.pragma('foreign_keys = OFF');

    let totalMigrated = 0;
    let migrationDetails = {};

    console.log('\n📝 步骤 1: 迁移书籍映射关系...');
    const books = talebookDb.prepare('SELECT id FROM books').all();
    const items = talebookDb.prepare('SELECT book_id FROM items').all();
    
    const insertMapping = qcBooklogDb.prepare(`
      INSERT OR IGNORE INTO qc_book_mapping (calibre_book_id, talebook_book_id)
      VALUES (?, ?)
    `);
    
    let mappingCount = 0;
    items.forEach(item => {
      insertMapping.run(item.book_id, item.book_id);
      mappingCount++;
    });
    migrationDetails['qc_book_mapping'] = mappingCount;
    totalMigrated += mappingCount;
    console.log(`  ✅ 迁移书籍映射: ${mappingCount} 条`);

    console.log('\n📝 步骤 2: 迁移用户数据...');
    const users = talebookDb.prepare('SELECT * FROM users').all();
    const insertUser = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_users (
        id, username, name, email, avatar, admin, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let userCount = 0;
    users.forEach(user => {
      insertUser.run(
        user.id, user.username, user.name, user.email, user.avatar,
        user.admin || 0, user.active || 1, user.created_at
      );
      userCount++;
    });
    migrationDetails['qc_users'] = userCount;
    totalMigrated += userCount;
    console.log(`  ✅ 迁移用户: ${userCount} 条`);

    console.log('\n📝 步骤 3: 迁移分组数据...');
    const groups = talebookDb.prepare('SELECT * FROM qc_groups').all();
    const insertGroup = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_groups (
        id, name, description, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    
    let groupCount = 0;
    groups.forEach(group => {
      insertGroup.run(
        group.id, group.name, group.description,
        group.created_at, group.updated_at
      );
      groupCount++;
    });
    migrationDetails['qc_groups'] = groupCount;
    totalMigrated += groupCount;
    console.log(`  ✅ 迁移分组: ${groupCount} 条`);

    console.log('\n📝 步骤 4: 迁移标签数据...');
    const tags = talebookDb.prepare('SELECT * FROM qc_tags').all();
    const insertTag = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_tags (
        id, name, created_at, updated_at
      ) VALUES (?, ?, ?, ?)
    `);
    
    let tagCount = 0;
    tags.forEach(tag => {
      insertTag.run(
        tag.id, tag.name, tag.created_at, tag.updated_at
      );
      tagCount++;
    });
    migrationDetails['qc_tags'] = tagCount;
    totalMigrated += tagCount;
    console.log(`  ✅ 迁移标签: ${tagCount} 条`);

    console.log('\n📝 步骤 5: 迁移书籍扩展数据...');
    const bookdata = talebookDb.prepare('SELECT * FROM qc_bookdata').all();
    const insertBookdata = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_bookdata (
        book_id, page_count, standard_price, purchase_price, purchase_date,
        binding1, binding2, paper1, edge1, edge2, note,
        total_reading_time, read_pages, reading_count, last_read_date, last_read_duration,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let bookdataCount = 0;
    bookdata.forEach(data => {
      insertBookdata.run(
        data.book_id, data.page_count, data.standard_price, data.purchase_price, data.purchase_date,
        data.binding1, data.binding2, data.paper1, data.edge1, data.edge2, data.note,
        data.total_reading_time, data.read_pages, data.reading_count, data.last_read_date, data.last_read_duration,
        data.created_at || new Date().toISOString(),
        data.updated_at || new Date().toISOString()
      );
      bookdataCount++;
    });
    migrationDetails['qc_bookdata'] = bookdataCount;
    totalMigrated += bookdataCount;
    console.log(`  ✅ 迁移书籍扩展数据: ${bookdataCount} 条`);

    console.log('\n📝 步骤 6: 迁移书摘数据...');
    const bookmarks = talebookDb.prepare('SELECT * FROM qc_bookmarks').all();
    const insertBookmark = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_bookmarks (
        id, book_id, book_title, book_author, content, note, page,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let bookmarkCount = 0;
    bookmarks.forEach(bm => {
      insertBookmark.run(
        bm.id, bm.book_id, bm.book_title, bm.book_author,
        bm.content, bm.note, bm.page,
        bm.created_at, bm.updated_at
      );
      bookmarkCount++;
    });
    migrationDetails['qc_bookmarks'] = bookmarkCount;
    totalMigrated += bookmarkCount;
    console.log(`  ✅ 迁移书摘: ${bookmarkCount} 条`);

    console.log('\n📝 步骤 7: 迁移书摘标签关联数据...');
    const bookmarkTags = talebookDb.prepare('SELECT * FROM qc_bookmark_tags').all();
    const insertBookmarkTag = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_bookmark_tags (
        id, bookmark_id, tag_id, tag_name, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    
    let bookmarkTagCount = 0;
    bookmarkTags.forEach(bt => {
      insertBookmarkTag.run(
        bt.id, bt.bookmark_id, bt.tag_id, bt.tag_name, bt.created_at
      );
      bookmarkTagCount++;
    });
    migrationDetails['qc_bookmark_tags'] = bookmarkTagCount;
    totalMigrated += bookmarkTagCount;
    console.log(`  ✅ 迁移书摘标签关联: ${bookmarkTagCount} 条`);

    console.log('\n📝 步骤 8: 迁移书籍分组关联数据...');
    const bookGroups = talebookDb.prepare('SELECT * FROM qc_book_groups').all();
    const insertBookGroup = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_book_groups (
        id, book_id, group_id, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    
    let bookGroupCount = 0;
    bookGroups.forEach(bg => {
      insertBookGroup.run(
        bg.id, bg.book_id, bg.group_id, bg.created_at
      );
      bookGroupCount++;
    });
    migrationDetails['qc_book_groups'] = bookGroupCount;
    totalMigrated += bookGroupCount;
    console.log(`  ✅ 迁移书籍分组关联: ${bookGroupCount} 条`);

    console.log('\n📝 步骤 9: 迁移书籍标签关联数据...');
    const bookTags = talebookDb.prepare('SELECT * FROM qc_book_tags').all();
    const insertBookTag = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_book_tags (
        id, book_id, tag_name, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    
    let bookTagCount = 0;
    bookTags.forEach(bt => {
      insertBookTag.run(
        bt.id, bt.book_id, bt.tag_name, bt.created_at
      );
      bookTagCount++;
    });
    migrationDetails['qc_book_tags'] = bookTagCount;
    totalMigrated += bookTagCount;
    console.log(`  ✅ 迁移书籍标签关联: ${bookTagCount} 条`);

    console.log('\n📝 步骤 10: 迁移阅读记录数据...');
    const readingRecords = talebookDb.prepare('SELECT * FROM qc_reading_records').all();
    const insertReadingRecord = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_reading_records (
        id, book_id, reader_id, start_time, end_time, duration,
        start_page, end_page, pages_read, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let readingRecordCount = 0;
    readingRecords.forEach(rec => {
      insertReadingRecord.run(
        rec.id, rec.book_id, rec.reader_id, rec.start_time, rec.end_time, rec.duration,
        rec.start_page, rec.end_page, rec.pages_read, rec.notes || rec.note, rec.created_at
      );
      readingRecordCount++;
    });
    migrationDetails['qc_reading_records'] = readingRecordCount;
    totalMigrated += readingRecordCount;
    console.log(`  ✅ 迁移阅读记录: ${readingRecordCount} 条`);

    console.log('\n📝 步骤 11: 迁移每日阅读统计数据...');
    const dailyStats = talebookDb.prepare('SELECT * FROM qc_daily_reading_stats').all();
    const insertDailyStats = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_daily_reading_stats (
        id, reader_id, date, total_books, total_pages, total_time,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let dailyStatsCount = 0;
    dailyStats.forEach(stat => {
      insertDailyStats.run(
        stat.id, stat.reader_id, stat.date, stat.total_books, stat.total_pages, stat.total_time,
        stat.created_at, stat.updated_at
      );
      dailyStatsCount++;
    });
    migrationDetails['qc_daily_reading_stats'] = dailyStatsCount;
    totalMigrated += dailyStatsCount;
    console.log(`  ✅ 迁移每日阅读统计: ${dailyStatsCount} 条`);

    console.log('\n📝 步骤 12: 迁移阅读目标数据...');
    const readingGoals = talebookDb.prepare('SELECT * FROM reading_goals').all();
    const insertReadingGoal = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_reading_goals (
        id, reader_id, year, target, completed,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    let readingGoalCount = 0;
    readingGoals.forEach(goal => {
      insertReadingGoal.run(
        goal.id, goal.reader_id, goal.year, goal.target, goal.completed,
        goal.created_at, goal.updated_at
      );
      readingGoalCount++;
    });
    migrationDetails['qc_reading_goals'] = readingGoalCount;
    totalMigrated += readingGoalCount;
    console.log(`  ✅ 迁移阅读目标: ${readingGoalCount} 条`);

    console.log('\n📝 步骤 13: 迁移评论数据...');
    const comments = talebookDb.prepare('SELECT * FROM comments').all();
    const insertComment = qcBooklogDb.prepare(`
      INSERT OR REPLACE INTO qc_comments (
        id, book_id, user_id, content, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    
    let commentCount = 0;
    comments.forEach(comment => {
      insertComment.run(
        comment.id, comment.item_id || comment.book_id, comment.user_id,
        comment.content, comment.created
      );
      commentCount++;
    });
    migrationDetails['qc_comments'] = commentCount;
    totalMigrated += commentCount;
    console.log(`  ✅ 迁移评论: ${commentCount} 条`);

    console.log('\n🎉 数据迁移完成!');
    console.log(`📊 迁移统计:`);
    console.log(`   总计: ${totalMigrated} 条记录`);
    console.log(`\n📋 详细统计:`);
    Object.entries(migrationDetails).forEach(([table, count]) => {
      console.log(`   ${table}: ${count} 条`);
    });

    talebookDb.close();
    qcBooklogDb.close();

    return { success: true, totalMigrated, migrationDetails };

  } catch (error) {
    console.error('❌ 数据迁移失败:', error);
    talebookDb.close();
    qcBooklogDb.close();
    return { success: false, error: error.message };
  }
}

export async function verify() {
  console.log('🔍 开始验证迁移结果...');

  const talebookDb = new Database(TALEBOOK_DB_PATH);
  const qcBooklogDb = new Database(QC_BOOKLOG_DB_PATH);

  try {
    const tables = [
      'qc_book_mapping',
      'qc_users',
      'qc_groups',
      'qc_tags',
      'qc_bookdata',
      'qc_bookmarks',
      'qc_bookmark_tags',
      'qc_book_groups',
      'qc_book_tags',
      'qc_reading_records',
      'qc_daily_reading_stats',
      'qc_reading_goals',
      'qc_comments'
    ];

    console.log('\n📊 数据对比:');
    let allMatch = true;

    tables.forEach(tableName => {
      const talebookCount = talebookDb.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get().count;
      const qcCount = qcBooklogDb.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get().count;
      
      const match = talebookCount === qcCount;
      const status = match ? '✅' : '❌';
      
      console.log(`  ${status} ${tableName}: Talebook=${talebookCount}, QCBooklog=${qcCount}`);
      
      if (!match) {
        allMatch = false;
      }
    });

    console.log('\n🔍 外键完整性检查:');
    const foreignKeyChecks = [
      { table: 'qc_bookdata', fk: 'book_id', ref: 'qc_book_mapping', refField: 'calibre_book_id' },
      { table: 'qc_bookmarks', fk: 'book_id', ref: 'qc_bookdata', refField: 'book_id' },
      { table: 'qc_reading_records', fk: 'book_id', ref: 'qc_bookdata', refField: 'book_id' }
    ];

    foreignKeyChecks.forEach(check => {
      const invalidCount = qcBooklogDb.prepare(`
        SELECT COUNT(*) as count FROM ${check.table} t
        LEFT JOIN ${check.ref} r ON t.${check.fk} = r.${check.refField}
        WHERE r.${check.refField} IS NULL
      `).get().count;

      const status = invalidCount === 0 ? '✅' : '❌';
      console.log(`  ${status} ${check.table}.${check.fk} -> ${check.ref}.${check.refField}: ${invalidCount} 条无效记录`);
      
      if (invalidCount > 0) {
        allMatch = false;
      }
    });

    talebookDb.close();
    qcBooklogDb.close();

    if (allMatch) {
      console.log('\n✅ 验证通过: 所有数据迁移正确!');
    } else {
      console.log('\n❌ 验证失败: 发现数据不一致!');
    }

    return { success: allMatch };

  } catch (error) {
    console.error('❌ 验证失败:', error);
    talebookDb.close();
    qcBooklogDb.close();
    return { success: false, error: error.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const action = args[0] || 'migrate';

  if (action === 'migrate') {
    migrate().then(result => {
      if (result.success) {
        console.log('\n🔍 开始验证...');
        verify().then(verifyResult => {
          process.exit(verifyResult.success ? 0 : 1);
        });
      } else {
        process.exit(1);
      }
    });
  } else if (action === 'verify') {
    verify().then(result => {
      process.exit(result.success ? 0 : 1);
    });
  } else {
    console.error('❌ 未知操作:', action);
    console.log('用法: node migrateToQcBooklog.js [migrate|verify]');
    process.exit(1);
  }
}

export default { migrate, verify };