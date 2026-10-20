/**
 * Calibre格式管理服务
 * 负责将书籍数据同步到Calibre格式的文件系统中
 * 优化版本：添加内存缓存、并发处理和性能监控
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import NodeCache from 'node-cache';
import { DATA_DIR, readJsonFile } from './dataService.js';
import { PROJECT_ROOT } from '../../utils/paths.js';

// 延迟导入数据库服务，避免启动错误
let databaseService = null;
try {
  databaseService = await import('./database-service.js');
} catch (error) {
  console.warn('⚠️ 数据库服务导入失败，将使用文件系统模式');
}

/**
 * 动态获取Calibre书库目录
 * 优先使用配置的Calibre书库路径，否则使用默认路径
 */
const getBookDir = () => {
  try {
    if (databaseService && databaseService.default && databaseService.default.getDbPath) {
      const dbPath = databaseService.default.getDbPath();
      console.log('📂 当前数据库路径:', dbPath);

      // 从数据库路径提取书库目录（去掉 metadata.db）
      let bookDir = path.dirname(dbPath);
      
      // 转换为绝对路径
      if (!path.isAbsolute(bookDir)) {
        // 使用 path.join 而不是 path.resolve，避免 .. 导致的路径错误
        bookDir = path.join(PROJECT_ROOT, bookDir);
      }
      
      console.log('📂 解析到的书库目录:', bookDir);

      return bookDir;
    }
  } catch (error) {
    console.warn('⚠️ 无法获取配置的Calibre路径，使用默认路径:', error.message);
  }

  // 降级到默认路径
  const defaultPath = path.join(DATA_DIR, 'book');
  console.log('📂 使用默认书库目录:', defaultPath);
  return defaultPath;
};

// 配置（动态获取）
let BOOK_DIR = getBookDir();

// 启动时记录书库目录
console.log('📚 Calibre 书库目录初始化:', BOOK_DIR);
console.log('📚 配置状态:', {
  fromDatabase: true,
  path: BOOK_DIR
});

/**
 * 更新书库目录（当数据库路径改变时调用）
 */
const updateBookDir = () => {
  const newDir = getBookDir();
  if (newDir !== BOOK_DIR) {
    console.log('🔄 书库目录已更新:', BOOK_DIR, '->', newDir);
    BOOK_DIR = newDir;
  }
};

// 缓存配置
// 书籍列表缓存：TTL 30秒（缩短缓存时间，确保新添加的书籍能快速显示）
const BOOKS_LIST_CACHE = new NodeCache({ stdTTL: 30 });
// 单本书籍缓存：TTL 5分钟
const BOOK_CACHE = new NodeCache({ stdTTL: 5 * 60 });
// 封面存在性缓存：TTL 15分钟
const COVER_CACHE = new NodeCache({ stdTTL: 15 * 60 });

// 缓存键前缀
const CACHE_PREFIX = 'calibre:';

// 性能监控
const perfMetrics = {
  getAllBooks: { count: 0, totalTime: 0, cacheHits: 0 },
  getBookById: { count: 0, totalTime: 0, cacheHits: 0 },
  parseBook: { count: 0, totalTime: 0 }
};



/**
 * 生成Calibre目录的元数据汇总文件
 */
const generateCalibreMetadataSummary = async (books) => {
  try {
    const summaryPath = path.join(BOOK_DIR, 'calibre_metadata.json');
    
    const summary = {
      version: '1.0',
      created_at: new Date().toISOString(),
      total_books: books.length,
      success_count: books.length,
      fail_count: 0,
      books: books.map(book => ({
        id: book.id,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        path: path.join(book.author || '未知作者', book.title || '未知书名')
      }))
    };
    
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`✅ Calibre元数据汇总文件生成成功：${summaryPath}`);
    return summaryPath;
  } catch (err) {
    console.error(`❌ 生成Calibre元数据汇总文件失败:`, err.message);
    throw err;
  }
};

/**
 * 保存书籍到Calibre格式（直接写入，不依赖JSON文件）
 */
