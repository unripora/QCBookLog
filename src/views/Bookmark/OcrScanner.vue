<template>
  <div class="ocr-container">
    <!-- 顶部导航栏 -->
    <div class="header">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
      </button>
      <h1 class="title">拍照识别书摘</h1>
      <div class="header-right">
        <span v-if="selectedCount > 0" class="selected-count">{{ selectedCount }}/{{ results.length }}</span>
      </div>
    </div>

    <div class="page-body">
      <!-- 摄像头能力提示 -->
      <div v-if="cameraMode === 'capture'" class="notice notice-warning">
        <span class="notice-icon">📱</span>
        <span class="notice-text">{{ captureHint }}</span>
      </div>

      <!-- 操作区 -->
      <div class="action-bar">
        <button class="action-block camera" :disabled="isRecognizing" @click="openCamera">
          <span class="action-icon">📷</span>
          <span>{{ cameraMode === 'live' ? '拍照扫描' : '调用相机' }}</span>
        </button>
        <button class="action-block album" :disabled="isRecognizing" @click="triggerFileInput">
          <span class="action-icon">🖼️</span>
          <span>相册上传</span>
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        :accept="cameraMode === 'capture' ? 'image/*' : 'image/jpeg,image/png,image/webp,image/bmp'"
        :capture="cameraMode === 'capture' ? 'environment' : undefined"
        :multiple="cameraMode !== 'capture'"
        class="file-input"
        @change="handleFileSelect"
      />

      <!-- 语言选择 -->
      <div class="section">
        <div class="section-head" @click="showLanguages = !showLanguages">
          <span class="section-title">识别语言</span>
          <span class="section-value">
            {{ selectedLanguagesText }}
            <svg class="caret" :class="{ open: showLanguages }" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
          </span>
        </div>
        <div v-if="showLanguages" class="language-list">
          <label
            v-for="lang in OCR_LANGUAGE_OPTIONS"
            :key="lang.code"
            :class="['language-item', { active: selectedLanguages.includes(lang.code) }]"
          >
            <input type="checkbox" :value="lang.code" v-model="selectedLanguages" @change="onLanguageChange" />
            <span class="lang-label">{{ lang.label }}</span>
            <span class="lang-code">{{ lang.code }}</span>
          </label>
          <p class="language-hint">支持多选；切换语言后需重新加载语言包，首次加载耗时较长</p>
        </div>
      </div>

      <!-- 识别进度 -->
      <div v-if="isRecognizing" class="section progress-section">
        <div class="progress-head">
          <span class="section-title">{{ progress.status }}</span>
          <span class="progress-percent">{{ progress.progress }}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progress.progress + '%' }"></div>
        </div>
      </div>

      <!-- 识别结果列表 -->
      <div v-if="results.length > 0" class="section results-section">
        <div class="results-head">
          <span class="section-title">识别结果（{{ results.length }}）</span>
          <div class="results-actions">
            <button class="mini-btn" @click="selectAll">全选</button>
            <button class="mini-btn" @click="invertSelection">反选</button>
            <button class="mini-btn danger" :disabled="selectedCount === 0" @click="removeSelected">删除</button>
          </div>
        </div>

        <div class="result-list">
          <div
            v-for="item in results"
            :key="item.id"
            :class="['result-card', { selected: item.selected, error: !!item.error }]"
          >
            <div class="result-card-head">
              <label class="result-checkbox" @click.stop>
                <input type="checkbox" v-model="item.selected" />
              </label>
              <span class="result-source">{{ item.sourceName || '图片' }}</span>
              <span v-if="item.error" class="result-badge error">识别失败</span>
              <span v-else class="result-badge" :class="confidenceClass(item.confidence)">
                置信度 {{ item.confidence }}%
              </span>
              <button class="result-remove" @click.stop="removeResult(item.id)">×</button>
            </div>
            <p v-if="item.error" class="result-error">{{ item.error }}</p>
            <textarea
              v-else
              v-model="item.text"
              class="result-textarea"
              rows="4"
              placeholder="识别文字可在此编辑..."
            ></textarea>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!isRecognizing" class="empty-state">
        <span class="empty-icon">📄</span>
        <p>拍照或上传书籍页面图片，自动识别文字</p>
        <p class="empty-hint">提示：光线充足、书本平整、文字占满画面可获得更好效果</p>
      </div>
    </div>

    <!-- 底部保存栏 -->
    <div v-if="selectedCount > 0" class="save-bar">
      <button class="save-btn outline" :disabled="saving" @click="handleSave('separate')">
        分别保存（{{ selectedCount }} 条）
      </button>
      <button class="save-btn primary" :disabled="saving" @click="handleSave('merge')">
        合并保存（1 条）
      </button>
    </div>

    <!-- 摄像头拍照弹层 -->
    <div v-if="showCamera" class="camera-overlay">
      <div class="camera-header">
        <span>拍照扫描</span>
        <button class="camera-close" @click="closeCamera">×</button>
      </div>
      <div class="camera-view">
        <video ref="videoElement" class="video-preview" autoplay playsinline muted></video>
        <div class="camera-frame">
          <div class="corner top-left"></div>
          <div class="corner top-right"></div>
          <div class="corner bottom-left"></div>
          <div class="corner bottom-right"></div>
        </div>
      </div>
      <div class="camera-tips">将书页文字置于取景框内，保持清晰平整</div>
      <div class="camera-controls">
        <button class="shutter-btn" :disabled="isRecognizing" @click="capturePhoto">
          <span class="shutter-inner"></span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useBookmarkStore } from '@/stores/bookmark';
