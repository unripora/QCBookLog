<template>
  <div class="config-page">
    <HeaderTabs :selected-type="selectedType" @select="selectType" />

    <!-- 数据库检测页面 -->
    <template v-if="selectedType === 'sync-status'">
      <div class="sync-status-page">
        <div class="sync-status-page__header">
          <h2 class="sync-status-page__title">数据库检测</h2>
          <p class="sync-status-page__subtitle">
            检测 Calibre 与 Talebook 数据库文件是否可访问
          </p>
        </div>

        <DatabaseDetectPanel
          :calibre="calibre"
          :talebook="talebook"
          :detecting="detecting"
          :detect-error="detectError"
          @refresh="refreshSyncStatus"
        />

        <SyncDetailsPanel :logs="syncLogs" />
      </div>
    </template>

    <!-- 配置向导页面 -->
    <template v-else>
      <StepIndicator :current-step="currentStep" />

      <!-- 错误提示 -->
      <div v-if="error" class="alert alert--error">
        <span class="alert__icon">⚠️</span>
        <span class="alert__message">{{ error }}</span>
        <button class="alert__close" @click="error = null">✕</button>
      </div>

      <!-- 步骤 0: 选择书库 -->
      <ConfigStepSelect
        v-if="currentStep === 0"
        :selected-type="selectedType"
        :config-mode="configMode"
        :loading="loading"
        :calibre-path="calibrePath"
        :talebook-path="talebookPath"
        :new-calibre-path="newCalibrePath"
        :new-talebook-path="newTalebookPath"
        :source-info="transferSourceInfo"
        :transfer-loading="transferLoading"
        :transfer-logs="transferLogs"
        @update:config-mode="configMode = $event"
        @update:calibre-path="calibrePath = $event"
        @update:talebook-path="talebookPath = $event"
        @update:new-calibre-path="newCalibrePath = $event"
        @update:new-talebook-path="newTalebookPath = $event"
        @validate="validateDb"
        @create-new="createNewDatabase"
        @set-error="(msg) => (error = msg)"
        @open-transfer-dialog="openTransferDialog"
        @load-transfer-logs="loadTransferLogs"
      />

      <!-- 步骤 1: 验证 -->
      <ConfigStepValidate
        v-else-if="currentStep === 1"
        :selected-type="selectedType"
        :loading="loading"
        :validation="validation"
        :current-path="currentPath"
        @save="onSave"
        @back="currentStep = 0"
        @validate="validateDb"
      />

      <!-- 步骤 2: 完成 -->
      <ConfigStepComplete
        v-else-if="currentStep === 2"
        :selected-type="selectedType"
        :valid="isCurrentValid"
        :current-path="currentPath"
        :stats="currentStats"
        :is-default="isDefault"
        :error-message="currentError"
        @toggle-default="toggleDefault"
        @go-home="goHome"
        @reconfigure="reconfigure"
      />
    </template>

    <!-- 数据转移弹窗 -->
    <TransferDialog
      :visible="transferDialogVisible"
      :step="transferStep"
      :source-info="transferSourceInfo"
      :target-dir="transferTargetDir"
      :target-info="transferTargetInfo"
      :target-loading="transferTargetLoading"
      :loading="transferLoading"
      :confirm-text="transferConfirmText"
      :result="transferResult"
      @close="closeTransferDialog"
      @update:target-dir="transferTargetDir = $event"
      @update:confirm-text="transferConfirmText = $event"
      @go-confirm="goToConfirmStep"
      @back-to-config="transferStep = 'config'"
      @execute="executeTransfer"
      @select-target-folder="selectTransferTargetFolder"
      @target-folder-change="handleTransferFolderSelect"
      @reload-talebook="reloadTalebookPath"
    />

    <!-- 初始加载 -->
    <div v-if="initialLoading" class="loading-container">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onActivated, onBeforeUnmount } from 'vue';
import { useBookStore } from '@/stores/book';
import { useConfig } from '@/composables/useConfig';
import { useSyncStatus } from '@/composables/useSyncStatus';
import { useDataTransfer } from '@/composables/useDataTransfer';
import { useConfigSyncTimer } from '@/composables/useConfigSyncTimer';

import HeaderTabs from './components/HeaderTabs.vue';
import StepIndicator from './components/StepIndicator.vue';
import ConfigStepSelect from './components/ConfigStepSelect.vue';
import ConfigStepValidate from './components/ConfigStepValidate.vue';
import ConfigStepComplete from './components/ConfigStepComplete.vue';
import DatabaseDetectPanel from './components/DatabaseDetectPanel.vue';
import SyncDetailsPanel from './components/SyncDetailsPanel.vue';
import TransferCard from './components/TransferCard.vue';
import TransferDialog from './components/TransferDialog.vue';

