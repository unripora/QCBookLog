/**
 * 数据库检测服务（Service）
 *
 * 集中封装数据库文件状态检测相关的 API。
 */

import { apiClient } from '../apiClient';

/** 单个数据库的检测状态码 */
export type DbDetectStatus = 'ok' | 'not_found' | 'no_permission' | 'invalid';

/** 单个数据库的检测结果 */
export interface DbDetectResult {
  /** 数据库文件路径 */
  path: string;
  /** 状态码 */
  status: DbDetectStatus;
  /** 人类可读的说明 */
  message: string;
}

/** 数据库检测响应 */
export interface DetectDatabasesResponse {
  success: boolean;
  data?: {
    calibre: DbDetectResult;
    talebook: DbDetectResult;
  };
  timestamp?: string;
  error?: string;
}

/**
 * 检测数据库状态（是否存在 / 是否有权限 / 是否有效）
 */
export async function detectDatabases(): Promise<DetectDatabasesResponse> {
  return apiClient.get('/config/detect-databases');
}
