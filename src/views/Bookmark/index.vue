<template>
  <div class="bookmark-container">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="search-bar" @click="showSearch = true">
        <svg class="search-icon" viewBox="0 0 24 24">
          <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <span>搜索书摘...</span>
      </div>
      <button class="action-btn ocr-btn" title="拍照识别书摘" @click="goToOcrScanner">
        <svg viewBox="0 0 24 24"><path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
      </button>
      <button class="action-btn add-btn" @click="goToAddBookmark">
        <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
    </div>

    <!-- Tab切换 -->
    <div class="tabs">
      <div 
        v-for="tab in tabs" 
        :key="tab.key"
        :class="['tab-item', 'tab-item--' + tab.key, { active: activeTab === tab.key }]"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </div>
    </div>

    <!-- 内容区域 -->
    <div class="content">
      <!-- 书摘列表 -->
      <div v-show="activeTab === 'list'" class="tab-content">
        <!-- 筛选条件 -->
        <div class="filter-chips">
          <span
            :class="['chip', { active: !selectedTag }]"
            @click="selectedTag = ''"
          >
            全部
            <span class="tag-count">{{ totalBookmarkCount }}</span>
          </span>
          <span
            v-for="tag in allTags"
            :key="tag.tag_id"
            :class="['chip', { active: selectedTag === tag.tag_id }]"
            @click="selectedTag = tag.tag_id"
          >
            {{ tag.tag_id }}
            <span class="tag-count">{{ tag.count }}</span>
          </span>
        </div>

        <div v-if="filteredBookmarks.length > 0" class="bookmarks-list">
          <div
            v-for="bookmark in filteredBookmarks"
            :key="bookmark.id"
            class="bookmark-card"
            @click="goToBookmarkDetail(bookmark.id)"
          >
            <div v-if="bookmark.bookTitle" class="bookmark-book">{{ bookmark.bookTitle }}</div>
            <p class="bookmark-content">{{ bookmark.content }}</p>
            <p v-if="bookmark.note" class="bookmark-note">{{ bookmark.note }}</p>
            <div class="bookmark-footer">
              <span v-if="bookmark.pageNum" class="page-num">第 {{ bookmark.pageNum }} 页</span>
              <span class="create-time">{{ formatDate(bookmark.createTime) }}</span>
              <span v-if="bookmark.updateTime" class="update-time">更新于 {{ formatDate(bookmark.updateTime) }}</span>
              <div class="bookmark-tags">
                <span
                  v-for="tag in bookmark.tags"
                  :key="tag"
                  class="mini-tag"
                >{{ tag }}</span>
              </div>
            </div>
            <div class="bookmark-actions">
              <button class="action-btn-sm" @click.stop="handleEdit(bookmark.id)">
                <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"/></svg>
              </button>
              <button class="action-btn-sm" @click.stop="handleDelete(bookmark.id)">
                <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12z"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <span class="empty-icon">📝</span>
          <p>暂无书摘</p>
          <button class="btn-primary" @click="goToAddBookmark">添加第一条书摘</button>
        </div>
      </div>

      <!-- 书评页面 -->
      <div v-show="activeTab === 'book-review'" class="tab-content">
        <BookReviewTab />
      </div>

      <!-- 回顾页面（内含两个子 tab：书摘卡片 / 时间线） -->
      <div v-show="activeTab === 'review'" class="tab-content review-tab">
        <BookmarkReviewSection :bookmarks="allBookmarks" />
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="showDeleteConfirm" class="dialog-overlay" @click="showDeleteConfirm = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <span>确认删除</span>
          <span class="dialog-close" @click="showDeleteConfirm = false">×</span>
        </div>
        <div class="dialog-body">
          <p>确定要删除这条书摘吗？</p>
        </div>
        <div class="dialog-footer">
          <button class="btn btn-default" @click="showDeleteConfirm = false">取消</button>
          <button class="btn btn-danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 浮动添加按钮 -->
    <button v-if="allBookmarks.length > 0" class="fab" @click="goToAddBookmark">
      <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useBookmarkStore } from '@/stores/bookmark';
