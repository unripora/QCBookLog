import databaseService from '../services/legacy/database-service.js';
import calibreService from '../services/legacy/calibreService.js';
import syncService from '../services/sync/syncService.js';
import pathValidator from '../routes/config/validators/path-validator.js';
import configManager from '../config/index.js';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../utils/paths.js';

class ConfigController {
  async getAllConfig(req, res) {
    try {
      const config = configManager.loadConfigSync();
      res.json({
        success: true,
        config: {
          calibrePath: config.calibrePath || '',
          talebookPath: config.talebookPath || '',
          calibreDir: config.calibreDir || '',
          talebookDir: config.talebookDir || '',
          tanshuApiKey: config.tanshuApiKey || '',
          doubanApiKey: config.doubanApiKey || '',
          isbnWorkApiKey: config.isbnWorkApiKey || '',
          syncInterval: config.syncInterval || 300000
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async updateAllConfig(req, res) {
    try {
      const newConfig = req.body;
      console.log('📝 更新配置:', newConfig);
      
      await configManager.saveConfig(newConfig);
      
      if (newConfig.calibrePath) {
        await databaseService.updateCalibreDbPath(newConfig.calibrePath);
        calibreService.updateBookDir();
      }
      
      res.json({
        success: true,
        message: '配置已更新到 .env 文件',
        config: configManager.config
      });
    } catch (error) {
      console.error('❌ 更新配置失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getCalibrePath(req, res) {
    try {
      console.log('📋 [getCalibrePath] 开始获取 Calibre 配置...');
      const config = configManager.loadConfigSync();
      let currentDbPath = config.calibrePath;
      
      if (!currentDbPath && databaseService._initialized) {
        try {
          currentDbPath = databaseService.getDbPath();
        } catch (e) {
          currentDbPath = path.join(DATA_DIR, 'calibre/metadata.db');
        }
      }

      console.log('📋 [getCalibrePath] 数据库路径:', currentDbPath);
      
      const pathExists = currentDbPath ? fs.existsSync(currentDbPath) : false;
      console.log('📋 [getCalibrePath] 文件存在:', pathExists);
      
      let isValid = false;
      let stats = null;
      let validationErrors = [];
      let needsReconfig = false;

      console.log('📋 [getCalibrePath] databaseService._initialized:', databaseService._initialized);
      console.log('📋 [getCalibrePath] connectionManager 存在:', !!databaseService.connectionManager);
      console.log('📋 [getCalibrePath] calibreDb 存在:', !!databaseService.connectionManager?.calibreDb);
      
      const connectionError = databaseService.connectionManager?.getCalibreError();
      console.log('📋 [getCalibrePath] 连接错误:', connectionError);
      
      if (connectionError) {
        validationErrors.push(`数据库连接失败: ${connectionError}`);
        needsReconfig = true;
      }

      if (pathExists && !connectionError) {
        try {
          console.log('📋 [getCalibrePath] 开始验证数据库结构...');
          const result = databaseService.validateCalibreSchema();
          console.log('📋 [getCalibrePath] 验证结果:', result);
          isValid = result.isValid;
          validationErrors = result.errors || [];
          if (isValid) {
            stats = databaseService.getCalibreStats();
          } else {
            needsReconfig = true;
            console.warn('⚠️ Calibre 数据库验证失败:', validationErrors);
          }
        } catch (e) {
          console.warn('❌ Calibre 验证异常:', e.message);
          validationErrors = [e.message];
          needsReconfig = true;
        }
      } else if (currentDbPath && !pathExists) {
        needsReconfig = true;
        validationErrors = ['数据库文件不存在'];
      }

      const response = {
        success: true,
        calibreDbPath: currentDbPath,
        exists: pathExists,
        valid: isValid,
        stats: stats,
        error: validationErrors.length > 0 ? validationErrors.join('; ') : null,
        needsReconfig: needsReconfig
      };
      console.log('📋 [getCalibrePath] 返回响应:', response);
      res.json(response);
    } catch (error) {
      console.error('❌ [getCalibrePath] 错误:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async setCalibrePath(req, res) {
    try {
      const { calibrePath, calibreDir } = req.body;
      const pathParam = calibrePath || calibreDir;
      console.log('📝 设置 Calibre 路径:', pathParam);

      let dbPath = pathParam;
      if (dbPath && !dbPath.endsWith('.db')) {
        dbPath = path.join(dbPath, 'metadata.db');
      }

      const validation = await pathValidator.validateCalibrePath(dbPath);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: validation.errors.join(', ')
        });
      }

      await databaseService.updateCalibreDbPath(dbPath);
      calibreService.updateBookDir();

      try {
        await syncService.syncFromCalibre();
      } catch (syncError) {
        console.warn('⚠️ 同步失败:', syncError.message);
      }

      const calibreDirPath = path.dirname(dbPath);
      const talebookPath = path.join(calibreDirPath, 'calibre-webserver.db');
      
      const newConfig = {
        calibrePath: dbPath,
        calibreDir: calibreDirPath
      };
      
      if (fs.existsSync(talebookPath)) {
        newConfig.talebookPath = talebookPath;
        newConfig.talebookDir = calibreDirPath;
      }
      
      await configManager.saveConfig(newConfig);

      res.json({
        success: true,
        calibreDbPath: dbPath,
        talebookPath: newConfig.talebookPath || null,
        message: 'Calibre 数据库路径已更新'
      });
    } catch (error) {
      console.error('❌ 设置 Calibre 路径失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async validateCalibre(req, res) {
    try {
      const { calibrePath, calibreDir } = req.body;
      const pathParam = calibrePath || calibreDir;

      let dbPath = pathParam;
      if (dbPath && !dbPath.endsWith('.db')) {
        dbPath = path.join(dbPath, 'metadata.db');
      }

      const validation = await pathValidator.validateCalibrePath(dbPath);
      let schemaValid = true;
      let schemaErrors = [];
      
      try {
        const result = databaseService.validateCalibreSchema();
        schemaValid = result.isValid;
        schemaErrors = result.errors;
      } catch (e) {
        schemaValid = false;
        schemaErrors.push(e.message);
      }

      res.json({
        success: schemaValid && validation.isValid,
        pathValid: validation.isValid,
        schemaValid: schemaValid,
        errors: [...validation.errors, ...schemaErrors]
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getTalebookPath(req, res) {
    try {
      console.log('📋 [getTalebookPath] 开始获取 Talebook 配置...');
      const config = configManager.loadConfigSync();
      let currentDbPath = config.talebookPath;
      
      if (!currentDbPath && databaseService._initialized) {
        try {
          currentDbPath = databaseService.getTalebookDbPath();
        } catch (e) {
          currentDbPath = path.join(DATA_DIR, 'talebook/calibre-webserver.db');
        }
      }

      console.log('📋 [getTalebookPath] 数据库路径:', currentDbPath);
      
      const pathExists = currentDbPath ? fs.existsSync(currentDbPath) : false;
      console.log('📋 [getTalebookPath] 文件存在:', pathExists);
      
      let isValid = false;
      let stats = null;
      let validationErrors = [];
      let needsReconfig = false;

      console.log('📋 [getTalebookPath] databaseService._initialized:', databaseService._initialized);
      console.log('📋 [getTalebookPath] connectionManager 存在:', !!databaseService.connectionManager);
      console.log('📋 [getTalebookPath] talebookDb 存在:', !!databaseService.connectionManager?.talebookDb);
      
      const connectionError = databaseService.connectionManager?.getTalebookError();
      console.log('📋 [getTalebookPath] 连接错误:', connectionError);
      
      if (connectionError) {
        validationErrors.push(`数据库连接失败: ${connectionError}`);
        needsReconfig = true;
      }

      if (pathExists && !connectionError) {
        try {
          console.log('📋 [getTalebookPath] 开始验证数据库结构...');
          const result = databaseService.validateTalebookSchema();
          console.log('📋 [getTalebookPath] 验证结果:', result);
          isValid = result.isValid;
          validationErrors = result.errors || [];
          if (isValid) {
            stats = databaseService.getTalebookStats();
          } else {
            needsReconfig = true;
            console.warn('⚠️ Talebook 数据库验证失败:', validationErrors);
          }
        } catch (e) {
          console.warn('❌ Talebook 验证异常:', e.message);
          validationErrors = [e.message];
          needsReconfig = true;
        }
      } else if (currentDbPath && !pathExists) {
        needsReconfig = true;
        validationErrors = ['数据库文件不存在'];
      }

      res.json({
        success: true,
        talebookDbPath: currentDbPath,
        exists: pathExists,
        valid: isValid,
        stats: stats,
        error: validationErrors.length > 0 ? validationErrors.join('; ') : null,
        needsReconfig: needsReconfig
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async setTalebookPath(req, res) {
    try {
      const { talebookPath, talebookDir } = req.body;
      const pathParam = talebookPath || talebookDir;
      console.log('📝 设置 Talebook 路径:', pathParam);

      let dbPath = pathParam;
      if (dbPath && !dbPath.endsWith('.db')) {
        dbPath = path.join(dbPath, 'calibre-webserver.db');
      }

      const validation = await pathValidator.validateTalebookPath(dbPath);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: validation.errors.join(', ')
        });
      }

      await databaseService.updateTalebookDbPath(dbPath);
      
      await configManager.saveConfig({
        talebookPath: dbPath,
        talebookDir: path.dirname(dbPath)
      });

      res.json({
        success: true,
        talebookDbPath: dbPath,
        message: 'Talebook 数据库路径已更新'
      });
    } catch (error) {
      console.error('❌ 设置 Talebook 路径失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async validateTalebook(req, res) {
    try {
      const { talebookPath, talebookDir } = req.body;
      const pathParam = talebookPath || talebookDir;

      let dbPath = pathParam;
      if (dbPath && !dbPath.endsWith('.db')) {
        dbPath = path.join(dbPath, 'calibre-webserver.db');
      }

      const validation = await pathValidator.validateTalebookPath(dbPath);
      let schemaValid = true;
      let schemaErrors = [];
      
      try {
        const result = databaseService.validateTalebookSchema();
        schemaValid = result.isValid;
        schemaErrors = result.errors;
      } catch (e) {
        schemaValid = false;
        schemaErrors.push(e.message);
      }

      res.json({
        success: schemaValid && validation.isValid,
        pathValid: validation.isValid,
        schemaValid: schemaValid,
        errors: [...validation.errors, ...schemaErrors]
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 检测数据库文件状态（只读，不做任何写入）
   * 返回结构化状态码，供前端区分：
   * - ok            文件存在且可读，连接/结构校验通过
   * - not_found     文件或所在目录不存在
   * - no_permission 文件存在但当前进程无读取权限
   * - invalid       文件存在可读，但不是有效/受支持的数据库
   */
  async detectDatabases(req, res) {
    try {
      const calibrePath = databaseService.getDbPath();
      const talebookPath = databaseService.getTalebookDbPath();

      const detectOne = (dbPath, getError, isAvailable) => {
        const result = {
          path: dbPath || '',
          status: 'ok',
          message: ''
        };

        if (!dbPath) {
          result.status = 'not_found';
          result.message = '未配置数据库路径';
          return result;
        }

        let stat = null;
        try {
          stat = fs.statSync(dbPath);
        } catch (e) {
          if (e.code === 'EACCES') {
            result.status = 'no_permission';
            result.message = '无权限访问该路径，请检查容器挂载目录的读取权限';
          } else {
            result.status = 'not_found';
            result.message = '未找到数据库文件，请确认已正确挂载数据目录';
          }
          return result;
        }

        if (!stat.isFile()) {
          result.status = 'invalid';
          result.message = '路径不是一个数据库文件';
          return result;
        }

        try {
          fs.accessSync(dbPath, fs.constants.R_OK);
        } catch (e) {
          result.status = 'no_permission';
          result.message = '数据库文件不可读，请检查文件权限（chmod/chown）';
          return result;
        }

        const connError = getError ? getError() : null;
        if (connError) {
          // 连接层已区分「不存在 / 不可读」，此处按关键字归类，其余归为无效库
          if (/不可读|权限|EACCES|permission/i.test(connError)) {
            result.status = 'no_permission';
            result.message = connError;
          } else if (/不存在|ENOENT/i.test(connError)) {
            result.status = 'not_found';
            result.message = connError;
          } else {
            result.status = 'invalid';
            result.message = connError;
          }
          return result;
        }

        if (isAvailable && !isAvailable()) {
          result.status = 'invalid';
          result.message = '数据库无法连接或结构不完整';
          return result;
        }

        result.message = '数据库已就绪';
        return result;
      };

      const cm = databaseService.connectionManager;
      res.json({
        success: true,
        data: {
          calibre: detectOne(
            calibrePath,
            () => cm?.getCalibreError?.(),
            () => databaseService.isCalibreAvailable()
          ),
          talebook: detectOne(
            talebookPath,
            () => cm?.getTalebookError?.(),
            () => databaseService.isTalebookAvailable()
          )
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ 检测数据库失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async checkDatabases(req, res) {
    try {
      res.json({
        success: true,
        data: {
          calibre: {
            available: databaseService.isCalibreAvailable(),
            valid: databaseService.isCalibreAvailable(),
            path: databaseService.getDbPath()
          },
          talebook: {
            available: databaseService.isTalebookAvailable(),
            valid: databaseService.isTalebookAvailable(),
            path: databaseService.getTalebookDbPath()
          },
          qcBooklog: {
            available: databaseService.isQcBooklogAvailable(),
            valid: databaseService.isQcBooklogAvailable(),
            path: databaseService.getQcBooklogDbPath()
          }
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getSystemStatus(req, res) {
    try {
      res.json({
        calibre: {
          available: databaseService.isCalibreAvailable(),
          path: databaseService.getDbPath()
        },
        talebook: {
          available: databaseService.isTalebookAvailable(),
          path: databaseService.getTalebookDbPath()
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getSyncStatus(req, res) {
    try {
      const syncStatus = await syncService.getSyncStatus();
      res.json({
        success: true,
        status: syncStatus.status,
        message: syncStatus.message,
        data: syncStatus.data
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async createDatabase(req, res) {
    try {
      const { type, path: dbPath, libraryName } = req.body;

      if (!dbPath) {
        return res.status(400).json({
          success: false,
          error: '请提供数据库路径'
        });
      }

      if (!type) {
        return res.status(400).json({
          success: false,
          error: '请提供数据库类型 (calibre 或 talebook)'
        });
      }

      const normalizedPath = dbPath.endsWith('.db') ? dbPath : path.join(dbPath, type === 'calibre' ? 'metadata.db' : 'calibre-webserver.db');

      if (fs.existsSync(normalizedPath)) {
        return res.status(400).json({
          success: false,
          error: '数据库文件已存在: ' + normalizedPath
        });
      }

      let result;
      if (type === 'calibre') {
        result = await databaseService.connectionManager.createNewCalibreDatabase(normalizedPath, libraryName || 'My Library');
      } else if (type === 'talebook') {
        result = await databaseService.connectionManager.createNewTalebookDatabase(normalizedPath);
      } else {
        return res.status(400).json({
          success: false,
          error: '不支持的数据库类型: ' + type
        });
      }

      if (type === 'calibre') {
        await configManager.saveConfig({
          calibrePath: normalizedPath,
          calibreDir: path.dirname(normalizedPath)
        });
      } else if (type === 'talebook') {
        await configManager.saveConfig({
          talebookPath: normalizedPath,
          talebookDir: path.dirname(normalizedPath)
        });
      }

      res.json({
        success: true,
        message: result.message,
        dbPath: result.path,
        libraryUuid: result.libraryUuid
      });
    } catch (error) {
      console.error('❌ 创建数据库失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async setDefault(req, res) {
    try {
      const { type, dbPath } = req.body;

      if (!type || !dbPath) {
        return res.status(400).json({
          success: false,
          error: '请提供数据库类型和路径'
        });
      }

      if (!fs.existsSync(dbPath)) {
        return res.status(400).json({
          success: false,
          error: '数据库文件不存在: ' + dbPath
        });
      }

      if (type === 'calibre') {
        await databaseService.updateCalibreDbPath(dbPath);
        calibreService.updateBookDir();
        await configManager.saveConfig({
          calibrePath: dbPath,
          calibreDir: path.dirname(dbPath)
        });
      } else if (type === 'talebook') {
        await databaseService.updateTalebookDbPath(dbPath);
        await configManager.saveConfig({
          talebookPath: dbPath,
          talebookDir: path.dirname(dbPath)
        });
      } else {
        return res.status(400).json({
          success: false,
          error: '不支持的数据库类型: ' + type
        });
      }

      res.json({
        success: true,
        message: '默认数据库已设置',
        type: type,
        path: dbPath
      });
    } catch (error) {
      console.error('❌ 设置默认数据库失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 获取第三方设置配置
   */
  async getThirdPartyConfig(req, res) {
    try {
      const db = databaseService.getQcBooklogDb();
      
      // 从数据库获取talebook设置
      const talebookEnabled = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookEnabled');
      const talebookLocalUrl = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookLocalUrl');
      const talebookLocalPort = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookLocalPort');
      const talebookRemoteUrl = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookRemoteUrl');
      const talebookRemotePort = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookRemotePort');
      const talebookRemoteUseHttps = db.prepare('SELECT setting_value FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get('talebookRemoteUseHttps');

      const parseValue = (value, type = 'string') => {
        if (!value) return null;
        switch (type) {
          case 'boolean':
            return value === 'true';
          case 'number':
            return parseFloat(value);
          default:
            return value;
        }
      };

      res.json({
        success: true,
        config: {
          talebook: {
            enabled: parseValue(talebookEnabled?.setting_value, 'boolean') || false,
            localUrl: parseValue(talebookLocalUrl?.setting_value) || '',
            localPort: parseValue(talebookLocalPort?.setting_value) || '',
            remoteUrl: parseValue(talebookRemoteUrl?.setting_value) || '',
            remotePort: parseValue(talebookRemotePort?.setting_value) || '',
            remoteUseHttps: parseValue(talebookRemoteUseHttps?.setting_value, 'boolean') || false
          }
        }
      });
    } catch (error) {
      console.error('❌ 获取第三方设置失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * 保存第三方设置配置
   */
  async saveThirdPartyConfig(req, res) {
    try {
      const { talebook } = req.body;
      
      console.log('📝 保存第三方设置:', { talebook });
      
      const db = databaseService.getQcBooklogDb();
      
      // 保存到数据库
      const settings = [
        { key: 'talebookEnabled', value: talebook?.enabled ? 'true' : 'false', type: 'boolean' },
        { key: 'talebookLocalUrl', value: talebook?.localUrl || '', type: 'string' },
        { key: 'talebookLocalPort', value: talebook?.localPort || '', type: 'string' },
        { key: 'talebookRemoteUrl', value: talebook?.remoteUrl || '', type: 'string' },
        { key: 'talebookRemotePort', value: talebook?.remotePort || '', type: 'string' },
        { key: 'talebookRemoteUseHttps', value: talebook?.remoteUseHttps ? 'true' : 'false', type: 'boolean' }
      ];

      settings.forEach(setting => {
        const existing = db.prepare('SELECT id FROM qc_user_settings WHERE setting_key = ? AND user_id = 0').get(setting.key);
        if (existing) {
          db.prepare('UPDATE qc_user_settings SET setting_value = ?, setting_type = ? WHERE setting_key = ? AND user_id = 0').run(setting.value, setting.type, setting.key);
        } else {
          db.prepare('INSERT INTO qc_user_settings (user_id, setting_key, setting_value, setting_type, priority) VALUES (0, ?, ?, ?, ?)').run(setting.key, setting.value, setting.type, 'high');
        }
      });
      
      res.json({
        success: true,
        message: '第三方设置已保存',
        config: {
          enabled: talebook?.enabled || false,
          localUrl: talebook?.localUrl || '',
          localPort: talebook?.localPort || '',
          remoteUrl: talebook?.remoteUrl || '',
          remotePort: talebook?.remotePort || '',
          remoteUseHttps: talebook?.remoteUseHttps || false
        }
      });
    } catch (error) {
      console.error('❌ 保存第三方设置失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

export default new ConfigController();
