/**
 * OCR 文字识别服务的类型定义
 */

/**
 * 支持的 OCR 识别语言
 */
export interface OcrLanguageOption {
  /** Tesseract 语言代码 */
  code: string;
  /** 语言显示名称 */
  label: string;
}

/**
 * 内置可选语言列表（按需下载语言包）
 */
export const OCR_LANGUAGE_OPTIONS: OcrLanguageOption[] = [
  { code: 'chi_sim', label: '简体中文' },
  { code: 'chi_tra', label: '繁体中文' },
  { code: 'eng', label: '英文' },
  { code: 'jpn', label: '日文' },
  { code: 'kor', label: '韩文' },
  { code: 'fra', label: '法文' },
  { code: 'deu', label: '德文' },
  { code: 'rus', label: '俄文' }
];

/**
 * 默认识别语言组合
 */
export const DEFAULT_OCR_LANGUAGES = ['chi_sim', 'eng'];

/**
 * OCR 识别进度
 */
export interface OcrProgress {
  /** 当前阶段状态描述 */
  status: string;
  /** 进度百分比 (0-100) */
  progress: number;
}

/**
 * 单张图片的识别结果
 */
export interface OcrRecognizeResult {
  /** 识别出的纯文本 */
  text: string;
  /** 整体置信度 (0-100) */
  confidence: number;
  /** 识别耗时（毫秒） */
  processingTime?: number;
  /** 来源图片名（便于批量区分） */
  sourceName?: string;
  /** 错误信息（如果有） */
  error?: string;
}

/**
 * 图片识别选项
 */
export interface OcrRecognizeOptions {
  /** 识别语言组合，默认 DEFAULT_OCR_LANGUAGES */
  languages?: string[];
  /** 是否启用图像预处理（长边尺寸限制） */
  enablePreprocessing?: boolean;
  /** 预处理时图片长边最大像素，默认 1600 */
  maxImageSize?: number;
  /** 进度回调 */
  onProgress?: (progress: OcrProgress) => void;
  /** 来源图片名 */
  sourceName?: string;
}

/**
 * OCR 文字识别服务接口
 */
export interface OcrScannerService {
  /**
   * 从图片文件识别文字
   * @param file 图片文件
   * @param options 识别选项
   * @returns 识别结果
   */
  recognizeFromFile(file: File, options?: OcrRecognizeOptions): Promise<OcrRecognizeResult>;

  /**
   * 从 Base64 图片识别文字
   * @param base64 Base64 图片数据
   * @param options 识别选项
   * @returns 识别结果
   */
  recognizeFromBase64(base64: string, options?: OcrRecognizeOptions): Promise<OcrRecognizeResult>;

  /**
   * 从 Canvas 识别文字
   * @param canvas Canvas 对象
   * @param options 识别选项
   * @returns 识别结果
   */
  recognizeFromCanvas(canvas: HTMLCanvasElement, options?: OcrRecognizeOptions): Promise<OcrRecognizeResult>;

  /**
   * 批量识别图片文件（串行执行）
   * @param files 图片文件列表
   * @param options 识别选项
   * @returns 识别结果列表（与输入顺序一致）
   */
  recognizeBatch(files: File[], options?: OcrRecognizeOptions): Promise<OcrRecognizeResult[]>;

  /**
   * 预热 OCR 引擎（提前加载核心与语言包，选图后可立即识别）
   * @param languages 语言代码列表，默认 DEFAULT_OCR_LANGUAGES
   */
  preload(languages?: string[]): Promise<void>;

  /**
   * 当前环境是否支持摄像头（HTTPS 安全上下文）
   */
  isCameraSupported(): boolean;

  /**
   * 释放 OCR Worker 资源
   */
  terminate(): Promise<void>;
}
