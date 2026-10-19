/**
 * OCR 文字识别服务实现
 * 使用 Tesseract.js 在浏览器端进行文字识别（纯本地，不上传图片）
 */

import {
  OcrProgress,
  OcrRecognizeOptions,
  OcrRecognizeResult,
  OcrScannerService,
  DEFAULT_OCR_LANGUAGES
} from './types';

/**
 * 预处理默认长边限制（像素）
 * 1600 对书页文字已足够清晰，相比 2000 显著降低解码/编码与识别耗时
 */
const DEFAULT_MAX_IMAGE_SIZE = 1600;

/**
 * OCR 资源目录（相对站点根路径，dev/prod 统一走本地，避免依赖外网 CDN）
 * - 语言包：public/tessdata/*.traineddata.gz（Dockerfile 构建时下载 / 本地脚本预置）
 * - 引擎核心：public/tesseract-core/*.wasm.js（从 node_modules/tesseract.js-core 拷贝）
 * - Worker 脚本：public/tesseract-dist/worker.min.js（浏览器版，从 tesseract.js/dist 拷贝）
 */
const LANG_PATH = '/tessdata';
const CORE_PATH = '/tesseract-core';
const WORKER_PATH = '/tesseract-dist/worker.min.js';

/**
 * Tesseract.js Worker 懒加载模块缓存
 * 注意：必须使用官方浏览器分发版 dist/tesseract.esm.min.js。
 * 1. 直接 import 'tesseract.js' 会命中其 src 入口（Node 版），
 *    Vite 不解析 package.json 的 browser 对象映射，
 *    导致浏览器端误用 worker_threads，postMessage 抛出 DataCloneError。
 * 2. 该 dist 产物仅提供「默认导出」（无具名导出 createWorker），
 *    故需从 mod.default 取用。
 */
type TesseractModule = typeof import('tesseract.js');
let tesseractModulePromise: Promise<TesseractModule> | null = null;

/**
 * 动态加载 tesseract.js 浏览器版（避免首屏加载核心包）
 */
const loadTesseract = (): Promise<TesseractModule> => {
  if (!tesseractModulePromise) {
    tesseractModulePromise = import('tesseract.js/dist/tesseract.esm.min.js').then(
      (mod) => (((mod as { default?: TesseractModule }).default ?? mod) as TesseractModule)
    );
  }
  return tesseractModulePromise;
};

/**
 * OCR 文字识别服务实现类
 * 内部维护单个 Worker 实例，识别请求串行执行
 */
class OcrScannerServiceImpl implements OcrScannerService {
  /** 当前 Worker 实例 */
  private worker: Tesseract.Worker | null = null;
  /** Worker 当前已加载的语言组合（逗号分隔，用于判断是否需要重建） */
  private loadedLanguages = '';
  /** Worker 初始化中的 Promise（避免并发重复创建） */
  private workerInitPromise: Promise<Tesseract.Worker> | null = null;
  /** 识别任务串行队列（保证同一时刻只有一个识别任务） */
  private taskQueue: Promise<unknown> = Promise.resolve();

  /**
   * 获取（或创建）指定语言组合的 Worker
   * @param languages 语言代码列表
   * @param onProgress 进度回调
   */
  private async getWorker(
    languages: string[],
    onProgress?: (progress: OcrProgress) => void
  ): Promise<Tesseract.Worker> {
    const langKey = languages.join('+');

    // 语言组合未变化且 Worker 可用，直接复用
    if (this.worker && this.loadedLanguages === langKey) {
      return this.worker;
    }

    // 已有初始化任务且语言一致，等待复用
    if (this.workerInitPromise && this.loadedLanguages === langKey) {
      return this.workerInitPromise;
    }

    // 语言变化或首次创建：先销毁旧的 Worker
    if (this.worker) {
      const oldWorker = this.worker;
      this.worker = null;
      this.loadedLanguages = '';
      try {
        await oldWorker.terminate();
      } catch (e) {
        console.warn('⚠️ 释放旧 OCR Worker 失败:', e);
      }
    }

    const targetLangKey = langKey;
    this.workerInitPromise = (async () => {
      const Tesseract = await loadTesseract();
      // 识别参数：preserve_interword_spaces 保留词间空格的原样输出，
      // 避免中文识别结果中出现多余/丢失的空格
      const created = await Tesseract.createWorker(languages, undefined, {
        // Worker 脚本（浏览器版），与 core/lang 一样走本地同源，避免 CDN
        workerPath: WORKER_PATH,
        // 引擎核心与语言包均从同源本地目录读取，避免外网 CDN（国内访问极慢）
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        // 语言包已为 gzip 压缩的 .traineddata.gz
        gzip: true,
        logger: (m: Tesseract.LoggerMessage) => {
          if (!onProgress || !m || typeof m.progress !== 'number') return;
          onProgress({
            status: this.translateStatus(m.status),
            progress: Math.round(m.progress * 100)
          });
        }
      });
      try {
        await created.setParameters({ preserve_interword_spaces: '1' });
      } catch (e) {
        console.warn('⚠️ 设置 OCR 识别参数失败（不影响识别）:', e);
      }

      this.worker = created;
      this.loadedLanguages = targetLangKey;
      return created;
    })();

    try {
      return await this.workerInitPromise;
    } finally {
      this.workerInitPromise = null;
    }
  }

