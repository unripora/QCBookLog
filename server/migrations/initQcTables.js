/**
 * 数据迁移脚本
 * 将本地JSON文件中的数据迁移到Talebook数据库
 */

import path from 'path';
import fs from 'fs/promises';
import databaseService from '../services/legacy/databaseService.js';
import qcDataService from '../services/legacy/qcDataService.js';
import { DATA_DIR } from '../utils/paths.js';

/**
 * 数据迁移类
 */
class DataMigration {
  constructor() {
    this.dataDir = DATA_DIR;
  }

  /**
   * 检查Talebook数据库是否可用
   */
  isDatabaseAvailable() {
    return databaseService.isTalebookAvailable();
  }

  /**
   * 从JSON文件读取数据
   */
  async readJsonFile(filePath) {
    try {
      const fullPath = path.join(this.dataDir, filePath);
      const data = await fs.readFile(fullPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`❌ 读取JSON文件 ${filePath} 失败:`, error.message);
      return null;
    }
  }

  /**
   * 迁移分组数据
   */
  async migrateGroups() {
    if (!this.isDatabaseAvailable()) {
      console.warn('⚠️ Talebook数据库不可用，跳过分组数据迁移');
      return { success: false, message: 'Talebook数据库不可用' };
    }

    console.log('🔄 开始迁移分组数据...');
    
    // 读取分组JSON文件
    const groupsJson = await this.readJsonFile('groups/groups.json');
    if (!groupsJson || !Array.isArray(groupsJson)) {
      console.warn('⚠️ 分组JSON文件不存在或格式不正确，跳过迁移');
      return { success: false, message: '分组JSON文件不存在或格式不正确' };
    }
    
    console.log(`📚 从JSON文件读取到 ${groupsJson.length} 个分组`);
    
    // 迁移数据到数据库
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const group of groupsJson) {
      try {
        // 检查分组是否已存在
        const existingGroup = qcDataService.getGroupById(group.id);
        if (existingGroup) {
          skippedCount++;
          continue;
        }
        
        // 创建分组
        qcDataService.createGroup({
          name: group.name,
          description: group.description || ''
        });
        
        migratedCount++;
      } catch (error) {
        console.error(`❌ 迁移分组 ${group.name} 失败:`, error.message);
      }
    }
    
    console.log(`✅ 分组数据迁移完成: 成功迁移 ${migratedCount} 个分组，跳过 ${skippedCount} 个已存在分组`);
    return { success: true, migratedCount, skippedCount };
  }

  /**
   * 迁移书摘数据
   */
  async migrateBookmarks() {
    if (!this.isDatabaseAvailable()) {
      console.warn('⚠️ Talebook数据库不可用，跳过书摘数据迁移');
      return { success: false, message: 'Talebook数据库不可用' };
    }

    console.log('🔄 开始迁移书摘数据...');
    
    // 读取书摘JSON文件
    const bookmarksJson = await this.readJsonFile('bookmarks/bookmarks.json');
    if (!bookmarksJson || !Array.isArray(bookmarksJson)) {
      console.warn('⚠️ 书摘JSON文件不存在或格式不正确，跳过迁移');
      return { success: false, message: '书摘JSON文件不存在或格式不正确' };
    }
    
    console.log(`📚 从JSON文件读取到 ${bookmarksJson.length} 条书摘`);
    
    // 迁移数据到数据库
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const bookmark of bookmarksJson) {
      try {
        // 检查书摘是否已存在
        // 这里简化处理，直接迁移所有书摘
        
        // 创建书摘
        qcDataService.createBookmark({
          book_id: bookmark.bookId,
          content: bookmark.content,
          page: bookmark.page || null
        });
        
        migratedCount++;
      } catch (error) {
        console.error(`❌ 迁移书摘失败:`, error.message);
      }
    }
    
    console.log(`✅ 书摘数据迁移完成: 成功迁移 ${migratedCount} 条书摘，跳过 ${skippedCount} 条已存在书摘`);
    return { success: true, migratedCount, skippedCount };
  }

  /**
   * 执行完整的数据迁移
   */
  async runFullMigration() {
    console.log('🚀 开始执行完整的数据迁移...');
    
    if (!this.isDatabaseAvailable()) {
      console.error('❌ Talebook数据库不可用，无法执行迁移');
      return { success: false, message: 'Talebook数据库不可用' };
    }
    
    // 先迁移分组数据
    const groupResult = await this.migrateGroups();
    
    // 再迁移书摘数据
    const bookmarkResult = await this.migrateBookmarks();
    
    console.log('🎉 数据迁移完成！');
    console.log(`📊 迁移统计:`);
    console.log(`   分组: 成功 ${groupResult.migratedCount} 个, 跳过 ${groupResult.skippedCount} 个`);
    console.log(`   书摘: 成功 ${bookmarkResult.migratedCount} 条, 跳过 ${bookmarkResult.skippedCount} 条`);
    
    return {
      success: groupResult.success && bookmarkResult.success,
      groups: groupResult,
      bookmarks: bookmarkResult
    };
  }

  /**
   * 验证迁移结果
   */
  async verifyMigration() {
    if (!this.isDatabaseAvailable()) {
      console.warn('⚠️ Talebook数据库不可用，无法验证迁移结果');
      return { success: false, message: 'Talebook数据库不可用' };
    }
    
    console.log('🔍 开始验证迁移结果...');
    
    // 验证分组数据
    const groups = qcDataService.getAllGroups();
    console.log(`📊 数据库中共有 ${groups.length} 个分组`);
    
    // 验证书摘数据
    const bookmarks = qcDataService.getAllBookmarks();
    console.log(`📊 数据库中共有 ${bookmarks.length} 条书摘`);
    
    return {
      success: true,
      groupsCount: groups.length,
      bookmarksCount: bookmarks.length
    };
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  const migration = new DataMigration();
  
  // 执行迁移
  migration.runFullMigration()
    .then(result => {
      if (result.success) {
        // 验证迁移结果
        return migration.verifyMigration();
      }
      return { success: false };
    })
    .then(verifyResult => {
      if (verifyResult.success) {
        console.log('✅ 数据迁移和验证都已完成！');
      } else {
        console.error('❌ 数据迁移或验证失败');
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ 数据迁移失败:', error.message);
      console.error(error.stack);
      process.exit(1);
    });
}

export default new DataMigration();