import { bookmarkService } from '@/api/bookmark';
import {
  ocrScannerService,
  OCR_LANGUAGE_OPTIONS,
  DEFAULT_OCR_LANGUAGES,
  type OcrRecognizeResult,
  type OcrProgress
} from '@/api/common/ocrScanner';
import { pickCameraMode, getCaptureModeHint, type CameraMode } from '@/utils/cameraCapability';

const router = useRouter();
const route = useRoute();
const bookmarkStore = useBookmarkStore();

/** 当前书籍 ID（从入口透传，可选） */
const bookId = computed(() => {
  const raw = route.query.bookId;
  return raw ? Number(raw) : undefined;
});

// 文件输入引用
const fileInput = ref<HTMLInputElement | null>(null);
// 视频元素引用
const videoElement = ref<HTMLVideoElement | null>(null);

// 状态
const cameraMode = ref<CameraMode>(pickCameraMode());
const captureHint = getCaptureModeHint();
const showCamera = ref(false);
const showLanguages = ref(false);
const isRecognizing = ref(false);
const saving = ref(false);
const selectedLanguages = ref<string[]>([...DEFAULT_OCR_LANGUAGES]);
const progress = ref<OcrProgress>({ status: '准备中...', progress: 0 });

/** 结果项：在服务层结果上附加本地标识与勾选态 */
interface ResultItem extends OcrRecognizeResult {
  id: number;
  selected: boolean;
}
const results = ref<ResultItem[]>([]);
let resultSeq = 0;

// 视频流
let mediaStream: MediaStream | null = null;

const selectedCount = computed(() => results.value.filter(r => r.selected).length);
const selectedLanguagesText = computed(() =>
  OCR_LANGUAGE_OPTIONS
    .filter(l => selectedLanguages.value.includes(l.code))
    .map(l => l.label)
    .join(' + ') || '未选择'
);

const confidenceClass = (confidence: number): string => {
  if (confidence >= 75) return 'good';
  if (confidence >= 50) return 'medium';
  return 'low';
};

// 语言切换时至少保留一种
const onLanguageChange = () => {
  if (selectedLanguages.value.length === 0) {
    selectedLanguages.value = [...DEFAULT_OCR_LANGUAGES];
    alert('至少需要选择一种识别语言');
  }
};

// 返回
const goBack = () => {
  router.back();
};

// 触发相册选择
const triggerFileInput = () => {
  fileInput.value?.click();
};

// 处理相册选择（支持多选）
const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  const files = Array.from(target.files);
  target.value = '';
  await recognizeFiles(files);
};

// 批量识别
const recognizeFiles = async (files: File[]) => {
  if (isRecognizing.value) return;
  isRecognizing.value = true;
  progress.value = { status: '准备中...', progress: 0 };

  try {
    const batchResults = await ocrScannerService.recognizeBatch(files, {
      languages: selectedLanguages.value,
      enablePreprocessing: true,
      onProgress: p => {
        progress.value = p;
      }
    });

    batchResults.forEach(result => {
      results.value.unshift({
        ...result,
        id: ++resultSeq,
        selected: !result.error && !!result.text
      });
    });

    const failed = batchResults.filter(r => r.error).length;
    const empty = batchResults.filter(r => !r.error && !r.text).length;
    if (failed > 0 || empty > 0) {
      const parts: string[] = [];
      if (failed > 0) parts.push(`${failed} 张识别失败`);
      if (empty > 0) parts.push(`${empty} 张未识别到文字`);
      alert(`${parts.join('，')}，请尝试更清晰的图片`);
    }
  } catch (e) {
    console.error('❌ OCR 识别异常:', e);
    alert('识别失败，请重试');
  } finally {
    isRecognizing.value = false;
  }
};

