import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import fsSync from 'fs';
import configManager from '../../config/index.js';
import { DATA_DIR as UNIFIED_DATA_DIR } from '../../utils/paths.js';

export const DATA_DIR = UNIFIED_DATA_DIR;

export const readConfig = async () => {
  return configManager.loadConfig();
};

export const readConfigSync = () => {
  return configManager.loadConfigSync();
};

/**
 * 读取JSON文件
 * @param {string} filePath 文件路径
 * @returns {Promise<any>} 文件内容
 */
export const readJsonFile = async (filePath) => {
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    const data = await fs.readFile(fullPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    throw new Error(`Failed to read file: ${filePath}`);
  }
};

/**
 * 写入JSON文件
 * @param {string} filePath 文件路径
 * @param {any} data 要写入的数据
 * @returns {Promise<void>}
 */
export const writeJsonFile = async (filePath, data) => {
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    const jsonData = JSON.stringify(data, null, 2);
    await fs.writeFile(fullPath, jsonData, 'utf8');
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error);
    throw new Error(`Failed to write file: ${filePath}`);
  }
};

/**
 * 更新JSON文件中的数据项
 * @param {string} filePath 文件路径
 * @param {string} id 数据项ID
 * @param {any} updateData 更新的数据
 * @returns {Promise<any>} 更新后的数据项
 */
export const updateJsonItem = async (filePath, id, updateData) => {
  try {
    const items = await readJsonFile(filePath);
    const index = items.findIndex(item => String(item.id) === String(id));
    
    if (index === -1) {
      throw new Error(`Item with id ${id} not found`);
    }
    
    const updatedItem = { ...items[index], ...updateData, updateTime: new Date().toISOString() };
    items[index] = updatedItem;
    
    await writeJsonFile(filePath, items);
    return updatedItem;
  } catch (error) {
    console.error(`Error updating item in file ${filePath}:`, error);
    throw error;
  }
};

/**
 * 添加JSON文件中的数据项
 * @param {string} filePath 文件路径
 * @param {any} itemData 要添加的数据项
 * @returns {Promise<any>} 添加后的数据项
 */
export const addJsonItem = async (filePath, itemData) => {
  try {
    const items = await readJsonFile(filePath);
    const timestamp = new Date().toISOString();
    
    // 确保生成唯一ID，并且不受itemData中id属性的影响
    const generatedId = uuidv4();
    console.log(`生成的ID: ${generatedId}`);
    
    // 创建新项，确保id属性由我们生成，不受itemData影响
    const newItem = {
      ...itemData,
      id: generatedId,
      createTime: timestamp,
      updateTime: timestamp
    };
    
    items.push(newItem);
    await writeJsonFile(filePath, items);
    return newItem;
  } catch (error) {
    console.error(`Error adding item to file ${filePath}:`, error);
    throw error;
  }
};

/**
 * 删除JSON文件中的数据项
 * @param {string} filePath 文件路径
 * @param {string} id 数据项ID
 * @returns {Promise<void>}
 */
export const deleteJsonItem = async (filePath, id) => {
  try {
    const items = await readJsonFile(filePath);
    const newItems = items.filter(item => String(item.id) !== String(id));
    
    if (newItems.length === items.length) {
      throw new Error(`Item with id ${id} not found`);
    }
    
    await writeJsonFile(filePath, newItems);
  } catch (error) {
    console.error(`Error deleting item from file ${filePath}:`, error);
    throw error;
  }
};

/**
 * 获取JSON文件中的数据项
 * @param {string} filePath 文件路径
 * @param {string} id 数据项ID
 * @returns {Promise<any>} 数据项
 */
export const getJsonItem = async (filePath, id) => {
  try {
    const items = await readJsonFile(filePath);
    const item = items.find(item => String(item.id) === String(id));
    
    if (!item) {
      throw new Error(`Item with id ${id} not found`);
    }
    
    return item;
  } catch (error) {
    console.error(`Error getting item from file ${filePath}:`, error);
    throw error;
  }
};