const saveBookToCalibre = async (book) => {
  console.log(`\n📚 开始保存书籍到Calibre格式：${book.title}`);

  try {
    // 确保使用最新的书库目录
    updateBookDir();

    // 使用数据库中的path字段构建书籍路径（确保只有两级目录）
    let bookPath = book.path;
    if (!bookPath) {
      const cleanAuthor = (book.author || '未知作者').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
      const cleanTitle = (book.title || '未知书名').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
      bookPath = `${cleanAuthor}/${cleanTitle}`;
    } else {
      // 验证并确保路径只有两级目录
      const pathParts = bookPath.split(/[\/\\]/);
      if (pathParts.length > 2) {
        const cleanAuthor = pathParts.slice(0, -1).join('').replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
        const cleanTitle = pathParts[pathParts.length - 1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
        bookPath = `${cleanAuthor}/${cleanTitle}`;
      } else if (pathParts.length === 2) {
        const cleanAuthor = pathParts[0].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
        const cleanTitle = pathParts[1].replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
        bookPath = `${cleanAuthor}/${cleanTitle}`;
      } else {
        bookPath = bookPath.replace(/[\/\\]/g, '').replace(/\s+/g, ' ').trim();
      }
    }
    const fullBookPath = path.join(BOOK_DIR, bookPath);

    await fs.mkdir(fullBookPath, { recursive: true });
    console.log(`✅ 创建书籍目录成功：${fullBookPath}`);

    // 2. 检查是否有封面（封面已经在上传时直接保存到Calibre路径了）
    const hasCover = book.hasCover || false;

    // 3. 检查封面文件是否存在（封面已直接保存在Calibre路径）
    const coverPath = path.join(fullBookPath, 'cover.jpg');
    let coverExists = false;
    try {
      await fs.access(coverPath);
      coverExists = true;
      console.log(`✅ 封面文件已存在：${coverPath}`);
    } catch (coverErr) {
      console.log(`ℹ️ 封面文件不存在：${coverPath}`);
    }

      // 不再生成OPF和calibre.json文件，直接使用数据库数据
    console.log(`ℹ️ 不再生成OPF和calibre.json文件，直接使用数据库数据`);
    
    console.log(`✅ 书籍保存到Calibre格式成功：${book.title}`);
    return true;
  } catch (err) {
    console.error(`❌ 书籍保存到Calibre格式失败：${book.title}`, err.message);
    return false;
  }
};

/**
 * 同步单本书籍到Calibre格式（保留旧方法用于兼容）
 */
const syncBookToCalibre = async (book) => {
  return await saveBookToCalibre(book);
};

/**
 * 检查目录是否为空（不包含任何子目录或文件）
 */
const isDirectoryEmpty = async (dirPath) => {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length === 0;
  } catch (err) {
    // 目录不存在视为空
    if (err.code === 'ENOENT') {
      return true;
    }
    throw err;
  }
};

/**
 * 从Calibre格式删除单本书籍（优化版本：自动清理空作者文件夹）
 */
const deleteBookFromCalibre = async (book) => {
  console.log(`\n🗑️ 开始从Calibre格式删除书籍：${book.title}`);

  // 确保使用最新的书库目录
  updateBookDir();

  // 优先使用 book.path（从数据库获取的实际路径）
  const bookPath = path.join(BOOK_DIR, book.path || `${book.author || '未知作者'}/${book.title || '未知书名'}`);
  const authorPath = path.dirname(bookPath);

  try {
    // 1. 删除书籍目录
    await fs.rm(bookPath, { recursive: true, force: true });
    console.log(`✅ 书籍目录删除成功：${bookPath}`);

    // 2. 检查并清理空的作者文件夹
    try {
      const isEmpty = await isDirectoryEmpty(authorPath);
      if (isEmpty) {
        await fs.rm(authorPath, { recursive: true, force: true });
        console.log(`✅ 空作者文件夹已清理：${authorPath}`);
      } else {
        console.log(`ℹ️ 作者文件夹仍包含其他书籍，保留：${authorPath}`);
      }
    } catch (authorErr) {
      console.warn(`⚠️ 检查/删除作者文件夹失败（书籍已删除）:`, authorErr.message);
      // 作者文件夹删除失败不影响书籍删除的成功状态
    }

    console.log(`✅ 书籍删除操作完成`);
    return true;
  } catch (err) {
    console.error(`❌ 从Calibre格式删除书籍失败：${book.title}`, err.message);
    throw err;
  }
};