import { useBookStore } from '@/stores/book';
import { bookmarkService } from '@/api/bookmark';
import { bookService } from '@/api/book';
import { tagApi } from '@/api/apiClient';
import BookReviewTab from '@/views/Review/BookReviewTab.vue';
import BookmarkReviewSection from './components/BookmarkReviewSection.vue';

const router = useRouter();
const route = useRoute();
const bookmarkStore = useBookmarkStore();
const bookStore = useBookStore();

// Tab配置
const tabs = [
  { key: 'list', label: '书摘' },
  { key: 'book-review', label: '书评' },
  { key: 'review', label: '回顾' }
];
const activeTab = ref('list');

// 支持通过路由 query 定位到指定 tab（如从书评编辑页返回书评选项卡）
const validTabs = tabs.map(t => t.key);
if (route.query.tab && validTabs.includes(String(route.query.tab))) {
  activeTab.value = String(route.query.tab);
}

// 筛选
const selectedTag = ref('');
const showSearch = ref(false);

// 标签数据
const allTags = ref<{ tag_id: string; count: number }[]>([]);

// 删除确认
const showDeleteConfirm = ref(false);
const deletingId = ref('');

// 所有书摘（带书名）
const allBookmarks = computed(() => {
  const bookmarks = bookmarkStore.allBookmarks;


  // 验证书摘数据，过滤掉无效的书摘
  const validBookmarks = bookmarks.filter(b => {
    const isValid = b.id !== null && b.id !== undefined && b.id !== '';
    if (!isValid) {

    }
    return isValid;
  });

  return validBookmarks.map((b: any) => {
    // 优先使用书摘中存储的书籍信息，其次从书籍列表中查找
    let bookTitle = b.bookTitle;
    const bookId = b.bookId;
    const book = bookStore.allBooks.find(book => book.id === bookId);
    
    if (!bookTitle && book) {
      bookTitle = book.title;
    } else if (!bookTitle) {
      bookTitle = '未知书籍';
    }
    
    // 确保标签是数组
    const tags = Array.isArray(b.tags) ? b.tags : [];

    // 优先使用后端返回的 coverUrl，其次使用书籍列表中的封面
    const coverUrl = b.coverUrl || book?.coverUrl || book?.localCoverData;

    return {
      ...b,
      bookId: bookId,
      bookTitle: bookTitle,
      tags: tags,
      coverUrl: coverUrl,
      localCoverData: coverUrl,
    };
  });
});

// 书摘总数
const totalBookmarkCount = computed(() => {
  return allBookmarks.value.length;
});

// 筛选后的书摘
const filteredBookmarks = computed(() => {
  if (!selectedTag.value) return allBookmarks.value;
  return allBookmarks.value.filter(b => b.tags.includes(selectedTag.value));
});