// 打开摄像头
const openCamera = async () => {
  // 非安全上下文：getUserMedia 不可用，直接调起系统相机
  if (cameraMode.value === 'capture') {
    triggerFileInput();
    return;
  }
  showCamera.value = true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    if (videoElement.value) {
      videoElement.value.srcObject = mediaStream;
      await new Promise<void>((resolve, reject) => {
        if (!videoElement.value) return reject(new Error('视频元素未就绪'));
        const timer = setTimeout(() => reject(new Error('视频加载超时')), 10000);
        videoElement.value.onloadedmetadata = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } catch (e) {
    console.error('❌ 打开摄像头失败:', e);
    closeCamera();
    // 运行时降级：实时取景失败后改为系统相机
    cameraMode.value = 'capture';
    triggerFileInput();
  }
};

// 关闭摄像头
const closeCamera = () => {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (videoElement.value) {
    videoElement.value.srcObject = null;
  }
  showCamera.value = false;
};

// 拍照并识别
const capturePhoto = async () => {
  const video = videoElement.value;
  if (!video || !video.videoWidth) {
    alert('摄像头尚未就绪，请稍候');
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    alert('拍照失败，请重试');
    return;
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  closeCamera();
  isRecognizing.value = true;
  progress.value = { status: '准备中...', progress: 0 };

  try {
    const result = await ocrScannerService.recognizeFromCanvas(canvas, {
      languages: selectedLanguages.value,
      enablePreprocessing: true,
      sourceName: '拍照',
      onProgress: p => {
        progress.value = p;
      }
    });
    results.value.unshift({
      ...result,
      id: ++resultSeq,
      selected: !result.error && !!result.text
    });
    if (result.error || !result.text) {
      alert(result.error || '未识别到文字，请调整拍摄角度后重试');
    }
  } catch (e) {
    console.error('❌ 拍照识别异常:', e);
    alert('识别失败，请重试');
  } finally {
    isRecognizing.value = false;
  }
};

// 选择操作
const selectAll = () => {
  results.value.forEach(r => { r.selected = true; });
};
const invertSelection = () => {
  results.value.forEach(r => { r.selected = !r.selected; });
};
const removeResult = (id: number) => {
  results.value = results.value.filter(r => r.id !== id);
};
const removeSelected = () => {
  results.value = results.value.filter(r => !r.selected);
};

// 保存：merge 合并为一条并回填编辑页；separate 逐条直接保存
const handleSave = async (mode: 'merge' | 'separate') => {
  const selected = results.value.filter(r => r.selected && !r.error && r.text.trim());
  if (selected.length === 0) {
    alert('请先勾选包含有效文字的结果');
    return;
  }

  if (mode === 'merge') {
    sessionStorage.setItem('ocrDraftContent', selected.map(r => r.text.trim()).join('\n\n'));
    const query: Record<string, string> = { ocr: '1' };
    if (bookId.value) query.bookId = String(bookId.value);
    router.push({ path: '/bookmark/edit', query });
    return;
  }

  if (!bookId.value) {
    alert('当前未关联书籍，无法分别保存。请从书籍或阅读页进入，或改用「合并保存」在编辑页选择书籍');
    return;
  }

  saving.value = true;
  try {
    const payloads = selected.map(r => ({
      bookId: bookId.value as number,
      content: r.text.trim(),
      note: '',
      page: undefined as number | undefined,
      pageNum: undefined as number | undefined,
      tags: [] as string[],
      importSource: 'ocr'
    }));

    const created = await bookmarkService.batchAddBookmarks(payloads);
    created.forEach(b => bookmarkStore.addBookmark(b));

    alert(`已保存 ${created.length} 条书摘`);
    router.push('/bookmark');
  } catch (e) {
    console.error('❌ 批量保存书摘失败:', e);
    alert('保存失败，请重试');
  } finally {
    saving.value = false;
  }
};

// 进入页面即后台预热 OCR 引擎（加载 wasm 核心 + 语言包），
// 用户选图/拍照时无需再等待首次初始化
onMounted(() => {
  ocrScannerService.preload(selectedLanguages.value);
});

onUnmounted(() => {
  closeCamera();
  // 释放 OCR Worker，避免长期占用内存
  ocrScannerService.terminate();
});
</script>

<style scoped>
.ocr-container {
  min-height: 100vh;
  background-color: var(--bg-primary);
  display: flex;
  flex-direction: column;
  padding-bottom: 80px;
}

.header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background-color: var(--bg-secondary);
  border-bottom: 1px solid var(--border-light);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.back-btn svg {
  width: 24px;
  height: 24px;
  fill: var(--text-primary);
}

.title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 500;
  margin: 0;
}

.header-right {
  width: 52px;
  text-align: right;
}

.selected-count {
  font-size: 13px;
  color: var(--primary-color);
  font-weight: 500;
}

.page-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 提示 */
.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.5;
}

.notice-warning {
  background-color: #fff8e1;
  color: #8d6e00;
  border: 1px solid #ffe0a3;
}

.notice-icon {
  font-size: 16px;
}

/* 操作区 */
.action-bar {
  display: flex;
  gap: 12px;
}

.action-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 12px;
  border: none;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 500;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-block:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-block:not(:disabled):hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.action-block.camera {
  background-color: var(--primary-color);
}

.action-block.album {
  background-color: #4a90d9;
}

.action-icon {
  font-size: 28px;
}

.file-input {
  display: none;
}

/* 通用 section */
.section {
  background-color: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 16px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}

.section-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.section-value {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: var(--text-secondary);
}

.caret {
  width: 18px;
  height: 18px;
  fill: var(--text-hint);
  transition: transform 0.2s ease;
}

.caret.open {
  transform: rotate(180deg);
}

/* 语言列表 */
.language-list {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.language-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.language-item.active {
  border-color: var(--primary-color);
  background-color: rgba(255, 107, 53, 0.08);
}

.language-item input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.lang-label {
  flex: 1;
  color: var(--text-primary);
}

.lang-code {
  font-size: 11px;
  color: var(--text-hint);
}

.language-hint {
  grid-column: 1 / -1;
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-hint);
  line-height: 1.5;
}

/* 进度 */
.progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.progress-percent {
  font-size: 14px;
  font-weight: 500;
  color: var(--primary-color);
}

.progress-bar {
  height: 8px;
  background-color: #f0f0f0;
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background-color: var(--primary-color);
  border-radius: 4px;
  transition: width 0.3s ease;
}

/* 结果列表 */
.results-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.results-actions {
  display: flex;
  gap: 8px;
}

.mini-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background-color: #fff;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.mini-btn:hover:not(:disabled) {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.mini-btn.danger {
  color: #f44336;
  border-color: #f44336;
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 12px;
  transition: all 0.2s ease;
}

