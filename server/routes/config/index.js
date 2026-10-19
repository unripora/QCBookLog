/**
 * 配置路由模块（重构版本）
 * 使用控制器模式，更清晰和可维护
 */

import express from 'express';
import configController from '../../handlers/config-handler.js';

const router = express.Router();

router.get('/', configController.getAllConfig.bind(configController));
router.post('/', configController.updateAllConfig.bind(configController));

router.get('/calibre-path', configController.getCalibrePath.bind(configController));
router.post('/calibre-path', configController.setCalibrePath.bind(configController));
router.post('/validate-calibre', configController.validateCalibre.bind(configController));

router.get('/talebook-path', configController.getTalebookPath.bind(configController));
router.post('/talebook-path', configController.setTalebookPath.bind(configController));
router.post('/validate-talebook', configController.validateTalebook.bind(configController));

router.get('/check-databases', configController.checkDatabases.bind(configController));
router.get('/detect-databases', configController.detectDatabases.bind(configController));
router.post('/create-database', configController.createDatabase.bind(configController));
router.post('/set-default', configController.setDefault.bind(configController));
router.get('/system-status', configController.getSystemStatus.bind(configController));
router.get('/sync-status', configController.getSyncStatus.bind(configController));
router.get('/third-party', configController.getThirdPartyConfig.bind(configController));
router.post('/third-party', configController.saveThirdPartyConfig.bind(configController));

export default router;
