import databaseService from './database-service.js';
import fs from 'fs';
import path from 'path';
import { USER_IMAGES_DIR } from '../../utils/paths.js';

class UserImagesService {
  constructor() {
    this.db = null;
    this.maxImages = 6;
    this.uploadDir = USER_IMAGES_DIR;
    this.ensureUploadDir();
  }

  ensureDb() {
    if (!this.db) {
      this.db = databaseService.getQcBooklogDb();
    }
    if (!this.db) {
      throw new Error('数据库不可用');
    }
  }

  ensureUploadDir() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
      console.log('✅ 创建用户图片目录:', this.uploadDir);
    }
  }

  async getImages(userId = 0, imageType = null) {
    this.ensureDb();

    let query = 'SELECT id, user_id, image_type, image_data, image_name, image_size, sort_order, created_at FROM qc_user_images WHERE user_id = ?';
    const params = [userId];

    if (imageType) {
      query += ' AND image_type = ?';
      params.push(imageType);
    }

    query += ' ORDER BY sort_order ASC, created_at ASC';

    const rows = this.db.prepare(query).all(...params);

    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      imageType: row.image_type,
      imageData: row.image_data,
      imageName: row.image_name,
      imageSize: row.image_size,
      sortOrder: row.sort_order,
      createdAt: row.created_at
    }));
  }

  async getImage(userId, imageId) {
    this.ensureDb();

    const row = this.db.prepare(
      'SELECT id, user_id, image_type, image_data, image_name, image_size, sort_order, created_at FROM qc_user_images WHERE user_id = ? AND id = ?'
    ).get(userId, imageId);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.user_id,
      imageType: row.image_type,
      imageData: row.image_data,
      imageName: row.image_name,
      imageSize: row.image_size,
      sortOrder: row.sort_order,
      createdAt: row.created_at
    };
  }

  async uploadImage(userId, imageType, imageData, imageName = null) {
    this.ensureDb();

    const existingImages = await this.getImages(userId, imageType);
    
    if (existingImages.length >= this.maxImages) {
      throw new Error(`最多只能上传 ${this.maxImages} 张图片`);
    }

    const nextSortOrder = existingImages.length;

    const result = this.db.prepare(`
      INSERT INTO qc_user_images (user_id, image_type, image_data, image_name, image_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, imageType, imageData, imageName, imageData.length, nextSortOrder);

    return {
      id: result.lastInsertRowid,
      userId,
      imageType,
      imageData,
      imageName,
      imageSize: imageData.length,
      sortOrder: nextSortOrder
    };
  }

  async deleteImage(userId, imageId) {
    this.ensureDb();

    const image = await this.getImage(userId, imageId);
    if (!image) {
      throw new Error('图片不存在');
    }

    this.db.prepare(
      'DELETE FROM qc_user_images WHERE user_id = ? AND id = ?'
    ).run(userId, imageId);

    await this.reorderImages(userId, image.imageType);

    return true;
  }

  async reorderImages(userId, imageType) {
    this.ensureDb();

    const images = await this.getImages(userId, imageType);
    
    images.forEach((image, index) => {
      this.db.prepare(`
        UPDATE qc_user_images 
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(index, image.id);
    });

    return true;
  }

  async updateSortOrder(userId, imageIds) {
    this.ensureDb();

    imageIds.forEach((imageId, index) => {
      this.db.prepare(`
        UPDATE qc_user_images 
        SET sort_order = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = ? AND id = ?
      `).run(index, userId, imageId);
    });

    return true;
  }

  async getImageCount(userId, imageType = null) {
    this.ensureDb();

    let query = 'SELECT COUNT(*) as count FROM qc_user_images WHERE user_id = ?';
    const params = [userId];

    if (imageType) {
      query += ' AND image_type = ?';
      params.push(imageType);
    }

    const result = this.db.prepare(query).get(...params);
    return result.count;
  }

  async deleteAllImages(userId, imageType = null) {
    this.ensureDb();

    let query = 'DELETE FROM qc_user_images WHERE user_id = ?';
    const params = [userId];

    if (imageType) {
      query += ' AND image_type = ?';
      params.push(imageType);
    }

    this.db.prepare(query).run(...params);

    return true;
  }
}

export default new UserImagesService();