// 格式化日期
const formatDate = (dateStr: string): string => {
  if (!dateStr) {
    return '未知日期';
  }
  
  const date = new Date(dateStr);
  
  // 检查日期是否有效
  if (isNaN(date.getTime())) {

    return '未知日期';
  }
  
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const formatDateTime = (dateStr: string | undefined): string => {
  if (!dateStr) {
    return '';
  }
  
  const date = new Date(dateStr);
  
  // 检查日期是否有效
  if (isNaN(date.getTime())) {
    return '';
  }
  
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

// 导航
const goToAddBookmark = () => {
  router.push('/bookmark/edit');
};

const goToOcrScanner = () => {
  router.push('/bookmark/ocr');
};

const goToBookmarkDetail = (id: string | number) => {
  router.push(`/bookmark/detail/${id}`);
};

const handleEdit = (id: string | number) => {

  if (id === null || id === undefined || id === '') {
    console.error('编辑失败：无效的书摘ID', id);
    return;
  }
  router.push(`/bookmark/edit/${id}`);
};

// 删除
const handleDelete = (id: string | number) => {

  if (id === null || id === undefined || id === '') {
    console.error('删除失败：无效的书摘ID', id);
    return;
  }
  deletingId.value = String(id);
  showDeleteConfirm.value = true;
};

const confirmDelete = async () => {
  try {
    if (!deletingId.value) {
      console.error('删除失败：无效的书摘ID');
      return;
    }
    await bookmarkService.deleteBookmark(deletingId.value);
    bookmarkStore.deleteBookmark(deletingId.value);
    showDeleteConfirm.value = false;
  } catch (error) {
    console.error('删除失败:', error);
  }
};

// 加载数据
onMounted(async () => {
  try {
    const bookmarks = await bookmarkService.getAllBookmarks();
    bookmarkStore.setBookmarks(bookmarks);

    // 加载书摘标签（从书摘标签 API）
    try {
      allTags.value = await tagApi.getAll();

    } catch (error) {
      console.warn('⚠️ 加载书摘标签失败:', (error as any).message);
    }

    // 尝试加载书籍列表（可选，用于显示更完整的书籍信息）
    try {
      const books = await bookService.getAllBooks();
      if (books && books.length > 0) {
        bookStore.setBooks(books);
        console.log('加载的书籍数量:', books.length);
        console.log('书籍示例:', books.slice(0, 2).map(b => ({
          id: b.id,
          title: b.title,
          coverUrl: b.coverUrl ? '有封面' : '无封面',
          localCoverData: b.localCoverData ? '有本地封面' : '无本地封面'
        })));
      }
    } catch (error) {
      console.warn('⚠️ 加载书籍列表失败，书摘将使用存储的书籍信息:', (error as any).message);
      // 不中断流程，继续执行
    }

    // 处理路由参数
    if (route.query.bookId) {
      // 筛选特定书籍的书摘
    }
  } catch (error) {
    console.error('加载数据失败:', error);
  }
});
</script>

<style scoped>
.bookmark-container {
  min-height: 100vh;
  background-color: var(--bg-primary);
}

.toolbar {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background-color: var(--bg-secondary);
  gap: 12px;
}

.search-bar {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background-color: #f5f5f5;
  border-radius: 20px;
  cursor: pointer;
}

.search-icon {
  width: 18px;
  height: 18px;
  fill: var(--text-hint);
  margin-right: 8px;
}

.search-bar span {
  color: var(--text-hint);
  font-size: 14px;
}

.action-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background-color: #f5f5f5;
  color: #555555;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  position: relative;
  flex-shrink: 0;
}

.action-btn svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  transition: all 0.2s ease;
  display: block;
  flex-shrink: 0;
}

.action-btn:hover {
  background-color: #e0e0e0;
  color: #333333;
  transform: scale(1.05);
}

.action-btn:active {
  transform: scale(0.95);
  background-color: #d0d0d0;
  color: #333333;
}

.action-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(102, 102, 102, 0.3);
}

.add-btn {
  background-color: var(--primary-color, #FF6B35);
  color: #ffffff;
  box-shadow: 0 2px 6px rgba(255, 107, 53, 0.15);
}

.ocr-btn {
  background-color: #f5f5f5;
  color: #555555;
}

.ocr-btn:hover {
  background-color: #e0e0e0;
  color: #333333;
  transform: scale(1.05);
}

.add-btn svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  transition: all 0.2s ease;
}

.add-btn:hover {
  background-color: #e65a2f;
  color: #ffffff;
  box-shadow: 0 4px 12px rgba(255, 107, 53, 0.25);
  transform: translateY(-1px);
}

.add-btn:active {
  background-color: #cc5629;
  color: #ffffff;
  box-shadow: 0 1px 4px rgba(255, 107, 53, 0.2);
  transform: translateY(0);
}

.add-btn:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(255, 107, 53, 0.4);
}

.tabs {
  display: flex;
  background-color: var(--bg-secondary);
  border-bottom: 1px solid var(--border-light);
  padding: 0 16px;
}

.tab-item {
  padding: 12px 24px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease, border-bottom-color 0.15s ease;
}

.tab-item.active {
  color: var(--primary-color);
  border-bottom-color: var(--primary-color);
  font-weight: 500;
}

.content {
  padding: 16px;
}