  /**
   * 将 Tesseract 状态文案转为中文提示
   */
  private translateStatus(status: string): string {
    const map: Record<string, string> = {
      'loading tesseract core': '加载 OCR 核心...',
      'initializing tesseract': '初始化 OCR 引擎...',
      'loading language traineddata': '下载语言包...',
      'initializing api': '初始化识别接口...',
      'recognizing text': '识别文字中...'
    };
    return map[status] || status || '处理中...';
  }

  /**
   * 将任务加入串行队列执行
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.taskQueue.then(task, task);
    // 队列本身吞掉异常，避免中断后续任务
    this.taskQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * 将解码后的位图按长边限制绘制到 Canvas
   * 说明：createImageBitmap 直接在浏览器内核解码，省去 base64 往返与二次解码；
   * 缩放由 drawImage 在合成线程完成，不产生主线程像素级 JS 循环（避免界面卡顿）
   */
  private bitmapToCanvas(bitmap: ImageBitmap, maxSize: number): HTMLCanvasElement {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new Error('无法获取 Canvas 上下文');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  }

  /**
   * 从图片源解码为位图（一次解码，后续不再往返 base64）
   */
  private async decodeToBitmap(source: File | Blob): Promise<ImageBitmap> {
    try {
      return await createImageBitmap(source);
    } catch (e) {
      throw new Error('图片解码失败，请确认图片格式受支持');
    }
  }

