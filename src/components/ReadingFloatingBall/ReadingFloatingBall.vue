<template>
  <Teleport to="body">
    <Transition name="float">
      <div
        v-if="readingStore.currentBook && !readingStore.isInReadingPage"
        class="floating-ball"
        :class="{ expanded: isExpanded, paused: readingStore.isPaused }"
        :style="{ right: position.right + 'px', top: position.top + 'px' }"
        @mousedown="startDrag"
        @click="handleClick"
      >
        <!-- 收起状态 -->
        <div v-if="!isExpanded" class="floating-ball-compact">
          <div class="reading-info">
            <div class="book-name">{{ readingStore.currentBook.title }}</div>
            <div class="reading-time">{{ formattedTime }}</div>
          </div>
          <button class="pause-btn" @click.stop="togglePause">
            <svg v-if="readingStore.isPaused" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 5v14l11-7z" fill="currentColor"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>
            </svg>
          </button>
        </div>

        <!-- 展开状态 -->
        <div v-else class="floating-ball-expanded">
          <div class="expanded-header">
            <div class="book-name">{{ readingStore.currentBook.title }}</div>
            <button class="close-btn" @click.stop="isExpanded = false">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>
            </button>
          </div>
          
          <div class="expanded-content">
            <div class="time-display">
              <div class="time-value">{{ formattedTime }}</div>
              <div class="time-label">{{ readingStore.isPaused ? '已暂停' : '正在阅读' }}</div>
            </div>
            
            <div class="reading-stats" v-if="todayStats">
              <div class="stat-item">
                <div class="stat-label">今日阅读</div>
                <div class="stat-value">{{ formatDuration(todayStats.totalTime) }}</div>
              </div>
              <div class="stat-item">
                <div class="stat-label">今日页数</div>
                <div class="stat-value">{{ todayStats.totalPages }} 页</div>
              </div>
            </div>

            <div class="progress-info">
              <div class="progress-label">阅读进度</div>
              <div class="progress-value">
                {{ readingStore.currentProgress || 0 }} / {{ readingStore.currentBook.pages || 0 }} 页
              </div>
            </div>
          </div>

          <div class="expanded-actions">
            <button class="action-btn secondary" @click.stop="handleBackToReading">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2zM11 6h2v12h-2z" fill="currentColor"/></svg>
              <span>返回阅读</span>
            </button>
            <button class="action-btn primary" @click.stop="handleOcrBookmark">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" fill="currentColor"/></svg>
              <span>OCR 书摘</span>
            </button>
          </div>
        </div>

        <!-- 拖动指示器 -->
        <div v-if="!isExpanded" class="drag-indicator" v-show="isDragging">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" fill="currentColor"/></svg>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReadingStore } from '@/stores/reading';

const router = useRouter();
const readingStore = useReadingStore();

const emit = defineEmits<{
  (e: 'updateProgress', progress: number): void;
}>();

// 组件状态
const isExpanded = ref(false);
const isDragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });
const initialBoxRect = ref({ left: 0, top: 0, width: 0, height: 0 });
// 拖动位移阈值：超过 5px 视为拖动，mouseup 后的 click 不触发展开/收起切换
const DRAG_THRESHOLD = 5;
let dragStartX = 0;
let dragStartY = 0;
let dragDistance = 0;

// 位置状态（从localStorage读取或使用默认值） - 使用 right 定位，避免展开后超出屏幕
const position = ref({ right: 20, top: 100 });

// 加载保存的位置
const loadPosition = () => {
  try {
    const saved = localStorage.getItem('floatingBallPosition');
    if (saved) {
      const pos = JSON.parse(saved);
      if (typeof pos.right === 'number' && typeof pos.top === 'number') {
        // 新格式 { right, top }
        position.value = {
          right: Math.max(0, pos.right),
          top: Math.min(Math.max(0, pos.top), window.innerHeight - 100)
        };
      } else if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        // 兼容旧格式 { x, y } - 转换为 right
        const boxWidth = 200;
        position.value = {
          right: Math.max(0, window.innerWidth - pos.x - boxWidth),
          top: Math.min(Math.max(0, pos.y), window.innerHeight - 100)
        };
      }
    }
  } catch (e) {
    console.error('Failed to load position:', e);
  }
};

// 保存位置
const savePosition = () => {
  try {
    localStorage.setItem('floatingBallPosition', JSON.stringify(position.value));
  } catch (e) {
    console.error('Failed to save position:', e);
  }
};

// 格式化时间显示
const formattedTime = computed(() => {
  const seconds = readingStore.elapsedSeconds;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
});

// 格式化时长（分钟）
const formatDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours > 0) {
    return `${hours}小时${mins}分钟`;
  }
  return `${mins}分钟`;
};

// 今日统计（从后端获取或从localStorage）
const todayStats = computed(() => {
  // 这里应该从后端获取，暂时返回null
  return null as { totalTime: number; totalPages: number } | null;
});

// 处理点击（展开/收起）；拖动位移超过阈值时视为拖动，不切换
const handleClick = () => {
  if (dragDistance > DRAG_THRESHOLD) {
    dragDistance = 0;
    return;
  }
  if (!isDragging.value) {
    isExpanded.value = !isExpanded.value;
  }
};