/**
 * 同步所有书籍到Calibre格式
 */
const syncAllBooksToCalibre = async (books) => {
  console.log(`\n🚀 开始同步所有书籍到Calibre格式，共 ${books.length} 本`);
  
  let successCount = 0;
  let failCount = 0;
  
  for (const book of books) {
    const success = await syncBookToCalibre(book);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  // 更新元数据汇总
  await generateCalibreMetadataSummary(books);
  
  console.log(`\n🎉 同步完成！`);
  console.log(`✅ 成功同步：${successCount} 本书`);
  console.log(`❌ 同步失败：${failCount} 本书`);
  
  return { successCount, failCount };
};

/**
 * 解析Calibre书籍目录（优化版本：从目录名提取ID或通过路径匹配）
 */
const parseCalibreBook = async (bookPath) => {
  const startTime = Date.now();
  perfMetrics.parseBook.count++;
  console.log(`📖 开始解析书籍: ${bookPath}`);

  try {
    // 确保使用最新的书库目录
    updateBookDir();

    // 从书籍路径提取作者和标题
    const relativePath = path.relative(BOOK_DIR, bookPath);
    const pathParts = relativePath.split(path.sep);
    const author = pathParts[0] || '未知作者';
    const bookDirName = pathParts[1] || '未知书名';

    // 从数据库获取书籍信息
    const dbService = databaseService && databaseService.default ? databaseService.default : databaseService;
    if (!dbService || !dbService.isCalibreAvailable || !dbService.isCalibreAvailable()) {
      console.log(`📖 数据库不可用，无法获取书籍信息: ${bookDirName}`);
      return null;
    }

    let bookFromDb = null;

    // 方法1：从目录名提取书籍ID（格式：书名 (ID)）
    const idMatch = bookDirName.match(/\((\d+)\)\s*$/);
    if (idMatch) {
      const bookId = parseInt(idMatch[1]);
      bookFromDb = dbService.getBookById(bookId);
      if (bookFromDb) {
        console.log(`📖 通过ID找到书籍: ${bookFromDb.title} (ID=${bookId})`);
      }
    }

    // 方法2：通过路径匹配数据库中的书籍
    if (!bookFromDb) {
      console.log(`📖 尝试通过路径匹配书籍: ${relativePath}`);
      bookFromDb = dbService.getBookByPath(relativePath);
      if (bookFromDb) {
        console.log(`📖 通过路径找到书籍: ${bookFromDb.title}`);
      }
    }

    if (!bookFromDb) {
      console.log(`📖 数据库中未找到书籍: 目录=${bookDirName}, 路径=${relativePath}`);
      return null;
    }

    // 检查是否有封面（使用缓存）
    const coverPath = path.join(bookPath, 'cover.jpg');
    const cacheKey = CACHE_PREFIX + 'cover:' + bookPath;
    let hasCover = COVER_CACHE.get(cacheKey);

    if (hasCover === undefined) {
      try {
        await fs.access(coverPath);
        hasCover = true;
      } catch {
        hasCover = false;
      }
      COVER_CACHE.set(cacheKey, hasCover);
    }

    // 生成封面URL
    const coverUrl = hasCover ? `/api/static/calibre/${encodeURIComponent(relativePath)}/cover.jpg` : undefined;

    // 构建书籍对象
    const book = {
      ...bookFromDb,
      coverUrl: coverUrl,
      localCoverData: coverUrl,
      hasCover: hasCover || !!bookFromDb.has_cover,
      calibrePath: bookPath
    };

    const elapsed = Date.now() - startTime;
    perfMetrics.parseBook.totalTime += elapsed;

    console.log(`📖 成功解析书籍: ${book.title}`);
    return book;
  } catch (err) {
    console.error(`❌ 解析Calibre书籍失败: ${bookPath}`, err.message);
    return null;
  }
};



/**
 * 获取所有Calibre书籍（从数据库读取）
 * @param {boolean} useCache - 是否使用缓存
 * @param {number} readerId - 读者ID（用于加载阅读状态，默认为0）
 */
const getAllBooksFromCalibre = async (useCache = true, readerId = 0) => {
  const startTime = Date.now();
  perfMetrics.getAllBooks.count++;

  try {
    // 确保使用最新的书库目录
    updateBookDir();

    // 检查缓存（缓存key包含readerId，不同读者的缓存分开）
    const cacheKey = `${CACHE_PREFIX}books:all:reader:${readerId}`;
    if (useCache) {
      const cachedBooks = BOOKS_LIST_CACHE.get(cacheKey);
      if (cachedBooks) {
        perfMetrics.getAllBooks.cacheHits++;
        const elapsed = Date.now() - startTime;
        perfMetrics.getAllBooks.totalTime += elapsed;
        console.log(`📦 从缓存获取书籍列表（读者ID: ${readerId}），耗时: ${elapsed}ms`);
        return cachedBooks;
      }
    }

    let books = [];

    // 从SQLite数据库读取
    const dbService = databaseService && databaseService.default ? databaseService.default : databaseService;
    
    if (!dbService || !dbService.isCalibreAvailable || !dbService.isCalibreAvailable()) {
      throw new Error('Calibre数据库不可用');
    }

    console.log(`🔄 开始从数据库获取书籍...`);
    books = await dbService.getAllBooksFromCalibre(readerId);
    console.log(`✅ 从数据库获取书籍: ${books.length}本`);
    
    // 为数据库返回的书籍生成正确的封面URL（使用数据库中的has_cover字段，避免文件系统检查）
    books = books.map((book) => {
      // 如果已经有coverUrl字段，直接使用
      if (book.coverUrl) {
        return book;
      }
      
      // 使用数据库中的has_cover字段
      const hasCover = !!book.has_cover;
      const coverUrl = hasCover ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined;
      
      return {
        ...book,
        hasCover,
        coverUrl,
        localCoverData: coverUrl
      };
    });
    console.log(`✅ 已为数据库书籍生成封面URL`);

    // 从talebook数据库的reading_state表读取阅读状态
    try {
      const dbService = databaseService && databaseService.default ? databaseService.default : databaseService;
      // 用「表真实可用」判定：空库时直接跳过合并，避免 407 次无谓查询与逐条告警日志
      if (dbService && dbService.isTalebookUsable && dbService.isTalebookUsable()) {
        console.log(`📖 开始从talebook数据库读取阅读状态（读者ID: ${readerId}）...`);

        books = books.map(book => {
          try {
            const readingState = dbService.getReadingState(book.id, readerId);

            // 将read_state数字转换为中文状态
            const statusMap = {
              0: '未读',
              1: '在读',
              2: '已读'
            };

            return {
              ...book,
              readStatus: statusMap[readingState.read_state] || '未读',
              readCompleteDate: readingState.read_date || undefined,
              favorite: readingState.favorite || 0,
              wants: readingState.wants || 0,
              favorite_date: readingState.favorite_date || null,
              wants_date: readingState.wants_date || null
            };
          } catch (error) {
            console.warn(`⚠️ 读取书籍 ${book.id} 的阅读状态失败:`, error.message);
            return book;
          }
        });

        console.log(`✅ 阅读状态已从talebook数据库合并到书籍列表`);
      } else {
        console.warn('⚠️ talebook数据库不可用，跳过阅读状态合并');
      }
    } catch (error) {
      console.warn('⚠️ 读取阅读状态失败:', error.message);
    }

    // 存入缓存
    BOOKS_LIST_CACHE.set(cacheKey, books);

    const elapsed = Date.now() - startTime;
    perfMetrics.getAllBooks.totalTime += elapsed;
    console.log(`📚 获取所有书籍完成，共${books.length}本，耗时: ${elapsed}ms`);

    return books;
  } catch (err) {
    console.error(`❌ 获取所有书籍失败:`, err.message);
    return [];
  }
};

/**
 * 处理单个作者目录下的所有书籍（并发处理）
 */
const processAuthorDirectory = async (authorDir) => {
  try {
    // 确保使用最新的书库目录
    updateBookDir();

    const authorPath = path.join(BOOK_DIR, authorDir.name);
    console.log(`📁 正在处理作者目录: ${authorPath}`);

    let bookDirs;
    try {
      bookDirs = await fs.readdir(authorPath, { withFileTypes: true });
      console.log(`📁 作者目录 ${authorDir.name} 包含 ${bookDirs.length} 个目录项`);
    } catch (readErr) {
      console.error(`❌ 读取作者目录失败: ${authorPath}`, readErr.message);
      return [];
    }

    const books = [];

    // 并发处理书籍
    const bookPromises = [];
    for (const bookDir of bookDirs) {
      console.log(`📁 作者目录 ${authorDir.name} 下的目录项: ${bookDir.name}, 类型: ${bookDir.isDirectory() ? '目录' : '文件'}`);
      if (bookDir.isDirectory()) {
        const bookPath = path.join(authorPath, bookDir.name);
        console.log(`📁 作者目录 ${authorDir.name} 下的书籍目录: ${bookPath}`);
        bookPromises.push(parseCalibreBook(bookPath));
      }
    }

    console.log(`📁 作者目录 ${authorDir.name} 下有 ${bookPromises.length} 本书籍需要解析`);
    const bookResults = await Promise.all(bookPromises);
    console.log(`📁 作者目录 ${authorDir.name} 下的书籍解析结果: ${bookResults.length} 个结果`);

    let validBooksCount = 0;
    bookResults.forEach(book => {
      if (book) {
        validBooksCount++;
        books.push(book);
        console.log(`📁 作者目录 ${authorDir.name} 下的有效书籍: ${book.title}`);
      } else {
        console.log(`📁 作者目录 ${authorDir.name} 下的无效书籍`);
      }
    });
    console.log(`📁 作者目录 ${authorDir.name} 下有 ${validBooksCount} 本有效书籍`);

    return books;
  } catch (err) {
    console.error(`❌ 处理作者目录失败: ${authorDir.name}`, err.message);
    return [];
  }
};

/**
   * 根据ID获取Calibre书籍（优化版本：优先使用数据库，带缓存）
   */
  const getBookFromCalibreById = async (bookId, readerIdOrUseCache = true, useCacheParam = true) => {
    // 兼容两种调用方式：
    // 1. getBookFromCalibreById(bookId, readerId, useCache) - 新方式
    // 2. getBookFromCalibreById(bookId, useCache) - 旧方式（向后兼容）
    let readerId, useCache;
    if (typeof readerIdOrUseCache === 'number') {
      readerId = readerIdOrUseCache;
      useCache = useCacheParam;
    } else {
      readerId = 0;
      useCache = readerIdOrUseCache;
    }
    
    console.log(`📖 getBookFromCalibreById - 书籍ID: ${bookId}, 读者ID: ${readerId}, 使用缓存: ${useCache}`);
    
    const startTime = Date.now();
    perfMetrics.getBookById.count++;

    try {
      // 确保使用最新的书库目录
      updateBookDir();

      // 检查单本书缓存
      if (useCache) {
        const cacheKey = CACHE_PREFIX + 'book:id:' + bookId;
        const cachedBook = BOOK_CACHE.get(cacheKey);
        if (cachedBook) {
          perfMetrics.getBookById.cacheHits++;
          const elapsed = Date.now() - startTime;
          perfMetrics.getBookById.totalTime += elapsed;
          return cachedBook;
        }
      }

      let book = null;

      // 方案1：优先从数据库读取
      try {
        const dbService = databaseService && databaseService.default ? databaseService.default : null;
        
        if (dbService && dbService.isCalibreAvailable && dbService.isCalibreAvailable()) {
          // 直接调用数据库服务的getBookById方法
          book = dbService.getBookById(bookId);
          
          console.log(`📖 [getBookFromCalibreById] 数据库返回的书籍: id=${book?.id}, has_cover=${book?.has_cover}, coverUrl=${book?.coverUrl}, path=${book?.path}`);
          
          // 为数据库返回的书籍生成正确的封面URL（使用数据库has_cover字段）
          if (book) {
            // 优先使用 enrichBook 中已生成的 coverUrl
            const hasCover = !!book.has_cover;
            const coverUrl = book.coverUrl || (hasCover ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined);
            console.log(`📖 [getBookFromCalibreById] 计算封面URL: book.coverUrl=${book.coverUrl}, hasCover=${hasCover}, 最终coverUrl=${coverUrl}`);
            
            // 从 QCBookLog 数据库获取扩展数据
            let extendedData = {};
            if (dbService && dbService.isQcBooklogAvailable && dbService.isQcBooklogAvailable()) {
              try {
                const qcBookdata = dbService.getQcBookdataByBookId(bookId);
                if (qcBookdata) {
                  extendedData = {
                    pages: qcBookdata.page_count !== undefined && qcBookdata.page_count !== null ? qcBookdata.page_count : book.pages,
                    standardPrice: qcBookdata.standard_price !== undefined && qcBookdata.standard_price !== null ? qcBookdata.standard_price : book.standard_price,
                    purchasePrice: qcBookdata.purchase_price !== undefined && qcBookdata.purchase_price !== null ? qcBookdata.purchase_price : book.purchase_price,
                    purchaseDate: qcBookdata.purchase_date || book.purchase_date,
                    binding1: qcBookdata.binding1 !== undefined && qcBookdata.binding1 !== null ? qcBookdata.binding1 : book.binding1,
                    binding2: qcBookdata.binding2 !== undefined && qcBookdata.binding2 !== null ? qcBookdata.binding2 : book.binding2,
                    paper1: qcBookdata.paper1 !== undefined && qcBookdata.paper1 !== null ? qcBookdata.paper1 : book.paper1,
                    edge1: qcBookdata.edge1 !== undefined && qcBookdata.edge1 !== null ? qcBookdata.edge1 : book.edge1,
                    edge2: qcBookdata.edge2 !== undefined && qcBookdata.edge2 !== null ? qcBookdata.edge2 : book.edge2,
                    note: qcBookdata.note || book.note,
                    source: qcBookdata.source || ''
                  };
                } else {
                  // 即使qcBookdata为null，也确保基础字段存在
                  extendedData = {
                    pages: book.pages,
                    standardPrice: book.standard_price,
                    purchasePrice: book.purchase_price,
                    purchaseDate: book.purchase_date,
                    binding1: book.binding1,
                    binding2: book.binding2,
                    paper1: book.paper1,
                    edge1: book.edge1,
                    edge2: book.edge2,
                    note: book.note,
                    source: ''
                  };
                }
              } catch (extError) {
                console.warn(`⚠️ 获取书籍 ${bookId} 的扩展数据失败:`, extError.message);
                // 发生错误时，仍然使用基础数据
                extendedData = {
                  pages: book.pages,
                  standardPrice: book.standard_price,
                  purchasePrice: book.purchase_price,
                  purchaseDate: book.purchase_date,
                  binding1: book.binding1,
                  binding2: book.binding2,
                  paper1: book.paper1,
                  edge1: book.edge1,
                  edge2: book.edge2,
                  note: book.note,
                  source: ''
                };
              }
            }
            
            book = {
              ...book,
              ...extendedData, // 合并扩展数据
              hasCover: hasCover || !!book.has_cover,
              coverUrl: coverUrl,
              localCoverData: coverUrl
            };
            console.log(`✅ 已为数据库书籍生成封面URL: ${coverUrl}`);

            // 从 Talebook 数据库获取阅读状态（表真实可用时才走此分支）
            if (dbService && dbService.isTalebookUsable && dbService.isTalebookUsable()) {
              try {
                const readingState = dbService.getReadingState(bookId, readerId);

                // 将 read_state 数字转换为中文状态
                const statusMap = {
                  0: '未读',
                  1: '在读',
                  2: '已读'
                };

                book.readStatus = statusMap[readingState.read_state] || '未读';
                if (readingState.read_date) {
                  book.readCompleteDate = readingState.read_date;
                }
                // 添加 favorite 和 wants 字段
                book.favorite = readingState.favorite || 0;
                book.wants = readingState.wants || 0;
                book.favorite_date = readingState.favorite_date || null;
                book.wants_date = readingState.wants_date || null;
                book.personal_rating = readingState.personal_rating || 0;
                book.personal_rating_date = readingState.personal_rating_date || null;
                console.log(`✅ 已从 Talebook 数据库获取书籍 ${bookId} 的阅读状态: ${book.readStatus}, favorite: ${book.favorite}, wants: ${book.wants}, personal_rating: ${book.personal_rating}`);
              } catch (readingError) {
                console.warn(`⚠️ 获取书籍 ${bookId} 的阅读状态失败:`, readingError.message);
                // 如果获取失败，保持原有的 readStatus
              }
            }
          }
        } else {
          throw new Error('数据库服务不可用');
        }
      } catch (dbError) {
        // 数据库读取失败，降级到文件系统读取
        console.warn('⚠️ 数据库读取失败，降级到文件系统读取:', dbError.message);
        book = null;
      }

      // 如果数据库返回null，尝试从文件系统读取
      if (!book) {
        // 方案2：从文件系统读取所有书籍，然后查找
        const books = await getAllBooksFromCalibre(false); // 强制不使用缓存，确保获取最新数据
        
        // 支持字符串ID和整数ID的比较
        const stringBookId = String(bookId);

        // 先按ID查找（支持字符串和数字比较），如果找不到且bookId包含'-'，再按UUID查找
        book = books.find(b => {
          // 将两者都转换为字符串进行比较，支持字符串和数字ID
          return (String(b.id) === stringBookId) || (stringBookId.includes('-') && b.uuid === stringBookId);
        }) || null;
      }

      if (book && useCache) {
        BOOK_CACHE.set(CACHE_PREFIX + 'book:id:' + bookId, book);
      }

      const elapsed = Date.now() - startTime;
      perfMetrics.getBookById.totalTime += elapsed;

      return book;
    } catch (err) {
      console.error(`❌ 根据ID获取书籍失败: ${bookId}`, err.message);
      return null;
    }
  };

/**
 * 根据作者和标题获取Calibre书籍
 */
const getBookFromCalibre = async (author, title) => {
  try {
    // 确保使用最新的书库目录
    updateBookDir();

    const authorDirName = author || '未知作者';
    const titleDirName = title || '未知书名';
    const bookPath = path.join(BOOK_DIR, authorDirName, titleDirName);

    return await parseCalibreBook(bookPath);
  } catch (err) {
    console.error(`❌ 获取Calibre书籍失败: ${author}/${title}`, err.message);
    return null;
  }
};

/**
 * 分页获取书籍（优化版本）
 * @param {Object} options - 分页选项
 * @param {number} options.page - 页码（从1开始）
 * @param {number} options.pageSize - 每页数量
 * @param {number} options.readerId - 读者ID
 * @param {string} options.sortBy - 排序字段
 * @param {string} options.sortOrder - 排序方向
 */
const getBooksPaginated = async (options = {}) => {
  const startTime = Date.now();
  const {
    page = 1,
    pageSize = 25,
    readerId = 0,
    sortBy = 'last_modified',
    sortOrder = 'DESC'
  } = options;

  console.log(`📄 分页获取书籍: page=${page}, pageSize=${pageSize}, readerId=${readerId}`);

  try {
    updateBookDir();

    const dbService = databaseService && databaseService.default ? databaseService.default : databaseService;
    
    if (!dbService || !dbService.isCalibreAvailable || !dbService.isCalibreAvailable()) {
      throw new Error('Calibre数据库不可用');
    }

    const result = dbService.getBooksPaginated({
      page,
      pageSize,
      readerId,
      sortBy,
      sortOrder
    });

    const books = result.list;

    const booksWithCovers = books.map((book) => {
      if (book.coverUrl) {
        return book;
      }
      
      const hasCover = !!book.has_cover;
      const coverUrl = hasCover ? `/api/static/calibre/${encodeURIComponent(book.path)}/cover.jpg` : undefined;
      
      return {
        ...book,
        hasCover,
        coverUrl,
        localCoverData: coverUrl
      };
    });

    const elapsed = Date.now() - startTime;
    console.log(`✅ 分页获取书籍完成，耗时: ${elapsed}ms`);

    return {
      ...result,
      list: booksWithCovers
    };
  } catch (err) {
    console.error(`❌ 分页获取书籍失败:`, err.message);
    return {
      list: [],
      total: 0,
      page: page,
      pageSize: pageSize,
      totalPages: 0,
      hasMore: false
    };
  }
};

/**
 * 获取书籍总数
 */
const getBooksTotalCount = () => {
  try {
    const dbService = databaseService && databaseService.default ? databaseService.default : databaseService;
    if (!dbService || !dbService.isCalibreAvailable || !dbService.isCalibreAvailable()) {
      return 0;
    }
    return dbService.getBooksTotalCount();
  } catch (error) {
    console.error('获取书籍总数失败:', error.message);
    return 0;
  }
};

// 导出服务
const calibreService = {
  syncBookToCalibre,
  saveBookToCalibre,
  deleteBookFromCalibre,
  syncAllBooksToCalibre,
  generateCalibreMetadataSummary,
  getAllBooksFromCalibre,
  getBooksPaginated,
  getBooksTotalCount,
  getBookFromCalibreById,
  getBookFromCalibre,
  // 路径管理
  updateBookDir,
  getBookDir,
  // 缓存管理方法
  clearBookCache: () => BOOK_CACHE.flushAll(),
  clearBooksListCache: () => BOOKS_LIST_CACHE.flushAll(),
  clearCoverCache: () => COVER_CACHE.flushAll(),
  clearAllCache: () => {
    // 更新书库目录
    updateBookDir();
    BOOK_CACHE.flushAll();
    BOOKS_LIST_CACHE.flushAll();
    COVER_CACHE.flushAll();
    console.log('🗑️ 已清空所有Calibre缓存');
  },
  // 性能监控方法
  getPerformanceMetrics: () => ({
    ...perfMetrics,
    getAvgTime: (metric) => {
      const m = perfMetrics[metric];
      return m.count > 0 ? (m.totalTime / m.count).toFixed(2) : 0;
    },
    getCacheHitRate: (metric) => {
      const m = perfMetrics[metric];
      return m.count > 0 ? ((m.cacheHits / m.count) * 100).toFixed(2) + '%' : '0%';
    }
  }),
  printPerformanceReport: () => {
    console.log('\n📊 Calibre服务性能报告:');
    console.log('========================================');
    console.log(`getAllBooks: 调用${perfMetrics.getAllBooks.count}次, 命中${perfMetrics.getAllBooks.cacheHits}次 (${((perfMetrics.getAllBooks.cacheHits / (perfMetrics.getAllBooks.count || 1)) * 100).toFixed(2)}%), 平均耗时${(perfMetrics.getAllBooks.totalTime / (perfMetrics.getAllBooks.count || 1)).toFixed(2)}ms`);
    console.log(`getBookById: 调用${perfMetrics.getBookById.count}次, 命中${perfMetrics.getBookById.cacheHits}次 (${((perfMetrics.getBookById.cacheHits / (perfMetrics.getBookById.count || 1)) * 100).toFixed(2)}%), 平均耗时${(perfMetrics.getBookById.totalTime / (perfMetrics.getBookById.count || 1)).toFixed(2)}ms`);
    console.log(`parseBook:   调用${perfMetrics.parseBook.count}次, 平均耗时${(perfMetrics.parseBook.totalTime / (perfMetrics.parseBook.count || 1)).toFixed(2)}ms`);
    console.log('========================================\n');
  }
};

export default calibreService;