  /**
   * 将 Canvas 转为可结构化克隆的二进制数据
   * 说明：tesseract.js 内部依赖 `image instanceof HTMLElement` 判断是否为 Canvas，
   * 在 Vite/ESM 打包环境下该判定可能失效，导致 HTMLCanvasElement 被直接 postMessage
   * 给 Worker 时抛出 DataCloneError。此处主动转成 Uint8Array 规避。
   * 采用 JPEG（q=0.92）而非 PNG：书页场景下画质相当，但编码与传输体积大幅缩小
   */
  private canvasToUint8Array(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) {
          reject(new Error('Canvas 导出图片失败'));
          return;
        }
        try {
          const buffer = await blob.arrayBuffer();
          resolve(new Uint8Array(buffer));
        } catch (e) {
          reject(e);
        }
      }, 'image/jpeg', 0.92);
    });
  }

  /**
   * 从 Canvas 识别文字（核心执行逻辑，串行队列内运行）
   */
  async recognizeFromCanvas(
    canvas: HTMLCanvasElement,
    options: OcrRecognizeOptions = {}
  ): Promise<OcrRecognizeResult> {
    const startTime = Date.now();
    // 展开为纯数组：调用方可能传入 Vue 响应式 Proxy 数组，
    // tesseract.js 内部会 postMessage 该数组，Proxy 无法被结构化克隆（DataCloneError），
    // 且其内部 Promise 链会吞掉该错误，导致 createWorker 永久挂起（界面卡在"初始化 OCR 引擎..."）
    const languages = options.languages && options.languages.length > 0
      ? [...options.languages]
      : [...DEFAULT_OCR_LANGUAGES];

    try {
      // 转为 Uint8Array 后再识别，避免 Canvas 无法跨线程克隆
      const imageData = await this.canvasToUint8Array(canvas);

      const worker = await this.getWorker(languages, options.onProgress);
      const { data } = await worker.recognize(imageData as unknown as Parameters<typeof worker.recognize>[0]);

      return {
        text: (data.text || '').trim(),
        confidence: Math.round(data.confidence || 0),
        processingTime: Date.now() - startTime,
        sourceName: options.sourceName
      };
    } catch (error) {
      return {
        text: '',
        confidence: 0,
        processingTime: Date.now() - startTime,
        sourceName: options.sourceName,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 从 Base64 图片识别文字（实现接口方法）
   */
  async recognizeFromBase64(
    base64: string,
    options: OcrRecognizeOptions = {}
  ): Promise<OcrRecognizeResult> {
    const maxSize = options.maxImageSize || DEFAULT_MAX_IMAGE_SIZE;
    try {
      // dataURL 直接转 Blob 后一次性解码，避免 Image + toDataURL 的二次编解码
      const blob = await (await fetch(base64)).blob();
      const bitmap = await this.decodeToBitmap(blob);
      const canvas = this.bitmapToCanvas(bitmap, maxSize);
      return await this.enqueue(() => this.recognizeFromCanvas(canvas, options));
    } catch (error) {
      return {
        text: '',
        confidence: 0,
        sourceName: options.sourceName,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 从图片文件识别文字（实现接口方法）
   */
  async recognizeFromFile(
    file: File,
    options: OcrRecognizeOptions = {}
  ): Promise<OcrRecognizeResult> {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      return {
        text: '',
        confidence: 0,
        sourceName: options.sourceName || file.name,
        error: '不支持的图片格式，仅支持 JPG、PNG、WebP、BMP'
      };
    }

    const maxSize = 20 * 1024 * 1024;
    if (file.size > maxSize) {
      return {
        text: '',
        confidence: 0,
        sourceName: options.sourceName || file.name,
        error: '图片文件过大，最大支持 20MB'
      };
    }

    try {
      // 直接解码 File 为位图（单次解码），按长边限制缩放后识别
      const scaleLimit = options.enablePreprocessing === false
        ? Number.MAX_SAFE_INTEGER
        : (options.maxImageSize || DEFAULT_MAX_IMAGE_SIZE);
      const bitmap = await this.decodeToBitmap(file);
      const canvas = this.bitmapToCanvas(bitmap, scaleLimit);
      return await this.enqueue(() => this.recognizeFromCanvas(canvas, {
        ...options,
        sourceName: options.sourceName || file.name
      }));
    } catch (error) {
      return {
        text: '',
        confidence: 0,
        sourceName: options.sourceName || file.name,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 批量识别图片文件（串行，逐张回调进度）
   */
  async recognizeBatch(
    files: File[],
    options: OcrRecognizeOptions = {}
  ): Promise<OcrRecognizeResult[]> {
    const results: OcrRecognizeResult[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const result = await this.recognizeFromFile(file, {
        ...options,
        sourceName: file.name,
        onProgress: options.onProgress
          ? (p) => {
              // 将单张进度映射为整体进度
              const overall = Math.round(((i + p.progress / 100) / files.length) * 100);
              options.onProgress?.({ status: `第 ${i + 1}/${files.length} 张：${p.status}`, progress: overall });
            }
          : undefined
      });
      results.push(result);
    }
    return results;
  }

  /**
   * 预热 OCR 引擎：提前加载 tesseract 核心 + 语言包并完成 Worker 初始化，
   * 用户选图后即可直接识别（省去 10s+ 的首次加载等待）
   */
  async preload(languages?: string[]): Promise<void> {
    const langs = languages && languages.length > 0 ? [...languages] : [...DEFAULT_OCR_LANGUAGES];
    try {
      await this.getWorker(langs);
    } catch (e) {
      console.warn('⚠️ OCR 引擎预热失败（识别时会重试）:', e);
    }
  }

  /**
   * 当前环境是否支持摄像头（HTTPS 安全上下文，localhost 除外）
   */
  isCameraSupported(): boolean {
    return typeof window !== 'undefined'
      && window.isSecureContext
      && !!navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  /**
   * 释放 Worker 资源（页面离开时调用）
   */
  async terminate(): Promise<void> {
    if (this.workerInitPromise) {
      try {
        await this.workerInitPromise;
      } catch {
        // 忽略初始化失败
      }
    }
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch (e) {
        console.warn('⚠️ 释放 OCR Worker 失败:', e);
      }
      this.worker = null;
      this.loadedLanguages = '';
    }
  }
}

/**
 * OCR 文字识别服务单例
 */
export const ocrScannerService: OcrScannerService = new OcrScannerServiceImpl();

export * from './types';
export default ocrScannerService;