.result-card.selected {
  border-color: var(--primary-color);
  background-color: rgba(255, 107, 53, 0.04);
}

.result-card.error {
  border-color: #ffcdd2;
  background-color: #fff5f5;
}

.result-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.result-checkbox input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.result-source {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: #fff;
  background-color: #999;
  flex-shrink: 0;
}

.result-badge.good {
  background-color: #4caf50;
}

.result-badge.medium {
  background-color: #ff9800;
}

.result-badge.low {
  background-color: #f44336;
}

.result-badge.error {
  background-color: #f44336;
}

.result-remove {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-hint);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  border-radius: 50%;
  flex-shrink: 0;
}

.result-remove:hover {
  background-color: #ffebee;
  color: #f44336;
}

.result-textarea {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
  font-size: 15px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
}

.result-textarea:focus {
  border-color: var(--primary-color);
}

.result-error {
  margin: 0;
  font-size: 13px;
  color: #c62828;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 24px;
  color: var(--text-hint);
  text-align: center;
}

.empty-icon {
  font-size: 56px;
  margin-bottom: 16px;
}

.empty-state p {
  margin: 0 0 8px;
  font-size: 14px;
}

.empty-hint {
  font-size: 12px !important;
  color: var(--text-hint);
}

/* 底部保存栏 */
.save-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background-color: var(--bg-secondary);
  border-top: 1px solid var(--border-light);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.06);
  z-index: 200;
}

.save-btn {
  flex: 1;
  padding: 12px;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.save-btn.outline {
  background-color: #fff;
  border: 1px solid var(--primary-color);
  color: var(--primary-color);
}

.save-btn.primary {
  background-color: var(--primary-color);
  color: #fff;
}

/* 摄像头弹层 */
.camera-overlay {
  position: fixed;
  inset: 0;
  background-color: #000;
  z-index: 3000;
  display: flex;
  flex-direction: column;
}

.camera-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  color: #fff;
  font-size: 16px;
}

.camera-close {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: #fff;
  font-size: 26px;
  line-height: 1;
  cursor: pointer;
}

.camera-view {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-preview {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.camera-frame {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 88%;
  height: 55%;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
}

.corner {
  position: absolute;
  width: 24px;
  height: 24px;
  border: 3px solid var(--primary-color);
}

.top-left {
  top: -3px;
  left: -3px;
  border-right: none;
  border-bottom: none;
}

.top-right {
  top: -3px;
  right: -3px;
  border-left: none;
  border-bottom: none;
}

.bottom-left {
  bottom: -3px;
  left: -3px;
  border-right: none;
  border-top: none;
}

.bottom-right {
  bottom: -3px;
  right: -3px;
  border-left: none;
  border-top: none;
}

.camera-tips {
  text-align: center;
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  padding: 8px 16px;
}

.camera-controls {
  display: flex;
  justify-content: center;
  padding: 20px 0 36px;
}

.shutter-btn {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.6);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.shutter-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.shutter-inner {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background-color: #fff;
}

/* 响应式 */
@media (min-width: 1024px) {
  .page-body {
    max-width: 720px;
    margin: 0 auto;
    width: 100%;
  }
}
</style>
