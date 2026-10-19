/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// tesseract.js 浏览器版 dist 产物（仅有默认导出，无类型声明文件）
declare module 'tesseract.js/dist/tesseract.esm.min.js' {
  import type * as Tesseract from 'tesseract.js';
  const mod: typeof Tesseract;
  export default mod;
}