/**
 * 生成唯一ID
 * @returns {string} 唯一ID
 */
export const generateId = () => uuidv4();

/**
 * 获取当前时间戳
 * @returns {string} ISO格式的时间戳
 */
export const getCurrentTimestamp = () => new Date().toISOString();

/**
 * 检查文件是否存在
 * @param {string} filePath 文件路径
 * @returns {Promise<boolean>} 是否存在
 */
export const fileExists = async (filePath) => {
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * 保存文件
 * @param {Buffer} buffer 文件缓冲区
 * @param {string} destPath 目标路径
 * @returns {Promise<string>} 保存后的文件路径
 */
export const saveFile = async (buffer, destPath) => {
  try {
    const fullPath = path.join(DATA_DIR, destPath);
    await fs.writeFile(fullPath, buffer);
    return fullPath;
  } catch (error) {
    console.error(`Error saving file ${destPath}:`, error);
    throw new Error(`Failed to save file: ${destPath}`);
  }
};

/**
 * 删除文件
 * @param {string} filePath 文件路径
 * @returns {Promise<void>}
 */
export const deleteFile = async (filePath) => {
  try {
    const fullPath = path.join(DATA_DIR, filePath);
    await fs.unlink(fullPath);
  } catch (error) {
    console.error(`Error deleting file ${filePath}:`, error);
    throw new Error(`Failed to delete file: ${filePath}`);
  }
};

/**
 * 复制文件
 * @param {string} srcPath 源路径
 * @param {string} destPath 目标路径
 * @returns {Promise<void>}
 */
export const copyFile = async (srcPath, destPath) => {
  try {
    const fullSrcPath = path.join(DATA_DIR, srcPath);
    const fullDestPath = path.join(DATA_DIR, destPath);
    await fs.copyFile(fullSrcPath, fullDestPath);
  } catch (error) {
    console.error(`Error copying file from ${srcPath} to ${destPath}:`, error);
    throw new Error(`Failed to copy file`);
  }
};

/**
 * 获取目录下的所有文件
 * @param {string} dirPath 目录路径
 * @returns {Promise<string[]>} 文件列表
 */
export const getFilesInDir = async (dirPath) => {
  try {
    const fullDirPath = path.join(DATA_DIR, dirPath);
    const files = await fs.readdir(fullDirPath);
    return files;
  } catch (error) {
    console.error(`Error getting files in directory ${dirPath}:`, error);
    throw new Error(`Failed to get files in directory: ${dirPath}`);
  }
};

/**
 * 更新版本信息
 * @returns {Promise<void>}
 */
export const updateVersionInfo = async () => {
  try {
    // 确保 metadata 目录存在
    const metadataDir = path.join(DATA_DIR, 'metadata');
    try {
      await fs.mkdir(metadataDir, { recursive: true });
    } catch (error) {
      // 目录已存在，忽略错误
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }

    // 尝试读取版本信息，如果文件不存在则创建默认版本信息
    let versionInfo;
    const versionFilePath = path.join(metadataDir, 'version.json');
    
    try {
      versionInfo = await fs.readFile(versionFilePath, 'utf8');
      versionInfo = JSON.parse(versionInfo);
    } catch (error) {
      // 文件不存在，创建默认版本信息
      versionInfo = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString()
      };
    }

    // 更新时间戳
    versionInfo.lastUpdated = new Date().toISOString();
    
    // 写入文件
    await fs.writeFile(versionFilePath, JSON.stringify(versionInfo, null, 2), 'utf8');
  } catch (error) {
    console.error('Error updating version info:', error);
    throw new Error('Failed to update version info');
  }
};

/**
 * 获取数据目录路径
 * @returns {string} 数据目录路径
 */
export const getDataDir = () => DATA_DIR;