const bookStore = useBookStore();

// ---- 配置 ----
const config = useConfig();
const {
  currentStep,
  selectedType,
  configMode,
  calibrePath,
  talebookPath,
  newCalibrePath,
  newTalebookPath,
  validation,
  loading,
  error,
  currentPath,
  initialLoading,
  isDefault,
  calibreStats,
  talebookStats,
  calibreValid,
  talebookValid,
  calibreError,
  talebookError,
  validateDb,
  saveConfig,
  toggleDefault,
  createNewDatabase,
  fetchCurrentConfig,
  selectType,
  reconfigure,
  reloadTalebookPath
} = config;

const isCurrentValid = computed(() =>
  selectedType.value === 'calibre' ? calibreValid.value : talebookValid.value
);
const currentStats = computed(() =>
  selectedType.value === 'calibre' ? calibreStats.value : talebookStats.value
);
const currentError = computed(() =>
  selectedType.value === 'calibre' ? calibreError.value : talebookError.value
);

// 保存配置后清理书籍缓存
async function onSave() {
  await saveConfig(async () => {
    bookStore.setBooks([]);
  });
}

// 切换到其他数据库
function goHome() {
  bookStore.setBooks([]);
  window.location.href = '/';
}

// ---- 数据库检测 ----
const sync = useSyncStatus();
const {
  calibre,
  talebook,
  detecting,
  detectError,
  syncLogs,
  refreshSyncStatus
} = sync;

// ---- 数据转移 ----
const transfer = useDataTransfer();
const {
  transferDialogVisible,
  transferStep,
  transferSourceInfo,
  transferTargetDir,
  transferTargetInfo,
  transferTargetLoading,
  transferLoading,
  transferConfirmText,
  transferResult,
  transferLogs,
  transferFolderInput,
  loadTransferSourceInfo,
  loadTransferLogs,
  openTransferDialog,
  closeTransferDialog,
  selectTransferTargetFolder,
  handleTransferFolderSelect,
  goToConfirmStep,
  executeTransfer
} = transfer;

// 把 transferFolderInput 暴露给 TransferDialog
function bindTransferDialog() {
  // 绑定通过 props 事件已经实现
}

// ---- 同步定时器 ----
const { start: startSyncTimer, stop: stopSyncTimer } = useConfigSyncTimer(fetchCurrentConfig);

// ---- 生命周期 ----
onMounted(() => {
  // URL 参数 tab
  const urlParams = new URLSearchParams(window.location.search);
  const tabParam = urlParams.get('tab');
  if (tabParam === 'sync-status' || tabParam === 'calibre' || tabParam === 'talebook') {
    selectedType.value = tabParam;
  }

  if (selectedType.value === 'sync-status') {
    refreshSyncStatus();
  }

  // 数据转移相关
  loadTransferSourceInfo();
  loadTransferLogs();

  // 配置同步定时器
  startSyncTimer();

  fetchCurrentConfig();
});

onActivated(() => {
  if (selectedType.value === 'sync-status') {
    refreshSyncStatus();
  }
  startSyncTimer();
  fetchCurrentConfig();
});

onBeforeUnmount(() => {
  stopSyncTimer();
  bindTransferDialog();
});
</script>

<style scoped>
.config-page {
  min-height: 100vh;
  background-color: var(--bg-primary);
  padding: 16px;
  padding-bottom: 80px;
}

/* 错误提示 */
.alert {
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert--error {
  background-color: var(--error-color-light);
  color: var(--error-color);
}

.alert__icon {
  font-size: 20px;
}

.alert__message {
  flex: 1;
  font-size: 14px;
}

.alert__close {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: inherit;
}

/* 加载动画 */
.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 4px solid var(--border-color);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 同步状态页面容器 */
.sync-status-page {
  background-color: var(--bg-primary);
  border-radius: 8px;
  padding: 16px;
  margin: 0 auto;
  max-width: 1000px;
}

.sync-status-page__header {
  margin-bottom: 32px;
  text-align: center;
}

.sync-status-page__title {
  margin: 0 0 8px 0;
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.sync-status-page__subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

@media (max-width: 767px) {
  .sync-status-page {
    padding: 12px;
  }
}
</style>
