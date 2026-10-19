<template>
  <div class="config-page__header">
    <h1 class="config-page__title">配置书库</h1>
    <p class="config-page__subtitle">
      配置后，应用将与所选书库实现实时同步。
    </p>
  </div>

  <div class="tabs-container">
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="tab-button"
        :class="{ active: selectedType === tab.value }"
        @click="$emit('select', tab.value)"
      >
        {{ tab.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SelectedType } from '@/composables/useConfig';

defineProps<{ selectedType: SelectedType }>();
defineEmits<{ (e: 'select', value: SelectedType): void }>();

const tabs: Array<{ value: SelectedType; label: string }> = [
  { value: 'sync-status', label: '数据库检测' },
  { value: 'calibre', label: '同步 Calibre' },
  { value: 'talebook', label: '同步 Talebook' }
];
</script>

<style scoped>
.config-page__header {
  padding: 16px 0;
  margin-bottom: 24px;
}

.config-page__title {
  margin: 0 0 8px 0;
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.config-page__subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.tabs-container {
  margin-bottom: 32px;
  border-bottom: 1px solid var(--border-color);
}

.tabs {
  display: flex;
  gap: 0;
}

.tab-button {
  padding: 12px 24px;
  border: none;
  background: none;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.3s ease;
}

.tab-button:hover {
  color: var(--primary-color);
  background-color: var(--bg-secondary);
}

.tab-button.active {
  color: var(--primary-color);
  border-bottom-color: var(--primary-color);
  background-color: var(--bg-secondary);
}
</style>