/* 筛选条件 */
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.chip {
  padding: 6px 14px;
  background-color: #f5f5f5;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.3s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.chip.active {
  background-color: rgba(255, 107, 53, 0.1);
  color: var(--primary-color);
}

.tag-count {
  background-color: rgba(0, 0, 0, 0.15);
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 11px;
  min-width: 18px;
  text-align: center;
}

.chip.active .tag-count {
  background-color: rgba(255, 107, 53, 0.2);
}

/* 书摘列表 */
.bookmarks-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 桌面端：书摘列表改多列网格 */
@media (min-width: 1024px) {
  .bookmarks-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 12px;
    align-items: start;
  }
}

.bookmark-card {
  background-color: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 16px;
  cursor: pointer;
  transition: all 0.3s;
  position: relative;
  /* 最大高度以屏幕为准，内容过长时在卡片内滚动 */
  max-height: calc(100dvh - 170px);
  display: flex;
  flex-direction: column;
}

.bookmark-card:hover {
  box-shadow: var(--shadow-md);
}

.bookmark-book {
  font-size: 14px;
  font-weight: 500;
  color: var(--primary-color);
  margin-bottom: 8px;
  flex-shrink: 0;
}

.bookmark-content {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0 0 8px 0;
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.bookmark-note {
  font-size: 14px;
  color: var(--text-secondary);
  background-color: #fffde7;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  margin: 0 0 12px 0;
  font-style: italic;
  /* 想法过长时同样限制在卡片内滚动 */
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.bookmark-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-hint);
  flex-shrink: 0;
}

.page-num {
  background-color: #f5f5f5;
  padding: 2px 8px;
  border-radius: 4px;
}

.bookmark-tags {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.mini-tag {
  padding: 2px 6px;
  background-color: rgba(255, 107, 53, 0.1);
  color: var(--primary-color);
  border-radius: 4px;
  font-size: 11px;
}

.bookmark-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.3s;
}

.bookmark-card:hover .bookmark-actions {
  opacity: 1;
}

.action-btn-sm {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.9);
  color: #555555;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  flex-shrink: 0;
}

.action-btn-sm svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
  transition: all 0.2s ease;
  display: block;
  flex-shrink: 0;
}

.action-btn-sm:hover {
  background-color: #fff;
  color: #333333;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  transform: scale(1.05);
}

.action-btn-sm:active {
  transform: scale(0.95);
  background-color: #f0f0f0;
}

.action-btn-sm:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(102, 102, 102, 0.3);
}

/* 回顾页面 */
.review-tab {
  padding: 16px;
  max-width: 1200px;
  margin: 0 auto;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 24px;
  color: var(--text-hint);
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-state p {
  margin-bottom: 16px;
}

.btn-primary {
  padding: 10px 24px;
  background-color: var(--primary-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  cursor: pointer;
}

/* 弹窗 */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.dialog {
  background-color: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 300px;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-light);
  font-size: 16px;
  font-weight: 500;
}

.dialog-close {
  font-size: 24px;
  color: var(--text-hint);
  cursor: pointer;
}

.dialog-body {
  padding: 24px 16px;
}

.dialog-body p {
  margin: 0;
  color: var(--text-secondary);
}

.dialog-footer {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-top: 1px solid var(--border-light);
}

.btn {
  flex: 1;
  padding: 10px 16px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  cursor: pointer;
}

.btn-default {
  background-color: #f5f5f5;
  color: var(--text-secondary);
}

.btn-danger {
  background-color: #f44336;
  color: #fff;
}

/* 浮动添加按钮（与书评页一致） */
.fab {
  position: fixed;
  bottom: 80px;
  right: 24px;
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background-color: var(--primary-color, #ff6b35);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px rgba(255, 107, 53, 0.4);
  z-index: 100;
  transition: all 0.2s;
}

/* 桌面端：无底部导航栏，FAB 回到底部 */
@media (min-width: 1024px) {
  .fab {
    bottom: 24px;
  }
}
.fab:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(255, 107, 53, 0.5);
}
.fab svg {
  width: 26px;
  height: 26px;
  fill: currentColor;
}
</style>