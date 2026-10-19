<template>
  <div class="db-detect">
    <!-- 检测结果卡片 -->
    <div v-for="item in items" :key="item.key" class="db-card" :class="`db-card--${item.level}`">
      <div class="db-card__header">
        <div class="db-card__title-wrap">
          <span class="db-card__icon">{{ item.icon }}</span>
          <h3 class="db-card__title">{{ item.name }}</h3>
        </div>
        <span class="db-card__badge" :class="item.level">{{ item.statusLabel }}</span>
      </div>

      <div class="db-card__body">
        <p class="db-card__message">{{ item.message }}</p>
        <div class="db-card__path-row">
          <span class="db-card__path-label">路径</span>
          <code class="db-card__path">{{ item.path || '未配置' }}</code>
        </div>
      </div>
    </div>

    <!-- 整体错误 -->
    <div v-if="detectError" class="db-detect__error">
      ⚠️ {{ detectError }}
    </div>

    <!-- 操作 -->
    <div class="db-detect__actions">
      <button class="button button--primary" :disabled="detecting" @click="$emit('refresh')">
        {{ detecting ? '检测中...' : '重新检测' }}
      </button>
    </div>

    <!-- 说明 -->
    <div class="db-detect__hint">
      <span class="db-detect__hint-icon">💡</span>
      <span>
        本页仅检测数据库文件是否可访问。Docker 部署请在启动时通过挂载目录提供数据库文件，
        若提示「未找到数据库」或「无读取权限」，请检查容器的 volume 挂载与文件权限设置。
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DbDetectResult } from '@/api/config/syncStatusService';
import { DB_STATUS_META } from '@/composables/useSyncStatus';

const props = defineProps<{
  calibre: DbDetectResult;
  talebook: DbDetectResult;
  detecting: boolean;
  detectError: string;
}>();

defineEmits<{
  (e: 'refresh'): void;
}>();

const buildItem = (key: string, name: string, icon: string, result: DbDetectResult) => {
  const meta = DB_STATUS_META[result.status] || DB_STATUS_META.invalid;
  return {
    key,
    name,
    icon,
    path: result.path,
    message: result.message,
    statusLabel: meta.label,
    level: meta.level
  };
};

const items = computed(() => [
  buildItem('calibre', 'Calibre 数据库', '📚', props.calibre),
  buildItem('talebook', 'Talebook 数据库', '📖', props.talebook)
]);
</script>

<style scoped>
.db-detect {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-bottom: 32px;
}

.db-card {
  background-color: var(--bg-secondary);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border-left: 4px solid var(--border-color);
}

.db-card--ok {
  border-left-color: var(--success-color, #4caf50);
}

.db-card--warn {
  border-left-color: var(--warning-color, #ff9800);
}

.db-card--fail {
  border-left-color: var(--error-color, #f44336);
}

.db-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-color);
}

.db-card__title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.db-card__icon {
  font-size: 20px;
}

.db-card__title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.db-card__badge {
  padding: 5px 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 600;
}

.db-card__badge.ok {
  background-color: var(--success-color-light, #e8f5e9);
  color: var(--success-color, #4caf50);
}

.db-card__badge.warn {
  background-color: var(--warning-color-light, #fff3e0);
  color: var(--warning-color, #ff9800);
}

.db-card__badge.fail {
  background-color: var(--error-color-light, #ffebee);
  color: var(--error-color, #f44336);
}

.db-card__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.db-card__message {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.db-card__path-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.db-card__path-label {
  font-size: 12px;
  color: var(--text-hint);
  flex-shrink: 0;
}

.db-card__path {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
  background-color: var(--bg-tertiary, #f5f5f5);
  padding: 3px 8px;
  border-radius: 6px;
  word-break: break-all;
}

.db-detect__error {
  font-size: 13px;
  color: var(--error-color, #f44336);
}

.db-detect__actions {
  display: flex;
}

.button {
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button--primary {
  width: 100%;
  background-color: var(--primary-color);
  color: #fff;
}

.button--primary:hover:not(:disabled) {
  background-color: var(--primary-color-dark, var(--primary-color));
}

.db-detect__hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  background-color: var(--info-color-light, #eef6ff);
  border: 1px solid var(--border-color, #d6e9ff);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.db-detect__hint-icon {
  flex-shrink: 0;
}
</style>
