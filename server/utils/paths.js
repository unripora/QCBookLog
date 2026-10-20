/**
 * 统一路径解析模块
 *
 * 所有数据目录必须通过此模块获取，禁止在业务代码中直接使用 process.cwd() / __dirname 推导。
 *
 * 解析优先级：
 *   1. QC_DATA_DIR 环境变量（Electron 主进程会传入 app.getPath('userData')/data）
 *   2. 项目根目录下的 data/（保持现有 Docker / 本地开发行为不变）
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** server/ 目录 */
export const SERVER_ROOT = path.resolve(__dirname, '..');

/** 项目根目录（server/ 的上一级） */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

const resolveDataDir = () => {
  const fromEnv = process.env.QC_DATA_DIR;
  if (fromEnv && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(PROJECT_ROOT, 'data');
};

/** 数据根目录 */
export const DATA_DIR = resolveDataDir();

/** 备份目录 */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** 元数据目录 */
export const METADATA_DIR = path.join(DATA_DIR, 'metadata');

/** 日志目录 */
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

/** 用户上传图片目录 */
export const USER_IMAGES_DIR = path.join(DATA_DIR, 'user-images');

/** 临时文件目录 */
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

/** 鉴权信息目录（session token 等） */
export const AUTH_DIR = path.join(DATA_DIR, '.auth');

/** 静态资源目录（dist 构建产物）；Electron 打包后由主进程通过 QC_DIST_DIR 指定 */
export const DIST_DIR = process.env.QC_DIST_DIR && process.env.QC_DIST_DIR.trim()
  ? path.resolve(process.env.QC_DIST_DIR.trim())
  : path.join(PROJECT_ROOT, 'dist');

export default {
  SERVER_ROOT,
  PROJECT_ROOT,
  DATA_DIR,
  BACKUP_DIR,
  METADATA_DIR,
  LOGS_DIR,
  USER_IMAGES_DIR,
  TMP_DIR,
  AUTH_DIR,
  DIST_DIR
};
