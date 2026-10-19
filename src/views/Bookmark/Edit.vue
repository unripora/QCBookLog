<template>
  <div class="edit-container">
    <!-- 顶部导航栏 -->
    <div class="header">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
      </button>
      <h1 class="title">{{ isEdit ? '编辑书摘' : '添加书摘' }}</h1>
      <button class="save-btn" @click="handleSave" :disabled="saving">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>

    <!-- 表单内容 -->
    <div class="form-content">
      <!-- 关联书籍 -->
      <div class="form-section">
        <h3 class="section-title">关联书籍</h3>
        <div class="form-item">
          <div class="book-selector" @click="showBookSelector = true">
            <div v-if="selectedBook" class="selected-book">
              <div class="book-cover-sm">
                <img v-if="getBookCoverUrl(selectedBook)" :src="getBookCoverUrl(selectedBook)" @load="handleImgLoad" @error="handleImgError" />
                <span v-else>{{ selectedBook.title.charAt(0) }}</span>
              </div>
              <div class="book-info">
                <span class="book-title">{{ selectedBook.title }}</span>
                <span class="book-author">{{ selectedBook.author }}</span>
              </div>
            </div>
            <div v-else class="placeholder">
              <svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
              <span>选择关联书籍</span>
            </div>
            <svg class="arrow" viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </div>
        </div>
      </div>

      <!-- 书摘内容 -->
      <div class="form-section">
        <h3 class="section-title">书摘内容</h3>
        <div class="form-item">
          <textarea 
            v-model="form.content" 
            class="form-textarea content-input" 
            placeholder="输入书摘内容..."
            rows="6"
          ></textarea>
        </div>
        <div class="form-item">
          <label class="form-label">页码</label>
          <input v-model.number="form.pageNum" type="number" class="form-input" placeholder="书摘所在页码" />
        </div>
      </div>

      <!-- 个人笔记 -->
      <div class="form-section">
        <h3 class="section-title">个人笔记</h3>
        <div class="form-item">
          <textarea 
            v-model="form.note" 
            class="form-textarea" 
            placeholder="添加你的想法和感想..."
            rows="4"
          ></textarea>
        </div>
      </div>

      <!-- 标签 -->
      <div class="form-section">
        <h3 class="section-title">标签</h3>
        <div class="form-item">
          <div class="tags-container">
            <span 
              v-for="tag in allTags" 
              :key="tag"
              :class="['tag-item', { active: form.tags.includes(tag) }]"
              @click="toggleTag(tag)"
            >
              {{ tag }}
              <span v-if="form.tags.includes(tag)" class="tag-remove" @click.stop="removeTag(tag)">×</span>
            </span>
            <span v-if="allTags.length === 0" class="no-tags">暂无标签</span>
          </div>
          <div class="add-tag-container">
            <input 
              v-if="showAddTag"
              v-model="newTagInput"
              class="tag-input"
              placeholder="输入标签名称"
              @keyup.enter="addNewTag"
              @blur="showAddTag = false"
            />
            <button 
              v-else
              class="add-tag-btn"
              @click="showAddTag = true"
            >
              <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              添加标签
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 书籍选择弹窗 -->
    <div v-if="showBookSelector" class="dialog-overlay" @click="showBookSelector = false">
      <div class="dialog book-selector-dialog" @click.stop>
        <div class="dialog-header">
          <span>选择书籍</span>
          <span class="dialog-close" @click="showBookSelector = false">×</span>
        </div>
        <div class="dialog-body">
          <input 
            v-model="bookSearchQuery" 
            class="search-input"
            placeholder="搜索书籍..."
          />
          <div class="book-list">
            <div 
              v-for="book in filteredBooks" 
              :key="book.id"
              class="book-option"
              @click="selectBook(book)"
            >
              <div class="book-cover-sm">
                <img v-if="getBookCoverUrl(book)" :src="getBookCoverUrl(book)" @load="handleImgLoad" @error="handleImgError" />
                <span v-else>{{ book.title.charAt(0) }}</span>
              </div>
              <div class="book-info">
                <span class="book-title">{{ book.title }}</span>
                <span class="book-author">{{ book.author }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useBookStore } from '@/stores/book';
