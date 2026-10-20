/**
 * 清理 qc_reading_records 中由历史 endReading 重复触发造成的重复记录
 * 并同步修复 qc_bookdata.total_reading_time / read_pages / reading_count。
 *
 * 运行：cd server && node migrations/dedupeReadingRecords.js
 */

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DATA_DIR } from '../utils/paths.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3').default || require('better-sqlite3');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 默认数据库路径：统一数据目录下的 qc_booklog.db，可在命令行传参
const dbPathArg = process.argv[2];
const candidates = [
  dbPathArg,
  path.join(DATA_DIR, 'qc_booklog.db')
].filter(Boolean);

let dbPath = null;
for (const p of candidates) {
  try {
    if (p && fs.existsSync(p)) {
      dbPath = p;
      break;
    }
  } catch (_) {}
}
if (!dbPath) {
  console.error('❌ 找不到 qc_booklog.db，可通过命令行参数传入：');
  console.error('   node migrations/dedupeReadingRecords.js <dbPath>');
  process.exit(1);
}

console.log(`📂 使用数据库: ${dbPath}`);
const db = new Database(dbPath);

try {
  db.pragma('foreign_keys = OFF');

  console.log('\n1) 扫描重复记录 (book_id, reader_id, start_time 相同)...');
  const dupGroups = db.prepare(`
    SELECT book_id, reader_id, start_time,
           COUNT(*) as cnt,
           SUM(duration) as total_dur,
           MAX(end_time) as max_end,
           GROUP_CONCAT(id) as ids
    FROM qc_reading_records
    GROUP BY book_id, reader_id, start_time
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `).all();

  console.log(`   发现 ${dupGroups.length} 组重复`);

  if (dupGroups.length === 0) {
    console.log('✅ 没有重复记录，无需清理');
    process.exit(0);
  }

  // 对每组重复：保留最早 id 的记录，删除其余的，并把多余累加的 duration 从 qc_bookdata 扣回
  let removed = 0;
  let adjustedBooks = new Map(); // book_id -> { timeDelta, countDelta }

  const delStmt = db.prepare(`DELETE FROM qc_reading_records WHERE id = ?`);
  const selOne = db.prepare(`SELECT id, duration, pages_read FROM qc_reading_records WHERE id = ?`);

  const txn = db.transaction(() => {
    for (const g of dupGroups) {
      const ids = g.ids.split(',').map(s => parseInt(s, 10)).sort((a, b) => a - b);
      const keepId = ids[0];
      const dropIds = ids.slice(1);
      for (const dropId of dropIds) {
        const r = selOne.get(dropId);
        if (!r) continue;
        // 把被删除记录的 duration / pagesRead / 1 次阅读次数从 bookdata 中扣回
        const key = g.book_id;
        const cur = adjustedBooks.get(key) || { timeDelta: 0, pagesDelta: 0, countDelta: 0 };
        cur.timeDelta -= (r.duration || 0);
        cur.pagesDelta -= (r.pages_read || 0);
        cur.countDelta -= 1;
        adjustedBooks.set(key, cur);

        delStmt.run(dropId);
        removed++;
      }
    }

    // 把调整写回 qc_bookdata
    const upd = db.prepare(`
      UPDATE qc_bookdata
      SET total_reading_time = MAX(0, total_reading_time + ?),
          read_pages = MAX(0, read_pages + ?),
          reading_count = MAX(0, reading_count + ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE book_id = ?
    `);
    for (const [bookId, delta] of adjustedBooks.entries()) {
      upd.run(delta.timeDelta, delta.pagesDelta, delta.countDelta, bookId);
      console.log(`   📊 调整书籍 ${bookId}: 时长 ${delta.timeDelta} 分钟, 页数 ${delta.pagesDelta}, 次数 ${delta.countDelta}`);
    }
  });

  txn();

  console.log(`\n✅ 清理完成：删除 ${removed} 条重复记录`);

  // 同步把 qc_daily_reading_stats 修正：把删除记录对应的 duration / pagesRead 扣回
  console.log('\n2) 同步修正 qc_daily_reading_stats（按 reader_id + date 聚合）...');
  // 先获取被删记录中每本书的剩余总时长作为参考
  // 这里采用"按当前正确的 qc_reading_records 重新聚合覆盖"
  const dailyAgg = db.prepare(`
    SELECT reader_id, DATE(start_time) as d, COUNT(*) as cnt,
           SUM(duration) as dur, SUM(pages_read) as pages
    FROM qc_reading_records
    GROUP BY reader_id, DATE(start_time)
  `).all();

  const updDaily = db.prepare(`
    UPDATE qc_daily_reading_stats
    SET total_time = ?, total_pages = ?, reading_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE reader_id = ? AND date = ?
  `);
  let dailyUpdated = 0;
  for (const r of dailyAgg) {
    const result = updDaily.run(r.dur || 0, r.pages || 0, r.cnt || 0, r.reader_id, r.d);
    if (result.changes > 0) dailyUpdated++;
  }
  console.log(`   修正了 ${dailyUpdated} 条每日统计`);

  console.log('\n✅ 全部完成，请重启服务以使缓存生效');
} catch (err) {
  console.error('❌ 清理失败：', err);
  process.exitCode = 1;
} finally {
  db.close();
}