// 开始拖动
const startDrag = (e: MouseEvent) => {
  if (isExpanded.value) return;

  isDragging.value = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragDistance = 0;
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  initialBoxRect.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  dragOffset.value = {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };

  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
};

// 拖动中
const onDrag = (e: MouseEvent) => {
  if (!isDragging.value) return;

  dragDistance = Math.max(dragDistance, Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY));

  const newLeft = e.clientX - dragOffset.value.x;
  const newTop = e.clientY - dragOffset.value.y;
  const boxWidth = initialBoxRect.value.width;
  const boxHeight = initialBoxRect.value.height;

  // 限制在屏幕内：左侧不能小于 0，右侧不能超出屏幕
  const clampedLeft = Math.min(Math.max(0, newLeft), window.innerWidth - boxWidth);
  const clampedTop = Math.min(Math.max(0, newTop), window.innerHeight - boxHeight);

  position.value = {
    right: Math.max(0, window.innerWidth - clampedLeft - boxWidth),
    top: clampedTop
  };
};

// 结束拖动
const endDrag = () => {
  isDragging.value = false;
  savePosition();

  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
};

// 切换暂停/继续
const togglePause = () => {
  readingStore.togglePause();
};

// 返回阅读界面
const handleBackToReading = () => {
  if (readingStore.currentBookId) {
    router.push(`/book/reading/${readingStore.currentBookId}`);
  }
  isExpanded.value = false;
};

// 跳转 OCR 识别页（携带当前书籍 ID，识别后可直接归属当前书）
const handleOcrBookmark = () => {
  const query: Record<string, string> = {};
  if (readingStore.currentBookId) {
    query.bookId = String(readingStore.currentBookId);
  }
  router.push({ path: '/bookmark/ocr', query });
  isExpanded.value = false;
};

// 监听窗口大小变化
const handleResize = () => {
  position.value = {
    right: Math.max(0, position.value.right),
    top: Math.min(Math.max(0, position.value.top), window.innerHeight - 100)
  };
};

onMounted(() => {
  loadPosition();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
});
</script>

<style scoped>
.floating-ball {
  position: fixed;
  z-index: 9999;
  background: white;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  cursor: move;
  user-select: none;
  transition: box-shadow 0.3s ease;
}

.floating-ball:hover {
  box-shadow: 0 6px 25px rgba(0, 0, 0, 0.2);
}

/* 收起状态 */
.floating-ball-compact {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  min-width: 200px;
}

.reading-info {
  flex: 1;
  overflow: hidden;
}

.book-name {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.reading-time {
  font-size: 18px;
  font-weight: 700;
  color: #ff6b35;
}

.floating-ball.paused .reading-time {
  color: #999;
}

.pause-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: #f5f5f5;
  color: #333;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
  padding: 0;
}

.pause-btn:hover {
  background: #e0e0e0;
}

.pause-btn svg {
  width: 20px;
  height: 20px;
  display: block;
}

.pause-btn svg path {
  fill: currentColor;
}

/* 展开状态 */
.floating-ball-expanded {
  width: 320px;
  max-height: 500px;
  overflow: hidden;
}

.expanded-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.expanded-header .book-name {
  font-size: 16px;
  margin-bottom: 0;
}

.close-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background 0.2s ease;
  color: #666;
  padding: 0;
}

.close-btn:hover {
  background: #f5f5f5;
}

.close-btn svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.expanded-content {
  padding: 16px;
}

.time-display {
  text-align: center;
  margin-bottom: 16px;
}

.time-value {
  font-size: 36px;
  font-weight: 700;
  color: #ff6b35;
  line-height: 1;
  margin-bottom: 4px;
}

.floating-ball.paused .time-value {
  color: #999;
}

.time-label {
  font-size: 12px;
  color: #999;
}

.reading-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.stat-item {
  background: #f9f9f9;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}

.stat-label {
  font-size: 12px;
  color: #999;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
}

.progress-info {
  background: #fff5f0;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}

.progress-label {
  font-size: 12px;
  color: #ff6b35;
  margin-bottom: 4px;
}

.progress-value {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
}

.expanded-actions {
  display: flex;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid #f0f0f0;
}

.action-btn {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.action-btn.secondary {
  background: #f5f5f5;
  color: #333;
}

.action-btn.secondary:hover {
  background: #e0e0e0;
}

.action-btn.primary {
  background: #ff6b35;
  color: white;
}

.action-btn.primary:hover {
  background: #e55a2b;
}

.action-btn svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

/* 拖动指示器 */
.drag-indicator {
  position: absolute;
  top: -30px;
  left: 50%;
  transform: translateX(-50%);
  background: #333;
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  white-space: nowrap;
}

.drag-indicator svg {
  width: 16px;
  height: 16px;
  fill: white;
  vertical-align: middle;
}

/* 过渡动画 */
.float-enter-active,
.float-leave-active {
  transition: all 0.3s ease;
}

.float-enter-from,
.float-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
</style>