import { useBookmarkStore } from '@/stores/bookmark';
import { bookService } from '@/api/book';
import { bookmarkService } from '@/api/bookmark';
import { tagApi } from '@/api/apiClient';
import type { Book } from '@/api/book/types';
import type { Bookmark } from '@/api/bookmark/types';
import { useBookImage } from '@/views/Book/composables/useBookImage';

const router = useRouter();
const route = useRoute();
const bookStore = useBookStore();
const bookmarkStore = useBookmarkStore();
const { handleImgLoad, handleImgError, getBookCoverUrl } = useBookImage();

const isEdit = computed(() => !!route.params.id);
const saving = ref(false);
const showBookSelector = ref(false);
const bookSearchQuery = ref('');
const selectedBook = ref<Book | null>(null);
const allTags = ref<string[]>([]); // 改为字符串数组，存储标签名称

// 表单数据
const form = reactive({
  id: '',
  bookId: 0,
  content: '',
  note: '',
  pageNum: null as number | null,
  tags: [] as string[], // 标签名称数组
  importSource: 'manual'
});

// 添加新标签的输入框
const newTagInput = ref('');
const showAddTag = ref(false);

// 筛选后的书籍列表
const filteredBooks = computed(() => {
  if (!bookSearchQuery.value) return bookStore.allBooks;
  const query = bookSearchQuery.value.toLowerCase();
  return bookStore.allBooks.filter(b => 
    (b.title && b.title.toLowerCase().includes(query)) || 
    (b.author && b.author.toLowerCase().includes(query))
  );
});

// 返回
const goBack = () => {
  router.back();
};

// 选择书籍
const selectBook = (book: Book) => {

  selectedBook.value = book;
  form.bookId = book.id;
  showBookSelector.value = false;

};

// 切换标签
const toggleTag = (tagName: string) => {
  const index = form.tags.indexOf(tagName);
  if (index === -1) {
    form.tags.push(tagName);
  } else {
    form.tags.splice(index, 1);
  }
};

// 添加新标签
const addNewTag = () => {
  const tagName = newTagInput.value.trim();
  if (tagName && !form.tags.includes(tagName)) {
    form.tags.push(tagName);
    if (!allTags.value.includes(tagName)) {
      allTags.value.push(tagName);
    }
    newTagInput.value = '';
  }
};

// 删除标签（从所有标签中移除）
const removeTag = async (tagName: string) => {
  // 从当前书摘的标签中移除
  const formIndex = form.tags.indexOf(tagName);
  if (formIndex !== -1) {
    form.tags.splice(formIndex, 1);
  }
  
  // 询问用户是否要从所有书摘中删除该标签
  if (confirm(`确定要从所有书摘中删除标签"${tagName}"吗？`)) {
    try {
      await tagApi.delete(tagName);
      // 从所有标签列表中移除
      const index = allTags.value.indexOf(tagName);
      if (index !== -1) {
        allTags.value.splice(index, 1);
      }
    } catch (error) {
      console.error('删除标签失败:', error);
      alert('删除标签失败，请重试');
    }
  }
};

