/**
 * useDatabaseDetect - 数据库检测 Composable
 *
 * 负责检测 Calibre / Talebook 数据库文件的状态（存在、权限、有效性）。
 * Docker 部署下无法便捷选择目录，故本页只做只读检测，不再提供同步操作。
 */

import { ref } from 'vue';
import {
  detectDatabases,
  type DbDetectResult,
  type DbDetectStatus
} from '@/api/config/syncStatusService';

/** 检测状态对应的展示文案与严重级别 */
export const DB_STATUS_META: Record<DbDetectStatus, { label: string; level: 'ok' | 'warn' | 'fail' }> = {
  ok: { label: '已就绪', level: 'ok' },
  not_found: { label: '未找到数据库', level: 'fail' },
  no_permission: { label: '无读取权限', level: 'fail' },
  invalid: { label: '数据库无效', level: 'warn' }
};

const EMPTY_RESULT: DbDetectResult = { path: '', status: 'not_found', message: '尚未检测' };

export function useSyncStatus() {
  const calibre = ref<DbDetectResult>({ ...EMPTY_RESULT });
  const talebook = ref<DbDetectResult>({ ...EMPTY_RESULT });

  /** 是否正在检测 */
  const detecting = ref(false);
  /** 检测过程中的错误（整体请求失败） */
  const detectError = ref('');

  // 日志（保留最近 20 条）
  const syncLogs = ref<Array<{ time: string; message: string }>>([]);

  function pushLog(message: string) {
    syncLogs.value.unshift({ time: new Date().toLocaleString(), message });
    if (syncLogs.value.length > 20) {
      syncLogs.value = syncLogs.value.slice(0, 20);
    }
  }

  function describe(name: string, result: DbDetectResult): string {
    const label = DB_STATUS_META[result.status]?.label || '未知状态';
    return `${name}：${label}（${result.path || '未配置路径'}）`;
  }

  async function refreshSyncStatus() {
    if (detecting.value) return;
    detecting.value = true;
    detectError.value = '';
    pushLog('开始检测数据库状态...');

    try {
      const result = await detectDatabases();
      if (result.success && result.data) {
        calibre.value = result.data.calibre;
        talebook.value = result.data.talebook;
        pushLog(describe('Calibre', result.data.calibre));
        pushLog(describe('Talebook', result.data.talebook));
      } else {
        detectError.value = result.error || '检测失败，请稍后重试';
        pushLog(`检测失败: ${detectError.value}`);
      }
    } catch (err) {
      detectError.value = (err as Error).message;
      pushLog(`检测失败: ${detectError.value}`);
    } finally {
      detecting.value = false;
    }
  }

  return {
    calibre,
    talebook,
    detecting,
    detectError,
    syncLogs,
    refreshSyncStatus,
    pushLog
  };
}