// 保存
const handleSave = async () => {




  if (!form.bookId || form.bookId === 0) {
    console.error('验证失败：未选择书籍，form.bookId =', form.bookId);
    alert('请选择关联书籍');
    return;
  }
  if (!form.content.trim()) {
    console.error('验证失败：书摘内容为空');
    alert('请输入书摘内容');
    return;
  }



  saving.value = true;
  try {
    console.log('📝 准备保存书摘，表单数据:', {
      bookId: form.bookId,
      content: form.content?.substring(0, 50),
      pageNum: form.pageNum,
      pageNumType: typeof form.pageNum,
      tags: form.tags
    });
    
    // 确保页码是数字类型
    const pageNumValue = form.pageNum !== null && form.pageNum !== undefined ? Number(form.pageNum) : undefined;
    console.log('📄 处理后的页码值:', pageNumValue, '类型:', typeof pageNumValue);
    
    // 使用 camelCase 字段名，与后端保持一致
    const bookmarkData: any = {
      bookId: form.bookId,
      bookTitle: selectedBook.value?.title,
      bookAuthor: selectedBook.value?.author,
      content: form.content,
      note: form.note,
      page: pageNumValue,
      pageNum: pageNumValue,
      tags: form.tags,
      importSource: form.importSource
    };
    
    console.log('📤 发送到后端的数据:', {
      page: bookmarkData.page,
      pageNum: bookmarkData.pageNum
    });

    // 同时也发送 snake_case 字段，确保后端能正确识别
    bookmarkData.book_id = form.bookId;
    bookmarkData.book_title = selectedBook.value?.title;
    bookmarkData.book_author = selectedBook.value?.author;






    if (isEdit.value) {


      if (!form.id || form.id === '') {
        console.error('保存失败：无效的书摘ID');
        alert('保存失败：无效的书摘ID');
        saving.value = false;
        return;
      }
      const updatedBookmark = await bookmarkService.updateBookmark({ ...bookmarkData, id: form.id } as Bookmark);
      bookmarkStore.updateBookmark(updatedBookmark);
    } else {
      const newBookmark = await bookmarkService.addBookmark(bookmarkData);
      bookmarkStore.addBookmark(newBookmark);
    }
    router.back();
  } catch (error) {
    console.error('保存失败:', error);
    alert('保存失败，请重试');
  } finally {
    saving.value = false;
  }
};

// 加载数据
onMounted(async () => {
  try {


    // 加载书摘标签（从书摘标签 API）
    try {
      // tagApi.getAll() 返回 [{tag_id, count}]，编辑页只关心标签名
      const tagsResp = await tagApi.getAll();
      if (Array.isArray(tagsResp)) {
        allTags.value = tagsResp
          .map((t: any) => {
            if (typeof t === 'string') return t;
            if (t && typeof t === 'object') {
              return t.tag_id ?? t.name ?? t.tagName ?? String(t);
            }
            return String(t);
          })
          .filter((v: any) => typeof v === 'string' && v.length > 0);
      } else {
        allTags.value = [];
      }

    } catch (error) {

    }

    // 尝试加载书籍列表（可选）
    try {
      const books = await bookService.getAllBooks();
      if (books && books.length > 0) {
        bookStore.setBooks(books);
      }
    } catch (error) {
      console.warn('⚠️ 加载书籍列表失败，书摘将使用存储的书籍信息:', (error as any).message);
      // 不中断流程，继续执行
    }

    // 编辑模式
    if (isEdit.value) {
      const bookmarkId = String(route.params.id);

      // 检查 bookmarkId 是否有效
      if (!bookmarkId || bookmarkId === 'undefined' || bookmarkId === 'null') {
        console.error('无效的书摘ID:', bookmarkId);
        alert('无效的书摘ID');
        router.back();
        return;
      }

      const bookmark = await bookmarkService.getBookmarkById(bookmarkId);

      if (bookmark) {
        // 确保bookId是数字类型
        const numericBookId = typeof bookmark.bookId === 'string' ? parseInt(bookmark.bookId, 10) : bookmark.bookId;

        // 复制书摘数据到表单
        form.id = String(bookmark.id);
        form.bookId = numericBookId;
        form.content = bookmark.content || '';
        form.note = bookmark.note || '';
        form.pageNum = bookmark.pageNum ?? null;
        form.tags = bookmark.tags || [];
        form.importSource = bookmark.importSource || 'manual';

        // 使用书摘中存储的书籍信息回显
        if (bookmark.bookTitle || bookmark.bookAuthor) {
          // 直接设置 selectedBook 的属性，避免响应式对象问题
          const tempBook: Book = {
            id: numericBookId,
            isbn: '',
            title: bookmark.bookTitle || '未知书籍',
            author: bookmark.bookAuthor || '未知作者',
            book_type: 0,
            readStatus: '未读',
            tags: [],
            groups: [],
            createTime: '',
            updateTime: ''
          };
          selectedBook.value = tempBook;


          // 尝试从书籍列表中获取完整的书籍信息（包括封面）
          const fullBook = bookStore.allBooks.find(b => b.id === numericBookId);
          if (fullBook && fullBook.coverUrl) {
            selectedBook.value.coverUrl = fullBook.coverUrl;

          }
        } else {
          // 如果书摘中没有存储书籍信息，尝试从书籍列表中查找
          const book = bookStore.allBooks.find(b => b.id === numericBookId);
          if (book) {
            selectedBook.value = book;

          } else {

            selectedBook.value = null;
          }
        }
      } else {
        console.error('未找到书摘:', bookmarkId);
        alert('未找到该书摘');
        router.back();
      }
    }

    // 从路由参数获取预选书籍
    if (route.query.bookId) {
      const queryBookId = Number(route.query.bookId);
      const book = bookStore.allBooks.find(b => b.id === queryBookId);
      if (book) {
        selectedBook.value = book;
        form.bookId = book.id;
      }
    }

    // 来自 OCR 识别的合并草稿：回填内容并标记来源
    if (route.query.ocr === '1') {
      const draft = sessionStorage.getItem('ocrDraftContent');
      if (draft) {
        form.content = draft;
        form.importSource = 'ocr';
        sessionStorage.removeItem('ocrDraftContent');
      }
    }
  } catch (error) {
    console.error('加载数据失败:', error);
  }
});
</script>

<style scoped>
.edit-container {
  min-height: 100vh;
  background-color: var(--bg-primary);
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

.save-btn {
  padding: 8px 16px;
  background-color: var(--primary-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  cursor: pointer;
}

.save-btn:disabled {
  background-color: var(--text-disabled);
}

.form-content {
  padding: 16px;
}

.form-section {
  background-color: var(--bg-card);
  border-radius: var(--radius-lg);
  padding: 16px;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 16px 0;
}

.form-item {
  margin-bottom: 16px;
}

.form-item:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  outline: none;
  background-color: #fff;
}

.form-input:focus,
.form-textarea:focus {
  border-color: var(--primary-color);
}

.content-input {
  font-size: 16px;
  line-height: 1.6;
}

.form-textarea {
  resize: vertical;
  min-height: 100px;
}

/* 书籍选择器 */
.book-selector {
  display: flex;
  align-items: center;
  padding: 12px;
  background-color: #f9f9f9;
  border-radius: var(--radius-md);
  cursor: pointer;
}

.placeholder {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-hint);
  flex: 1;
}

.placeholder svg {
  width: 24px;
  height: 24px;
  fill: var(--text-hint);
}

.selected-book {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.book-cover-sm {
  width: 40px;
  height: 53px;
  border-radius: 4px;
  overflow: hidden;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 16px;
}

.book-cover-sm img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.book-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.book-title {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.book-author {
  font-size: 12px;
  color: var(--text-hint);
}

.arrow {
  width: 20px;
  height: 20px;
  fill: var(--text-hint);
}

/* 标签 */
.tags-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.tag-item {
  padding: 6px 12px;
  background-color: #f5f5f5;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.3s;
  position: relative;
  padding-right: 24px;
}

.tag-item.active {
  background-color: rgba(255, 107, 53, 0.1);
  color: var(--primary-color);
}

.tag-remove {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  line-height: 14px;
  text-align: center;
  border-radius: 50%;
  background-color: rgba(255, 107, 53, 0.2);
  color: var(--primary-color);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.tag-remove:hover {
  background-color: rgba(255, 107, 53, 0.4);
}

.add-tag-container {
  margin-top: 12px;
}

.tag-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  outline: none;
}

.tag-input:focus {
  border-color: var(--primary-color);
}

.add-tag-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background-color: #f5f5f5;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.3s;
}

.add-tag-btn:hover {
  background-color: rgba(255, 107, 53, 0.1);
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.add-tag-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.no-tags {
  color: var(--text-hint);
  font-size: 14px;
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
  align-items: flex-end;
  z-index: 2000;
}

.dialog {
  background-color: var(--bg-card);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  width: 100%;
  max-height: 70vh;
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
  padding: 16px;
  max-height: 60vh;
  overflow-y: auto;
}

.search-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: 14px;
  margin-bottom: 16px;
  outline: none;
}

.book-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.book-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background-color 0.3s;
}

.book-option:hover {
  background-color: #f5f5f5;
}
</style>